// iPhone / iPad: detection (normal and Recovery/DFU), erase = full erase-restore of the latest
// signed iOS from Recovery mode (works on passcode-locked devices; the old data keys are
// destroyed = cryptographic erase, NIST SP 800-88 Purge), evidence and upload.
// Activation Lock (Find My) is read and recorded, never bypassed.
import fs from 'node:fs';
import path from 'node:path';
import { FIRMWARE, PRODUCT, VERSION } from './config.mjs';
import { BUSY, device, devices, log, newJob, setState } from './devices.mjs';
import { ensureFirmware, latestSigned } from './firmware.mjs';
import { appleKind, appleName } from './names.mjs';
import { newReportDir, saveReport, upload } from './reports.mjs';
import { appLog, kv, nowIso, run, scrub, spawnTool } from './util.mjs';

const ecidHex = (v) => {
  try { return BigInt(v).toString(16).toUpperCase().padStart(16, '0'); } catch { return ''; }
};
const udidToEcid = new Map();
const lastPairTry = new Map();

// ---------------------------------------------------------------- scan
export async function scanIosNormal(seen) {
  const r = await run('idevice_id', ['-l']);
  const list = [...new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean))];
  for (const udid of list) {
    const known = udidToEcid.get(udid);
    const kd = known && devices.get(`ios:${known}`);
    if (kd && ['erasing', 'downloading'].includes(kd.job.state)) { seen.add(kd.id); kd.lastSeen = Date.now(); continue; }

    const simple = kv((await run('ideviceinfo', ['-s', '-u', udid])).out);
    const ecid = ecidHex(simple.UniqueChipID);
    if (!ecid) continue;
    udidToEcid.set(udid, ecid);
    const d = device(`ios:${ecid}`, { platform: 'ios' });
    seen.add(d.id);
    d.udid = udid;
    d.ecid = ecid;
    // Keep the last known trust state while this scan re-checks it (no flicker on the screen).
    d.mode = d.trusted === false ? 'locked' : 'normal';
    d.kind = appleKind(simple.ProductType, simple.DeviceClass);
    Object.assign(d.info, {
      model: simple.ProductType || d.info.model,
      name: appleName(simple.ProductType) || d.info.name,
      os: simple.ProductVersion ? `${d.kind === 'ipad' ? 'iPadOS' : 'iOS'} ${simple.ProductVersion}` : d.info.os,
      serial: simple.SerialNumber || d.info.serial,
      activation: simple.ActivationState || d.info.activation,
    });
    d.raw.simple = simple;

    if (d.job.state === 'rebooting') { await finishIos(d, simple); continue; }
    if (BUSY.has(d.job.state)) continue;

    // Trusted? Pairing shows "Trust This Computer?" once the phone is unlocked; retry quietly.
    let paired = (await run('idevicepair', ['-u', udid, 'validate'])).code === 0;
    if (!paired && Date.now() - (lastPairTry.get(udid) || 0) > 8000) {
      lastPairTry.set(udid, Date.now());
      paired = (await run('idevicepair', ['-u', udid, 'pair'])).code === 0;
    }
    d.trusted = paired;
    if (paired && !d.raw.full) await readTrustedInfo(d);
    d.mode = paired ? 'normal' : 'locked';
  }
}

async function readTrustedInfo(d) {
  const full = (await run('ideviceinfo', ['-u', d.udid])).out;
  if (!kv(full).SerialNumber) return; // pairing not usable yet, try on the next scan
  const fmip = (await run('ideviceinfo', ['-u', d.udid, '-q', 'com.apple.fmip'])).out;
  const disk = (await run('ideviceinfo', ['-u', d.udid, '-q', 'com.apple.disk_usage'])).out;
  const f = kv(full);
  const fm = kv(fmip).IsAssociated;
  d.raw.full = full;
  d.raw.fmip = fmip;
  d.raw.disk = disk;
  const cap = Number(kv(disk).TotalDiskCapacity) || 0;
  Object.assign(d.info, {
    serial: f.SerialNumber, imei: f.InternationalMobileEquipmentIdentity, imei2: f.InternationalMobileEquipmentIdentity2,
    color: f.DeviceColor, capacity: cap ? `${Math.round(cap / 1e9)} GB` : d.info.capacity,
    findMy: fm === 'true' ? 'on' : fm === 'false' ? 'off' : 'unknown',
  });
}

/** Devices in Recovery/DFU, from the bundled lister: one line per device, KEY=value pairs. */
export async function scanIosRecovery(seen) {
  const r = await run('triplere-recovery-list', [], 10000);
  for (const line of r.out.split('\n')) {
    const f = Object.fromEntries([...line.matchAll(/([A-Z]+)=(\S*)/g)].map((m) => [m[1], m[2]]));
    const ecid = ecidHex(f.ECID);
    if (!ecid) continue;
    const d = device(`ios:${ecid}`, { platform: 'ios' });
    seen.add(d.id);
    d.ecid = ecid;
    d.mode = f.MODE === 'dfu' ? 'dfu' : 'recovery';
    if (f.PRODUCT) {
      d.info.model = d.info.model || f.PRODUCT;
      d.info.name = d.info.name || appleName(f.PRODUCT);
      d.kind = d.kind || appleKind(f.PRODUCT);
    }
    if (f.SRNM) d.info.serial = d.info.serial || f.SRNM;
    if (f.IMEI) d.info.imei = d.info.imei || f.IMEI;
    d.raw.recovery = line.trim();
    if (d.job.state === 'waiting-recovery') d.job.recoverySeen = true;
  }
}

// ---------------------------------------------------------------- erase
export async function eraseIos(d, opts = {}) {
  const job = newJob(d);
  job.findMyAck = Boolean(opts.ackLocks);
  job.dir = newReportDir('ios', d.ecid);
  const restoreLog = fs.createWriteStream(path.join(job.dir, 'restore.log'));
  try {
    // 1. Firmware (while the device can still be in normal mode).
    const pt = d.info.model;
    if (!pt) {
      setState(d, 'waiting-recovery', 'مش عارف موديل الجهاز. دخّله وضع Recovery بالزراير وأنا هكمّل لوحدي.');
      if (!await waitFor(() => d.info.model, 15 * 60000)) throw new Error('الجهاز مادخلش Recovery خلال 15 دقيقة.');
    }
    setState(d, 'downloading', 'بجيب آخر نسخة iOS من Apple...');
    let fw;
    try { fw = await latestSigned(d.info.model); } catch (e) {
      appLog('firmware list', e);
      throw new Error('مقدرتش أوصل لسيرفر Apple. اتأكد من النت وجرّب تاني.');
    }
    job.firmware = `${fw.version} (${fw.buildid})`;
    log(d, `النسخة: ${d.kind === 'ipad' ? 'iPadOS' : 'iOS'} ${fw.version}`);
    let ipsw;
    try {
      ipsw = await ensureFirmware(fw, (p) => { job.progress = p * 0.35; job.step = `تحميل iOS ${Math.round(p * 100)}%`; });
    } catch (e) {
      appLog('firmware download', e);
      if (String(e.message).startsWith('NOSPACE')) throw new Error(`المساحة على الكمبيوتر مش كفاية. محتاج حوالي ${e.message.split(':')[1]} جيجا فاضية على C.`);
      throw new Error('تحميل iOS فشل. اتأكد من النت وجرّب تاني.');
    }
    job.progress = 0.35;

    // 2. Recovery mode: by command when the device is in normal mode (also works when locked).
    if (d.mode === 'normal' || d.mode === 'locked') {
      setState(d, 'preparing', 'بدخّل الجهاز وضع Recovery...');
      job.step = 'دخول Recovery';
      const er = await run('ideviceenterrecovery', [d.udid], 30000);
      const ok = er.code === 0 && await waitFor(() => d.mode === 'recovery' || d.mode === 'dfu', 90000);
      if (!ok) {
        setState(d, 'waiting-recovery', 'الجهاز مادخلش Recovery لوحده. دخّله بالزراير (الخطوات على الكارت) وأنا هكمّل لوحدي.');
        if (!await waitFor(() => d.mode === 'recovery' || d.mode === 'dfu', 15 * 60000)) throw new Error('الجهاز مادخلش Recovery خلال 15 دقيقة.');
      }
    } else if (d.mode !== 'recovery' && d.mode !== 'dfu') {
      setState(d, 'waiting-recovery', 'دخّل الجهاز وضع Recovery بالزراير وأنا هكمّل لوحدي.');
      if (!await waitFor(() => d.mode === 'recovery' || d.mode === 'dfu', 15 * 60000)) throw new Error('الجهاز مادخلش Recovery خلال 15 دقيقة.');
    }

    // 3. Erase-restore.
    setState(d, 'erasing', 'بيتمسح دلوقتي (تثبيت iOS جديد مع مسح كامل). متشيلش الكابل.');
    job.step = 'بدء المسح';
    const code = await restore(d, ipsw, restoreLog);
    job.restoreExit = code;
    if (code !== 0) {
      throw new Error('المسح وقف قبل ما يخلص. سيب الجهاز متوصل ودوس "جرّب تاني" (لو فضل على شاشة الكابل هيكمّل منها).');
    }
    job.progress = 0.97;
    job.step = 'إعادة تشغيل';
    setState(d, 'rebooting', 'المسح خلص. مستني الجهاز يفتح على شاشة Hello عشان أتأكد وأعمل التقرير...');
    d.mode = 'restoring';
    // The normal-mode scan finishes the job when it sees the device again; give up waiting after 20 min.
    setTimeout(() => { if (d.job === job && job.state === 'rebooting') finishIos(d, {}); }, 20 * 60000);
  } catch (e) {
    setState(d, 'failed', e.message);
  } finally {
    restoreLog.end();
  }
}

function waitFor(cond, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });
}

const STEPS = { 0: 'تجهيز', 1: 'تجهيز', 2: 'نقل النظام', 3: 'التحقق', 4: 'تحديث الفيرموير', 5: 'تحديث الشبكة', 6: 'تحديث المكونات', 7: 'المرحلة الأخيرة' };
const STEP_BASE = { 0: 0.36, 1: 0.38, 2: 0.42, 3: 0.75, 4: 0.82, 5: 0.88, 6: 0.92, 7: 0.95 };
const STEP_SPAN = { 0: 0.02, 1: 0.04, 2: 0.33, 3: 0.07, 4: 0.06, 5: 0.04, 6: 0.03, 7: 0.02 };

function restore(d, ipsw, logStream) {
  return new Promise((resolve) => {
    const args = ['-e', '-y', '-P', '-i', `0x${d.ecid}`, '-C', path.join(FIRMWARE, 'cache'), ipsw];
    fs.mkdirSync(path.join(FIRMWARE, 'cache'), { recursive: true });
    const p = spawnTool('idevicerestore', args, { cwd: FIRMWARE });
    d.proc = p;
    let buf = '';
    const onData = (b) => {
      logStream.write(b);
      buf += String(b).replace(/\r/g, '\n');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/progress:\s*(\d+)\s+([\d.]+)/);
        if (m) {
          const step = Number(m[1]), frac = Math.min(1, Number(m[2]));
          const base = STEP_BASE[step] ?? 0.4, span = STEP_SPAN[step] ?? 0.05;
          d.job.progress = Math.max(d.job.progress || 0, base + span * frac);
          d.job.step = `${STEPS[step] || 'مسح'} ${Math.round(frac * 100)}%`;
        }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { appLog('restore spawn', e); resolve(-1); });
    p.on('close', (code) => { d.proc = null; resolve(code ?? -1); });
  });
}

// ---------------------------------------------------------------- finish
export async function finishIos(d, simple) {
  const job = d.job;
  if (job.state !== 'rebooting') return;
  setState(d, 'uploading', 'بعمل التقرير...');
  job.progress = 1;
  const activation = simple.ActivationState || 'unknown';
  const serialAfter = simple.SerialNumber || '';
  if (serialAfter && d.info.serial && serialAfter !== d.info.serial) appLog('serial changed after restore?', d.info.serial, serialAfter);
  const tail = (() => {
    try { return fs.readFileSync(path.join(job.dir, 'restore.log'), 'utf8').replace(/\r/g, '\n').split('\n').filter((l) => !/^progress:/.test(l)).slice(-60).join('\n'); } catch { return ''; }
  })();
  const before = d.raw.full
    ? `### before\n${d.raw.full.trim()}\n### fmip-before\n${(d.raw.fmip || '').trim()}\n### disk-before\n${(d.raw.disk || '').trim()}`
    : `### before\n${[
      `SerialNumber: ${d.info.serial || ''}`, `ProductType: ${d.info.model || ''}`, `UniqueChipID: ${parseInt(d.ecid, 16) || ''}`,
      d.info.imei ? `InternationalMobileEquipmentIdentity: ${d.info.imei}` : '',
      `DeviceClass: ${d.kind === 'ipad' ? 'iPad' : 'iPhone'}`,
    ].filter(Boolean).join('\n')}\n### identity-source\nDevice was passcode-locked or not trusted: identity read in Recovery mode.\n${d.raw.recovery || ''}`;
  const completed = nowIso();
  const evidence = [
    '### TRIPLERE-MOBILE-ERASURE v1',
    'platform=ios',
    `tool=${PRODUCT} ${VERSION}`,
    'method=Erase-restore of the latest signed iOS/iPadOS from Recovery mode (cryptographic erase, NIST SP 800-88 Purge)',
    `udid=${d.udid || ''}`,
    `ecid=${d.ecid}`,
    `serial=${d.info.serial || 'unknown'}`,
    `model=${d.info.model || 'unknown'}`,
    `imei=${d.info.imei || 'unknown'}`,
    `firmware_installed=${job.firmware || ''}`,
    `started_utc=${job.startedAt}`,
    `completed_utc=${completed}`,
    'reset_confirmed=yes',
    `restore_exit=${job.restoreExit}`,
    `activation_after=${activation}`,
    `find_my_before=${d.info.findMy || 'unknown (device was locked)'}`,
    job.findMyAck ? 'find_my_ack=yes (technician confirmed erasing with Find My on / unknown)' : '',
    'activation_lock_note=Erasing does not remove Activation Lock; the owner, ABM or MDM must release it before resale.',
    before,
    `### after\n${Object.entries(simple).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
    `### restore-log-tail\n${scrub(tail)}`,
  ].filter((l) => l !== '').join('\n');
  saveReport(job.dir, evidence, {
    platform: 'ios', kind: d.kind, model: d.info.model, name: d.info.name, serial: d.info.serial, imei: d.info.imei,
    method_label: `مسح كامل + تثبيت ${d.kind === 'ipad' ? 'iPadOS' : 'iOS'} ${job.firmware || ''}`.trim(),
    findMy: d.info.findMy, activation_after: activation,
    started_utc: job.startedAt, completed_utc: completed, filename: `ios_erasure_${d.ecid}.txt`,
  });
  log(d, 'التقرير اتعمل. برفعه على الـ ERP...');
  const r = await upload(job.dir);
  job.upload = r;
  job.certificates = r.certificates || [];
  setState(d, 'done', r.message);
  job.finishedAt = nowIso();
}

export function stopIos(d) {
  try { d.proc?.kill(); } catch { /* ignore */ }
}

export async function appleReady() {
  const r = await run('idevice_id', ['-l'], 8000);
  return r.code === 0;
}

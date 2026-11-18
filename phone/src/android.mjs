// Samsung / Android: detection (USB debugging, bootloader mode), erase and evidence.
//  - USB debugging allowed: installs the small Triple Re wiper app, makes it device admin and calls
//    the official factory reset (DevicePolicyManager.wipeData). On encrypted storage this destroys
//    the keys = cryptographic erase (NIST SP 800-88 Purge).
//  - Unlocked bootloader: wipes userdata/metadata from the bootloader.
//  - Otherwise: the technician does "Wipe data / factory reset" in Recovery and confirms.
// Google / Samsung account locks (FRP) are recorded, never bypassed.
import os from 'node:os';
import { PRODUCT, VERSION, WIPER_APK } from './config.mjs';
import { BUSY, device, log, newJob, setState } from './devices.mjs';
import { newReportDir, saveReport, upload } from './reports.mjs';
import { nowIso, run, safe, scrub, sleep } from './util.mjs';

const WIPER_PKG = 'net.triplere.wiper';
const WIPER_ADMIN = `${WIPER_PKG}/.AdminReceiver`;
const WIPER_ACTIVITY = `${WIPER_PKG}/.WipeActivity`;
const PROPS = ['ro.serialno', 'ro.product.manufacturer', 'ro.product.brand', 'ro.product.model', 'ro.product.device',
  'ro.product.marketname', 'ro.product.vendor.marketname', 'ro.build.version.release', 'ro.build.fingerprint',
  'ro.crypto.state', 'ro.crypto.type', 'ro.boot.verifiedbootstate', 'ro.boot.flash.locked', 'ro.frp.pst'];

function parseGetprop(text) {
  const o = {};
  for (const m of String(text).matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)) o[m[1]] = m[2];
  return o;
}

export async function scanAdb(seen) {
  const lines = (await run('adb', ['devices', '-l'])).out.split('\n').slice(1);
  for (const line of lines) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || !state || serial === '*') continue;
    const d = device(`android:${serial}`, { platform: 'android', kind: 'android' });
    seen.add(d.id);
    d.adbSerial = serial;
    d.mode = { device: 'debug', unauthorized: 'unauthorized', offline: 'unauthorized', sideload: 'recovery', recovery: 'recovery' }[state] || state;
    d.info.serial = d.info.serial || serial;
    const model = (line.match(/model:(\S+)/) || [])[1];
    if (model) d.info.model = d.info.model || model.replace(/_/g, ' ');
    if (state === 'device' && !d.raw.props && !BUSY.has(d.job.state)) await readAdbInfo(d);
  }
}

async function readAdbInfo(d) {
  const s = d.adbSerial;
  const all = parseGetprop((await run('adb', ['-s', s, 'shell', 'getprop'])).out);
  if (!all['ro.serialno'] && !all['ro.product.model']) return;
  d.raw.props = PROPS.filter((k) => all[k] !== undefined).map((k) => `${k}: ${all[k]}`).join('\n');
  const acc = (await run('adb', ['-s', s, 'shell', 'dumpsys', 'account'])).out;
  const types = [...acc.matchAll(/Account \{name=[^,]*, type=([^}]+)\}/g)].map((m) => m[1].trim());
  const google = new Set(), samsung = new Set();
  for (const m of acc.matchAll(/Account \{name=([^,]*), type=([^}]+)\}/g)) {
    if (m[2].trim() === 'com.google') google.add(m[1]);
    if (m[2].trim() === 'com.osp.app.signin') samsung.add(m[1]);
  }
  const manufacturer = all['ro.product.manufacturer'] || '';
  const model = all['ro.product.model'] || d.info.model;
  const market = all['ro.product.marketname'] || all['ro.product.vendor.marketname'] || '';
  const cryptoState = all['ro.crypto.state'] || '';
  Object.assign(d.info, {
    serial: all['ro.serialno'] || d.info.serial, manufacturer, model,
    name: market || [manufacturer && manufacturer[0].toUpperCase() + manufacturer.slice(1), model].filter(Boolean).join(' '),
    os: all['ro.build.version.release'] ? `Android ${all['ro.build.version.release']}` : d.info.os,
    encryption: cryptoState === 'encrypted' ? `encrypted${all['ro.crypto.type'] ? ` (${all['ro.crypto.type']})` : ''}` : (cryptoState || 'unknown'),
    accounts: { google: google.size, samsung: samsung.size, total: types.length },
  });
  d.info.imei = d.info.imei || await readImei(d.adbSerial);
}

// Best effort: readable from the shell on many phones, not on all.
async function readImei(serial) {
  for (const code of ['1', '4']) {
    const r = await run('adb', ['-s', serial, 'shell', 'service', 'call', 'iphonesubinfo', code, 's16', 'com.android.shell']);
    const digits = [...r.out.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('').replace(/[^0-9]/g, '');
    if (/^\d{14,16}$/.test(digits)) return digits;
  }
  return undefined;
}

export async function scanFastboot(seen) {
  const lines = (await run('fastboot', ['devices'])).out.split('\n');
  for (const line of lines) {
    const serial = line.trim().split(/\s+/)[0];
    if (!serial) continue;
    const d = device(`android:${serial}`, { platform: 'android', kind: 'android' });
    seen.add(d.id);
    d.mode = 'bootloader';
    d.fbSerial = serial;
    d.info.serial = d.info.serial || serial;
    if (!d.raw.fastboot) {
      const r = await run('fastboot', ['-s', serial, 'getvar', 'all'], 20000);
      d.raw.fastboot = r.err + r.out;
      const v = {};
      for (const m of d.raw.fastboot.matchAll(/\(bootloader\)\s*([\w.-]+):\s*(.*)/g)) if (!(m[1] in v)) v[m[1]] = m[2].trim();
      d.info.model = d.info.model || v.product;
      d.info.name = d.info.name || v.product;
      d.info.bootloaderUnlocked = v.unlocked || 'unknown';
    }
  }
}

/** Adds a phone that the computer cannot read (locked, no USB debugging) by its serial. */
export function addManual({ serial, model, imei, manufacturer }) {
  const d = device(`android:${serial}`, { platform: 'android', kind: 'android', manual: true });
  d.mode = d.mode && d.mode !== 'manual' ? d.mode : 'manual';
  d.info.serial = serial;
  d.info.model = d.info.model || model || undefined;
  d.info.name = d.info.name || [manufacturer, model].filter(Boolean).join(' ') || 'Android';
  d.info.manufacturer = d.info.manufacturer || manufacturer || undefined;
  d.info.imei = imei || d.info.imei;
  return d;
}

export async function eraseAndroid(d, opts = {}) {
  const job = newJob(d);
  job.frpAck = Boolean(opts.ackLocks);
  job.dir = newReportDir('android', d.info.serial || d.id);
  try {
    if (d.mode === 'bootloader' && d.info.bootloaderUnlocked === 'yes') {
      setState(d, 'erasing', 'بيتمسح من وضع الـ Bootloader...');
      const r = await run('fastboot', ['-s', d.fbSerial, '-w'], 300000);
      job.trace = `$ fastboot -w\n${r.out}${r.err}`;
      if (r.code !== 0) throw new Error('المسح من وضع الـ Bootloader فشل. جرّب من الـ Recovery.');
      await run('fastboot', ['-s', d.fbSerial, 'reboot']);
      return finishAndroid(d, 'Factory data wipe from the unlocked bootloader (userdata + metadata)');
    }
    if (d.mode === 'debug') {
      if (await wipeViaDeviceAdmin(d)) return;
      log(d, 'المسح الأوتوماتيك مانفعش على الموبايل ده، هنكمّل من الـ Recovery.');
      await run('adb', ['-s', d.adbSerial, 'reboot', 'recovery']);
      setState(d, 'awaiting-confirm', 'الموبايل داخل Recovery. اختار منه "Wipe data / factory reset" وأكّد، وبعد ما يخلص دوس "تم المسح".');
      return;
    }
    if (d.mode === 'bootloader') {
      setState(d, 'awaiting-confirm', 'من على الموبايل اختار "Recovery mode"، وبعدين "Wipe data / factory reset"، وبعد ما يخلص دوس "تم المسح".');
      return;
    }
    if (d.mode === 'recovery') {
      setState(d, 'awaiting-confirm', 'من على الموبايل اختار "Wipe data / factory reset"، وبعد ما يخلص دوس "تم المسح".');
      return;
    }
    setState(d, 'awaiting-confirm', 'اقفل الموبايل، ودخّله Recovery بالزراير (سامسونج: Power + Volume Up وهو متوصل بالكابل)، واختار "Wipe data / factory reset"، وبعد ما يخلص دوس "تم المسح".');
  } catch (e) {
    setState(d, 'failed', e.message);
  }
}

// One-click wipe for any brand with USB debugging allowed. Returns false to fall back to Recovery.
async function wipeViaDeviceAdmin(d) {
  const s = d.adbSerial;
  const trace = [];
  const step = async (args, t) => {
    const r = await run('adb', ['-s', s, ...args], t);
    trace.push(`$ adb ${args.join(' ')}\n${(r.out + r.err).trim()}`);
    return r;
  };
  const fail = async (msg, cleanup) => {
    log(d, msg);
    if (cleanup) await run('adb', ['-s', s, ...cleanup]);
    d.job.trace = trace.join('\n');
    return false;
  };
  setState(d, 'erasing', 'بسطّب تطبيق المسح على الموبايل...');
  d.job.progress = 0.2;
  const inst = await step(['install', '-r', WIPER_APK], 120000);
  if (!/Success/.test(inst.out + inst.err)) {
    return fail('الموبايل رفض تسطيب تطبيق المسح (في شاومي فعّل "Install via USB" من Developer options).');
  }
  log(d, 'بفعّل صلاحية المسح...');
  d.job.progress = 0.4;
  const adm = await step(['shell', 'dpm', 'set-active-admin', '--user', 'current', WIPER_ADMIN]);
  if (!/Success/i.test(adm.out + adm.err)) {
    return fail('الموبايل رفض صلاحية المسح (في شاومي فعّل "USB debugging (Security settings)").', ['uninstall', WIPER_PKG]);
  }
  await run('adb', ['-s', s, 'logcat', '-c']);
  await step(['shell', 'am', 'start', '-W', '-n', WIPER_ACTIVITY], 30000);
  let result = '';
  for (let i = 0; i < 12 && !result; i++) {
    await sleep(700);
    const lc = (await run('adb', ['-s', s, 'logcat', '-d', '-s', 'TripleReWiper'])).out;
    result = (lc.match(/TRIPLERE_WIPE_(REQUESTED|ERROR.*)/) || [])[0] || '';
  }
  trace.push(`result: ${result || '(nothing)'}`);
  if (!result.includes('REQUESTED')) {
    return fail(`الموبايل رفض أمر المسح.`, ['shell', 'dpm', 'remove-active-admin', '--user', 'current', WIPER_ADMIN]);
  }
  log(d, 'الموبايل قبل أمر المسح وبيعمل Factory reset دلوقتي. متشيلش الكابل...');
  d.job.progress = 0.6;
  // Success = the phone drops off USB debugging (reboots into the reset) within 2 minutes.
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    await sleep(2000);
    gone = !/device|recovery/.test((await run('adb', ['-s', s, 'get-state'], 5000)).out);
    if (!gone && i < 5) {
      const err = ((await run('adb', ['-s', s, 'logcat', '-d', '-s', 'TripleReWiper'])).out.match(/TRIPLERE_WIPE_ERROR.*/) || [])[0];
      if (err) {
        trace.push(`result: ${err}`);
        return fail('الموبايل رفض المسح.', ['shell', 'dpm', 'remove-active-admin', '--user', 'current', WIPER_ADMIN]);
      }
    }
  }
  d.job.trace = trace.join('\n');
  if (!gone) {
    setState(d, 'failed', 'الموبايل قبل الأمر بس معملش restart خلال دقيقتين. اتأكد منه وجرّب تاني.');
    return true;
  }
  await finishAndroid(d, 'Official factory reset (Android device policy wipe) started from the station');
  return true;
}

export async function confirmManual(d) {
  if (d.job.state !== 'awaiting-confirm') throw new Error('مفيش مسح مستني تأكيد');
  await finishAndroid(d, "Recovery 'Wipe data / factory reset' (confirmed by the technician)");
}

async function finishAndroid(d, method) {
  const job = d.job;
  setState(d, 'uploading', 'بعمل التقرير...');
  job.progress = 1;
  const completed = nowIso();
  const enc = d.info.encryption || 'unknown';
  const acc = d.info.accounts || {};
  const evidence = [
    '### TRIPLERE-MOBILE-ERASURE v1',
    'platform=android',
    `tool=${PRODUCT} ${VERSION}`,
    `method=${method} (cryptographic erase of encrypted user data, NIST SP 800-88 Purge)`,
    `serial=${d.info.serial || 'unknown'}`,
    `model=${d.info.model || 'unknown'}`,
    `manufacturer=${d.info.manufacturer || 'unknown'}`,
    `imei=${d.info.imei || 'unknown'}`,
    `encryption=${enc}`,
    `started_utc=${job.startedAt}`,
    `completed_utc=${completed}`,
    'reset_confirmed=yes',
    `operator=${os.userInfo().username}`,
    `accounts_google=${acc.google ?? 'unknown'}`,
    `accounts_samsung=${acc.samsung ?? 'unknown'}`,
    job.frpAck ? 'frp_ack=yes (technician confirmed erasing with an account signed in)' : '',
    'frp_note=Factory reset does not remove the Google/Samsung account lock (FRP); the owner or EMM must release it before resale.',
    d.raw.props ? `### before\n${d.raw.props}` : `### before\nro.serialno: ${d.info.serial || ''}\nro.product.model: ${d.info.model || ''}\n### identity-source\nPhone was locked: identity typed by the technician or read in bootloader mode.`,
    d.raw.fastboot ? `### bootloader\n${scrub(d.raw.fastboot)}` : '',
    job.trace ? `### wipe-log\n${scrub(job.trace)}` : '',
  ].filter((l) => l !== '').join('\n');
  saveReport(job.dir, evidence, {
    platform: 'android', kind: 'android', model: d.info.model, name: d.info.name, serial: d.info.serial, imei: d.info.imei,
    method_label: method.startsWith('Official') ? 'Factory reset رسمي (أوتوماتيك)' : method.startsWith('Factory data wipe') ? 'مسح من الـ Bootloader' : 'Factory reset من الـ Recovery',
    encryption: enc, started_utc: job.startedAt, completed_utc: completed, filename: `android_erasure_${safe(d.info.serial)}.txt`,
  });
  log(d, 'التقرير اتعمل. برفعه على الـ ERP...');
  const r = await upload(job.dir);
  job.upload = r;
  job.certificates = r.certificates || [];
  setState(d, 'done', r.message);
  job.finishedAt = nowIso();
}

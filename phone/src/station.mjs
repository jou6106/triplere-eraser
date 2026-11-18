// The station: scans for devices, runs erase jobs, keeps the licence fresh and uploads reports
// that are still waiting. The screens talk to it through server.mjs.
import { WIN, SCAN_MS } from './config.mjs';
import { addManual, confirmManual, eraseAndroid, scanAdb, scanFastboot } from './android.mjs';
import { BUSY, devices, log, publicDevice, setState, sweep } from './devices.mjs';
import { appleReady, eraseIos, scanIosNormal, scanIosRecovery } from './ios.mjs';
import { keyName, licenceState, renew } from './licence.mjs';
import { recoverySteps } from './names.mjs';
import { history, loadJob, pendingDirs, retryPending } from './reports.mjs';
import { appLog, toolAvailable } from './util.mjs';

export const status = {
  apple: false,          // Apple USB driver/service reachable (needed for iPhone/iPad)
  iosTools: false,
  androidTools: false,
  online: null,          // last contact with the ERP worked
  lastRenew: '',
};

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const seen = new Set();
    if (status.iosTools && status.apple) {
      await scanIosRecovery(seen).catch((e) => appLog('scan recovery', e));
      await scanIosNormal(seen).catch((e) => appLog('scan ios', e));
    }
    if (status.androidTools) {
      await scanAdb(seen).catch((e) => appLog('scan adb', e));
      await scanFastboot(seen).catch((e) => appLog('scan fastboot', e));
    }
    for (const d of devices.values()) if (d.manual) seen.add(d.id);
    sweep(seen);
  } finally {
    scanning = false;
  }
}

async function checkTools() {
  status.iosTools = toolAvailable('idevice_id') && toolAvailable('idevicerestore');
  status.androidTools = toolAvailable('adb');
  status.apple = status.iosTools ? await appleReady() : false;
}

async function renewLicence() {
  const r = await renew();
  status.lastRenew = r;
  if (r !== 'offline') status.online = true;
  appLog('licence renew', r);
  return r;
}

async function retryUploads() {
  if (!pendingDirs().length) return;
  const st = licenceState();
  if (!st.hasKey) return;
  const results = await retryPending();
  if (results.some((r) => r.ok)) status.online = true;
}

export function start() {
  checkTools().then(scan);
  setInterval(() => checkTools().catch((e) => appLog('tools', e)), 20000);
  setInterval(() => scan().catch((e) => appLog('scan', e)), SCAN_MS);
  renewLicence().catch(() => {});
  setInterval(() => renewLicence().catch(() => {}), 12 * 3600 * 1000);
  setInterval(() => retryUploads().catch((e) => appLog('retry uploads', e)), 120000);
}

// ---------------------------------------------------------------- actions from the screens
export function erase(ids, opts = {}) {
  const lic = licenceState();
  if (lic.state !== 'valid') throw Object.assign(new Error('الترخيص مش سليم. البرنامج مش هيمسح من غير ترخيص.'), { code: 403 });
  const job = loadJob();
  if (!job.client_name || !job.technician_name) throw Object.assign(new Error('اكتب اسم العميل واسم الفني الأول.'), { code: 400 });
  const list = ids.map((id) => devices.get(id)).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('اختار جهاز واحد على الأقل.'), { code: 400 });
  for (const d of list) {
    if (BUSY.has(d.job.state)) throw Object.assign(new Error(`${d.info.name || d.id}: عليه عملية شغالة بالفعل.`), { code: 409 });
    if (needsAck(d) && !opts.ackLocks) throw Object.assign(new Error('فيه جهاز عليه قفل حساب. لازم توافق على التحذير الأول.'), { code: 409 });
  }
  for (const d of list) {
    const run = d.platform === 'ios' ? eraseIos(d, opts) : eraseAndroid(d, opts);
    run.catch((e) => { appLog('erase', e); setState(d, 'failed', 'حصلت مشكلة غير متوقعة. جرّب تاني.'); });
  }
  return list.length;
}

export function needsAck(d) {
  if (d.platform === 'ios') return d.info.findMy !== 'off';
  const a = d.info.accounts;
  return !a || a.google > 0 || a.samsung > 0;
}

export async function confirm(id) {
  const d = devices.get(id);
  if (!d) throw Object.assign(new Error('الجهاز مش موجود'), { code: 404 });
  await confirmManual(d);
}

export function dismiss(id) {
  const d = devices.get(id);
  if (!d) return;
  if (BUSY.has(d.job.state)) throw Object.assign(new Error('العملية لسه شغالة'), { code: 409 });
  devices.delete(id);
}

export function manual(body) {
  const serial = String(body.serial || '').trim();
  if (!/^[A-Za-z0-9._-]{4,40}$/.test(serial)) throw Object.assign(new Error('السيريال مش مكتوب صح.'), { code: 400 });
  const clean = (v, n) => String(v || '').replace(/[^\w .()+-]/g, '').trim().slice(0, n);
  const imei = String(body.imei || '').replace(/\D/g, '').slice(0, 17);
  const d = addManual({ serial, model: clean(body.model, 60), manufacturer: clean(body.manufacturer, 30), imei });
  log(d, 'اتضاف بالسيريال (الموبايل مقفول).');
  return d.id;
}

export { renewLicence, retryUploads };

export function snapshot() {
  const lic = licenceState();
  return {
    licence: { ...lic, name: keyName() },
    status: { ...status, windows: WIN },
    job: loadJob(),
    devices: [...devices.values()].map((d) => ({
      ...publicDevice(d),
      needsAck: needsAck(d),
      recoverySteps: d.platform === 'ios' ? recoverySteps(d.info.model, d.kind) : undefined,
    })),
    pending: pendingDirs().length,
    history: history(),
  };
}

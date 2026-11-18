// Erasure reports: each erasure gets its own folder under DATA_DIR/reports with
//   evidence.txt  the evidence the ERP turns into a certificate
//   meta.json     what the screens show (device, method, job details, times)
//   uploaded.json written once the ERP accepted it (certificate numbers)
// Reports that could not be uploaded (no internet) are retried in the background.
import fs from 'node:fs';
import path from 'node:path';
import { JOB_FILE, SESSIONS } from './config.mjs';
import { readConf } from './licence.mjs';
import { appLog, nowIso, safe } from './util.mjs';

export function newReportDir(platform, id) {
  const stamp = nowIso().replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  const dir = path.join(SESSIONS, `${platform}-${safe(id)}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadJob() {
  try {
    const j = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
    return { client_name: String(j.client_name || ''), technician_name: String(j.technician_name || ''), work_order: String(j.work_order || '') };
  } catch { return { client_name: '', technician_name: '', work_order: '' }; }
}

export function saveJob(j) {
  const clean = (v, n) => String(v || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, n);
  const job = { client_name: clean(j.client_name, 120), technician_name: clean(j.technician_name, 80), work_order: clean(j.work_order, 60) };
  fs.writeFileSync(JOB_FILE, JSON.stringify(job, null, 2));
  return job;
}

/** Writes the evidence and its metadata, returns the folder. */
export function saveReport(dir, evidence, meta) {
  fs.writeFileSync(path.join(dir, 'evidence.txt'), evidence.replace(/\r/g, ''));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, job: loadJob(), saved_utc: nowIso() }, null, 2));
  return dir;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const inflight = new Map();

/** Sends one report to the ERP. Result {ok, message, certificates[]} is also kept in the folder. */
export function upload(dir) {
  if (inflight.has(dir)) return inflight.get(dir);
  const p = doUpload(dir).finally(() => inflight.delete(dir));
  inflight.set(dir, p);
  return p;
}

async function doUpload(dir) {
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  const conf = readConf();
  if (!conf.ERP_URL || !conf.UPLOAD_TOKEN) return remember(dir, { ok: false, message: 'مفيش مفتاح رفع. استورد upload.conf من الـ ERP.' });
  try {
    const form = new FormData();
    form.append('log_file', new Blob([fs.readFileSync(path.join(dir, 'evidence.txt'))], { type: 'text/plain' }), meta.filename || 'mobile_erasure.txt');
    const job = meta.job || {};
    for (const k of ['client_name', 'technician_name', 'work_order']) if (job[k]) form.append(k, job[k]);
    const res = await fetch(conf.ERP_URL, {
      method: 'POST', body: form, signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${conf.UPLOAD_TOKEN}`, Accept: 'application/json' },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if ((res.status === 200 || res.status === 201) && body && body.ok === true) {
      const certificates = (body.created || []).map((c) => ({ number: c.report_number, result: c.result }));
      const r = { ok: true, message: certificates.length ? 'اترفع على الـ ERP' : 'اترفع قبل كده على الـ ERP', certificates, at: nowIso() };
      fs.writeFileSync(path.join(dir, 'uploaded.json'), JSON.stringify(r, null, 2));
      return remember(dir, r);
    }
    if (res.status === 401) return remember(dir, { ok: false, message: 'السيرفر رفض مفتاح الرفع (المفتاح موقوف في الـ ERP).' });
    if (res.status === 422) return remember(dir, { ok: false, message: `السيرفر رفض التقرير: ${(body && body.message) || 'ملف غير صالح'}`, rejected: true });
    return remember(dir, { ok: false, message: `السيرفر مردش صح (HTTP ${res.status}). هيترفع تاني لوحده.` });
  } catch (e) {
    appLog('upload failed', dir, e.message);
    return remember(dir, { ok: false, message: 'مفيش اتصال بالسيرفر. التقرير محفوظ وهيترفع لوحده أول ما النت يرجع.' });
  }
}

function remember(dir, r) {
  if (!r.ok) {
    try { fs.writeFileSync(path.join(dir, 'upload-error.json'), JSON.stringify({ ...r, at: nowIso() }, null, 2)); } catch { /* ignore */ }
  } else {
    try { fs.rmSync(path.join(dir, 'upload-error.json'), { force: true }); } catch { /* ignore */ }
  }
  return r;
}

function reportDirs() {
  let names = [];
  try { names = fs.readdirSync(SESSIONS); } catch { return []; }
  return names.map((n) => path.join(SESSIONS, n)).filter((d) => fs.existsSync(path.join(d, 'evidence.txt')));
}

/** Reports waiting for the ERP (not uploaded and not rejected as invalid). */
export function pendingDirs() {
  return reportDirs().filter((d) => {
    if (fs.existsSync(path.join(d, 'uploaded.json'))) return false;
    const err = readJson(path.join(d, 'upload-error.json'));
    return !(err && err.rejected);
  });
}

export async function retryPending() {
  const results = [];
  for (const d of pendingDirs()) results.push(await upload(d));
  return results;
}

/** Latest erasures for the reports list. */
export function history(limit = 200) {
  return reportDirs().map((d) => {
    const meta = readJson(path.join(d, 'meta.json')) || {};
    const up = readJson(path.join(d, 'uploaded.json'));
    const err = readJson(path.join(d, 'upload-error.json'));
    return {
      id: path.basename(d),
      platform: meta.platform, kind: meta.kind, model: meta.model, name: meta.name, serial: meta.serial, imei: meta.imei,
      method: meta.method_label, completed: meta.completed_utc, client: meta.job?.client_name || '',
      uploaded: Boolean(up), certificates: up?.certificates || [], error: up ? '' : (err?.message || 'لسه ماترفعش'),
    };
  }).sort((a, b) => String(b.completed).localeCompare(String(a.completed))).slice(0, limit);
}

export function reportDir(id) {
  const d = path.join(SESSIONS, path.basename(String(id || '')));
  return fs.existsSync(path.join(d, 'evidence.txt')) ? d : null;
}

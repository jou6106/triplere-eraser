// Licence and upload key: the same upload.conf the Triple Re ERP issues for the USB eraser.
//   ERP_URL, UPLOAD_TOKEN, LICENSE_ID, LICENSE_ISSUED, LICENSE_EXPIRES, LICENSE_SIG
// The licence is signed by the ERP (ECDSA P-256 / SHA-256); only the public key ships with the
// program, so it cannot be forged or extended by editing the file. Online it is renewed; a key
// stopped in the ERP removes the licence and the station stops erasing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONF, LICENSE_PUBKEY } from './config.mjs';
import { appLog } from './util.mjs';

const VALUE = /^[^"$`\\\r\n]*$/;

/** Reads KEY="value" lines as plain data (the file is never executed). */
export function parseConf(text) {
  const o = {};
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^([A-Z_]+)="([^"$`\\]*)"\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

export function readConf() {
  try { return parseConf(fs.readFileSync(CONF, 'utf8')); } catch { return {}; }
}

const today = () => new Date().toISOString().slice(0, 10);

/** valid | missing | invalid | expired, plus details for the screen. */
export function licenceState(conf = readConf()) {
  const { LICENSE_ID: id, LICENSE_ISSUED: issued, LICENSE_EXPIRES: expires, LICENSE_SIG: sig } = conf;
  const base = { name: conf.__name || '', expires: expires || '', hasKey: Boolean(conf.ERP_URL && conf.UPLOAD_TOKEN) };
  if (!id || !sig || !expires) return { ...base, state: 'missing' };
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!/^\d+$/.test(id) || !date.test(issued || '') || !date.test(expires)) return { ...base, state: 'invalid' };
  let ok = false;
  try {
    const key = fs.readFileSync(LICENSE_PUBKEY, 'utf8');
    ok = crypto.verify('sha256', Buffer.from(`triplere-license-v1|${id}|${issued}|${expires}`), key, Buffer.from(sig, 'base64'));
  } catch (e) { appLog('licence verify error', e); }
  if (!ok) return { ...base, state: 'invalid' };
  if (today() > expires) return { ...base, state: 'expired' };
  return { ...base, state: 'valid' };
}

export function keyName() {
  try {
    const first = fs.readFileSync(CONF, 'utf8').split(/\r?\n/)[0];
    const m = first.match(/^#\s*Triple Re[^—-]*[—-]\s*(.+)$/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

/**
 * Imports an upload.conf chosen by the technician. Only known keys are kept, and only when the
 * licence in it verifies, so a wrong or edited file never replaces a working one.
 */
export function importConf(text) {
  const conf = parseConf(text);
  if (!conf.ERP_URL || !conf.UPLOAD_TOKEN) return { ok: false, error: 'الملف ده مش upload.conf من الـ ERP (مفيهوش مفتاح الرفع).' };
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9/._-]*$/.test(conf.ERP_URL) && !process.env.TRIPLERE_ALLOW_HTTP) {
    return { ok: false, error: 'عنوان السيرفر في الملف مش سليم.' };
  }
  const st = licenceState(conf);
  if (st.state === 'invalid') return { ok: false, error: 'الترخيص اللي في الملف مش سليم (التوقيع غلط).' };
  const first = String(text).replace(/\r/g, '').split('\n')[0];
  const lines = [/^#/.test(first) ? first.slice(0, 120) : '# Triple Re Mobile Eraser'];
  for (const k of ['ERP_URL', 'UPLOAD_TOKEN', 'LICENSE_ID', 'LICENSE_ISSUED', 'LICENSE_EXPIRES', 'LICENSE_SIG']) {
    if (conf[k] !== undefined && VALUE.test(conf[k])) lines.push(`${k}="${conf[k]}"`);
  }
  writeConf(lines.join('\n') + '\n');
  return { ok: true, state: st.state };
}

function writeConf(text) {
  fs.writeFileSync(`${CONF}.new`, text, { mode: 0o600 });
  fs.renameSync(`${CONF}.new`, CONF);
}

export function licenceUrl(erpUrl) {
  return erpUrl.replace(/\/upload\/?$/, '/license');
}

/** Asks the ERP for a fresh licence: 'renewed' | 'offline' | 'revoked'. */
export async function renew() {
  let text;
  try { text = fs.readFileSync(CONF, 'utf8'); } catch { return 'offline'; }
  const conf = parseConf(text);
  if (!conf.ERP_URL || !conf.UPLOAD_TOKEN) return 'offline';
  let res, body;
  try {
    res = await fetch(licenceUrl(conf.ERP_URL), {
      method: 'POST', headers: { Authorization: `Bearer ${conf.UPLOAD_TOKEN}` }, signal: AbortSignal.timeout(30000),
    });
    body = await res.text();
  } catch (e) {
    appLog('licence renew: no answer', e.message);
    return 'offline';
  }
  const keep = text.replace(/\r/g, '').split('\n').filter((l) => l && !l.startsWith('LICENSE_'));
  if (res.status === 200) {
    const fresh = body.replace(/\r/g, '').split('\n').filter((l) => /^LICENSE_[A-Z]+="[^"$`\\]*"$/.test(l));
    if (!fresh.some((l) => /^LICENSE_SIG="[A-Za-z0-9+/=]+"$/.test(l))) return 'offline';
    const next = keep.concat(fresh).join('\n') + '\n';
    if (licenceState(parseConf(next)).state === 'invalid') return 'offline';
    writeConf(next);
    return 'renewed';
  }
  if (res.status === 401) {
    writeConf(keep.join('\n') + '\n');
    appLog('licence renew: key stopped in the ERP, licence removed');
    return 'revoked';
  }
  return 'offline';
}

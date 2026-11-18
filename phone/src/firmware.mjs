// iOS firmware for the erase-restore: the latest version Apple still signs for the model,
// downloaded once from Apple and kept in DATA_DIR/firmware (several devices of the same model
// share one download). The file is checked against its published SHA-1 before use.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FIRMWARE } from './config.mjs';
import { appLog } from './util.mjs';

const API = process.env.TRIPLERE_IPSW_API || 'https://api.ipsw.me/v4';
const KEEP = 8; // firmware files kept on disk (oldest unused ones are removed)

const verCmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

/** Latest signed firmware for a model: {version, buildid, url, sha1sum, filesize}. */
export async function latestSigned(productType) {
  const res = await fetch(`${API}/device/${encodeURIComponent(productType)}?type=ipsw`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`firmware list HTTP ${res.status}`);
  const body = await res.json();
  const signed = (body.firmwares || []).filter((f) => f.signed && f.url);
  if (!signed.length) throw new Error('no signed firmware');
  signed.sort((a, b) => verCmp(b.version, a.version));
  return signed[0];
}

const downloads = new Map(); // file -> {promise, done, total}

export function downloadState(file) {
  const d = downloads.get(file);
  return d ? { done: d.done, total: d.total } : null;
}

/**
 * Makes sure the firmware is on disk; resolves to its path. onProgress(fraction) while downloading.
 * Calls for the same file share one download.
 */
export function ensureFirmware(fw, onProgress = () => {}) {
  const name = path.basename(new URL(fw.url).pathname).replace(/[^A-Za-z0-9._,-]/g, '_');
  const file = path.join(FIRMWARE, name);
  if (fs.existsSync(`${file}.ok`) && fs.existsSync(file)) {
    touch(file);
    return Promise.resolve(file);
  }
  let entry = downloads.get(file);
  if (!entry) {
    entry = { done: 0, total: Number(fw.filesize) || 0, listeners: new Set() };
    entry.promise = download(fw, file, entry).finally(() => downloads.delete(file));
    downloads.set(file, entry);
  }
  entry.listeners.add(onProgress);
  return entry.promise;
}

async function download(fw, file, entry) {
  fs.mkdirSync(FIRMWARE, { recursive: true });
  const need = (Number(fw.filesize) || 8e9) * 2.2; // the file plus room to unpack it during the restore
  try {
    const st = fs.statfsSync(FIRMWARE);
    if (st.bavail * st.bsize < need) {
      cleanup(file, 0);
      const st2 = fs.statfsSync(FIRMWARE);
      if (st2.bavail * st2.bsize < need) {
        throw new Error(`NOSPACE:${Math.ceil(need / 1e9)}`);
      }
    }
  } catch (e) {
    if (String(e.message).startsWith('NOSPACE')) throw e;
  }
  const part = `${file}.part`;
  const res = await fetch(fw.url, { signal: AbortSignal.timeout(6 * 3600 * 1000) });
  if (!res.ok || !res.body) throw new Error(`firmware download HTTP ${res.status}`);
  entry.total = Number(res.headers.get('content-length')) || entry.total;
  const sha1 = crypto.createHash('sha1');
  const out = fs.createWriteStream(part);
  let last = 0;
  try {
    for await (const chunk of res.body) {
      sha1.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      entry.done += chunk.length;
      const now = Date.now();
      if (now - last > 500 && entry.total) {
        last = now;
        for (const l of entry.listeners) l(entry.done / entry.total);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const got = sha1.digest('hex');
  if (fw.sha1sum && got.toLowerCase() !== String(fw.sha1sum).toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error('firmware checksum mismatch');
  }
  fs.renameSync(part, file);
  fs.writeFileSync(`${file}.ok`, `${fw.version} ${fw.buildid} ${got}\n`);
  for (const l of entry.listeners) l(1);
  cleanup(file, KEEP);
  appLog('firmware ready', path.basename(file), fw.version, fw.buildid);
  return file;
}

function touch(file) {
  try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* ignore */ }
}

/** Removes older firmware files, keeping `keep` most recently used (never the one in use). */
function cleanup(current, keep) {
  let files = [];
  try {
    files = fs.readdirSync(FIRMWARE).filter((n) => n.endsWith('.ipsw')).map((n) => path.join(FIRMWARE, n))
      .filter((f) => f !== current && !downloads.has(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return; }
  for (const f of files.slice(Math.max(0, keep - 1))) {
    fs.rmSync(f, { force: true });
    fs.rmSync(`${f}.ok`, { force: true });
  }
}

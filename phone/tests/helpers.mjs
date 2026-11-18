// Test helpers: a mock Triple Re ERP (+ firmware server), a signed test licence, the simulated
// device world, and the station started as a real child process.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(PHONE, 'tests', 'fake');

export const FORBIDDEN = /\b(?:idevice\w*|libimobiledevice|libirecovery|irecovery|usbmuxd|cfgutil|apple configurator|platform-tools|fastboot|adb|node\.js|node\.exe|nwipe|shredos)\b/i;

export function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tre-${name}-`));
}

// ------------------------------------------------------------------ licence signing (test key)
export function testKeys(dir) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = path.join(dir, 'test_public.pem');
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  const sign = (id, issued, expires) => crypto.sign('sha256', Buffer.from(`triplere-license-v1|${id}|${issued}|${expires}`), privateKey).toString('base64');
  return { pub, sign };
}

export const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

export function licenceLines(keys, id = 7, expiresOffset = 30) {
  const issued = day(0), expires = day(expiresOffset);
  return [`LICENSE_ID="${id}"`, `LICENSE_ISSUED="${issued}"`, `LICENSE_EXPIRES="${expires}"`, `LICENSE_SIG="${keys.sign(id, issued, expires)}"`];
}

// ------------------------------------------------------------------ mock ERP + firmware server
export async function mockErp(keys) {
  const erp = { uploads: [], licenceCalls: 0, down: false, revoked: false, fwDownloads: 0, port: 0, nextReport: 1000 };
  const ipsw = Buffer.from('fake ipsw content '.repeat(4096));
  const sha1 = crypto.createHash('sha1').update(ipsw).digest('hex');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (erp.down) { req.socket.destroy(); return; }
    const url = new URL(req.url, 'http://x');
    const auth = req.headers.authorization || '';
    if (url.pathname === '/api/erasure/license' && req.method === 'POST') {
      erp.licenceCalls++;
      if (erp.revoked || auth !== 'Bearer tre_test_key') { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('REVOKED\n'); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(licenceLines(keys, 7, 30).join('\n') + '\n');
    }
    if (url.pathname === '/api/erasure/upload' && req.method === 'POST') {
      if (auth !== 'Bearer tre_test_key') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"invalid_token"}'); }
      const text = body.toString('utf8');
      const field = (n) => (text.match(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`)) || [])[1];
      const file = (text.match(/name="log_file"; filename="([^"]+)"\r\nContent-Type: [^\r]*\r\n\r\n([\s\S]*?)\r\n--/) || []);
      const up = { filename: file[1], evidence: file[2] || '', client_name: field('client_name'), technician_name: field('technician_name'), work_order: field('work_order') };
      erp.uploads.push(up);
      const serial = (up.evidence.match(/^serial=(.*)$/m) || [])[1];
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, created: [{ report_number: `TRE-${erp.nextReport++}`, serial, result: 'Pass' }], skipped: 0 }));
    }
    const m = url.pathname.match(/^\/v4\/device\/(.+)$/);
    if (m) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ identifier: m[1], firmwares: [
        { version: '17.4', buildid: '21E219', signed: false, url: `http://127.0.0.1:${erp.port}/fw/old.ipsw`, sha1sum: 'x', filesize: 1 },
        { version: '18.1', buildid: '22B83', signed: true, url: `http://127.0.0.1:${erp.port}/fw/Universal_18.1_22B83_Restore.ipsw`, sha1sum: sha1, filesize: ipsw.length },
      ] }));
    }
    if (url.pathname.startsWith('/fw/')) {
      erp.fwDownloads++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': ipsw.length });
      return res.end(ipsw);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  erp.port = server.address().port;
  erp.url = `http://127.0.0.1:${erp.port}/api/erasure/upload`;
  erp.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return erp;
}

export function confText(erp, keys, opts = {}) {
  return [`# Triple Re Eraser — ${opts.name || 'PC-01 (test)'}`, `ERP_URL="${erp.url}"`, `UPLOAD_TOKEN="${opts.token || 'tre_test_key'}"`,
    ...(opts.noLicence ? [] : licenceLines(keys, 7, opts.expiresOffset ?? 30))].join('\n') + '\n';
}

// ------------------------------------------------------------------ simulated devices
export class World {
  constructor(dir) { this.file = path.join(dir, 'world.json'); this.write({ ios: [], android: [] }); }
  read() { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  write(w) { const t = `${this.file}.t`; fs.writeFileSync(t, JSON.stringify(w, null, 2)); fs.renameSync(t, this.file); }
  update(fn) {
    const lock = `${this.file}.lock`;
    const t0 = Date.now();
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch {
        if (Date.now() - t0 > 10000) throw new Error('world lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try { const w = this.read(); fn(w); this.write(w); } finally { fs.rmdirSync(lock); }
  }
}

// ------------------------------------------------------------------ station process
// A port the system says is free (Windows reserves ranges that a fixed choice can hit).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export async function startStation({ data, world, keys, erp, env = {} }) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(PHONE, 'src', 'main.mjs')], {
    env: {
      ...process.env, TRIPLERE_DATA: data, TRIPLERE_FAKE_TOOLS: FAKE, TRIPLERE_FAKE_WORLD: world.file, TRIPLERE_PORT: String(port),
      TRIPLERE_NO_WINDOW: '1', TRIPLERE_SCAN_MS: '250', TRIPLERE_LICENSE_PUBKEY: keys.pub, TRIPLERE_ALLOW_HTTP: '1',
      TRIPLERE_IPSW_API: `http://127.0.0.1:${erp.port}/v4`, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (b) => { output += b; });
  proc.stderr.on('data', (b) => { output += b; });
  const base = `http://127.0.0.1:${port}`;
  const st = {
    port, base, proc, get output() { return output; },
    async state() { return (await fetch(`${base}/api/state`)).json(); },
    async post(p, body, headers = { 'X-TripleRe': '1' }) {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async until(pred, ms = 20000, what = 'condition') {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < ms) {
        last = await st.state();
        const v = pred(last);
        if (v) return v;
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`timeout waiting for ${what}\nlast state: ${JSON.stringify(last, null, 1).slice(0, 4000)}\noutput: ${output.slice(-2000)}`);
    },
    stop() { proc.kill(); return new Promise((r) => proc.once('exit', r)); },
  };
  for (let i = 0; i < 100; i++) {
    try { await st.state(); return st; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`station did not start\n${output}`);
}

export const dev = (s, id) => s.devices.find((d) => d.id === id);

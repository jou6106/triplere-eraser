// Local web server for the screens. Listens on 127.0.0.1 only and accepts actions only from
// its own page (custom header + Origin + Host checks), so other web pages cannot drive it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PORT, SESSIONS, UI_DIR, WIN } from './config.mjs';
import { importConf, licenceState } from './licence.mjs';
import { reportDir, saveJob, upload } from './reports.mjs';
import * as station from './station.mjs';
import { appLog } from './util.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > limit) { reject(Object.assign(new Error('الطلب كبير'), { code: 413 })); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});

function allowedHost(h, port) {
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function openExternal(target) {
  const cmd = WIN ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch (e) { appLog('open', e); }
}

export function createServer(port = PORT) {
  return http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host, port)) return json(res, 403, { error: 'forbidden' });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
        const file = path.join(UI_DIR, name);
        if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
          'X-Frame-Options': 'DENY',
        });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, station.snapshot());
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

      const origin = req.headers.origin;
      if (req.headers['x-triplere'] !== '1' || (origin && !allowedHost(origin.replace(/^https?:\/\//, ''), port))) {
        return json(res, 403, { error: 'forbidden' });
      }
      const body = await readBody(req, url.pathname === '/api/licence/import' ? 16 * 1024 : 64 * 1024);
      switch (url.pathname) {
        case '/api/job':
          return json(res, 200, { ok: true, job: saveJob(body) });
        case '/api/licence/import': {
          const r = importConf(String(body.text || ''));
          if (r.ok) station.renewLicence().catch(() => {});
          return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, licence: licenceState() } : { error: r.error });
        }
        case '/api/licence/renew': {
          const r = await station.renewLicence();
          return json(res, 200, { ok: true, result: r, licence: licenceState() });
        }
        case '/api/erase': {
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const n = station.erase(ids, { ackLocks: body.ackLocks === true });
          return json(res, 200, { ok: true, started: n });
        }
        case '/api/confirm':
          await station.confirm(String(body.id || ''));
          return json(res, 200, { ok: true });
        case '/api/dismiss':
          station.dismiss(String(body.id || ''));
          return json(res, 200, { ok: true });
        case '/api/manual':
          return json(res, 200, { ok: true, id: station.manual(body) });
        case '/api/upload': {
          const dir = reportDir(body.report);
          if (!dir) return json(res, 404, { error: 'التقرير مش موجود' });
          return json(res, 200, await upload(dir));
        }
        case '/api/retry-uploads':
          await station.retryUploads();
          return json(res, 200, { ok: true });
        case '/api/open-apple-driver':
          openExternal(WIN ? 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K' : 'https://apps.apple.com/');
          return json(res, 200, { ok: true });
        case '/api/open-reports':
          openExternal(SESSIONS);
          return json(res, 200, { ok: true });
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      if (!e.code || typeof e.code !== 'number') appLog('http', e);
      json(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'حصلت مشكلة. جرّب تاني.' });
    }
  });
}

// Triple Re Mobile Eraser: starts the station and opens its window.
// One copy runs at a time; starting it again only opens another window on the running one.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, PORT, PRODUCT, VERSION, WIN, ensureDirs } from './config.mjs';
import { BUSY, devices } from './devices.mjs';
import { createServer } from './server.mjs';
import * as station from './station.mjs';
import { appLog } from './util.mjs';

const URL_ = `http://127.0.0.1:${PORT}/`;
const noWindow = process.env.TRIPLERE_NO_WINDOW === '1' || process.argv.includes('--no-window');

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let windowProc = null;
function openWindow() {
  if (noWindow) return;
  if (WIN) {
    const edge = edgePath();
    if (edge) {
      windowProc = spawn(edge, [`--app=${URL_}`, `--user-data-dir=${path.join(DATA_DIR, 'window')}`, '--no-first-run',
        '--no-default-browser-check', '--window-size=1280,880', '--disable-features=Translate'], { stdio: 'ignore' });
      windowProc.on('exit', onWindowClosed);
      windowProc.on('error', (e) => { appLog('window', e); fallbackOpen(); });
      return;
    }
  }
  fallbackOpen();
}

function fallbackOpen() {
  const cmd = WIN ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [URL_], { detached: true, stdio: 'ignore' }).unref();
}

// Closing the window ends the program, unless a device is still being erased: then it comes back.
function onWindowClosed() {
  windowProc = null;
  const busy = [...devices.values()].some((d) => BUSY.has(d.job.state));
  if (busy) {
    appLog('window closed during an erase, reopening');
    setTimeout(openWindow, 1500);
  } else {
    appLog('window closed, exiting');
    process.exit(0);
  }
}

async function alreadyRunning() {
  try {
    const r = await fetch(`${URL_}api/state`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  ensureDirs();
  appLog(`${PRODUCT} ${VERSION} starting`, { data: DATA_DIR });
  const server = createServer(PORT);
  server.on('error', async (e) => {
    if (e.code === 'EADDRINUSE' && await alreadyRunning()) {
      openWindow();
      setTimeout(() => process.exit(0), 500);
      return;
    }
    appLog('server error', e);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    appLog(`listening on ${URL_}`);
    station.start();
    openWindow();
  });
}

process.on('uncaughtException', (e) => appLog('uncaught', e));
process.on('unhandledRejection', (e) => appLog('unhandled', e));
main();

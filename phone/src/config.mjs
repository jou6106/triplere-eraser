// Where the app lives and where it keeps its data.
//   APP_DIR  : the installed program (read-only, e.g. C:\Program Files\Triple Re\Mobile Eraser)
//   DATA_DIR : reports, upload.conf, iOS firmware cache, logs (writable)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
export const PRODUCT = 'Triple Re Mobile Eraser';
export const WIN = process.platform === 'win32';

function isSea() {
  try { return process.getBuiltinModule('node:sea').isSea(); } catch { return false; }
}
export const PACKAGED = isSea();

// Packaged: next to the .exe (the bundle has no import.meta). From source: the phone/ folder.
export const APP_DIR = process.env.TRIPLERE_APP_DIR
  || (PACKAGED ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

export const DATA_DIR = process.env.TRIPLERE_DATA
  || (WIN ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Triple Re', 'Mobile Eraser')
    : path.join(os.homedir(), '.triplere-mobile-eraser'));

export const UI_DIR = path.join(APP_DIR, 'ui');
export const ASSETS = path.join(APP_DIR, 'assets');
export const SESSIONS = path.join(DATA_DIR, 'reports');
export const FIRMWARE = path.join(DATA_DIR, 'firmware');
export const CONF = path.join(DATA_DIR, 'upload.conf');
export const JOB_FILE = path.join(DATA_DIR, 'job.json');
export const LOG_FILE = path.join(DATA_DIR, 'app.log');
export const WIPER_APK = path.join(ASSETS, 'triplere-wiper.apk');

// The ERP public key is fixed in the program. Only a run from source (tests) may use another key.
export const LICENSE_PUBKEY = (!PACKAGED && process.env.TRIPLERE_LICENSE_PUBKEY) || path.join(ASSETS, 'license_public.pem');

export const PORT = Number(process.env.TRIPLERE_PORT || 4320);
export const SCAN_MS = Number(process.env.TRIPLERE_SCAN_MS || 2500);

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS, FIRMWARE]) fs.mkdirSync(d, { recursive: true });
}

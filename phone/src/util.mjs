// Small helpers shared by the station: running the bundled device tools, parsing their
// output (Windows tools print \r\n), logging, and keeping tool names out of anything visible.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, LOG_FILE, WIN } from './config.mjs';

const TOOL_DIRS = {
  idevice_id: 'ios', ideviceinfo: 'ios', idevicepair: 'ios', ideviceenterrecovery: 'ios',
  idevicerestore: 'ios', 'triplere-recovery-list': 'ios', adb: 'android', fastboot: 'android',
};

// Tests point TRIPLERE_FAKE_TOOLS at a folder with fake.mjs, which plays every tool.
export function resolveTool(name) {
  const fake = process.env.TRIPLERE_FAKE_TOOLS;
  if (fake) return { cmd: process.execPath, pre: [path.join(fake, 'fake.mjs'), name] };
  const dir = TOOL_DIRS[name];
  if (dir) {
    const p = path.join(APP_DIR, 'tools', dir, WIN ? `${name}.exe` : name);
    if (fs.existsSync(p)) return { cmd: p, pre: [] };
  }
  return { cmd: name, pre: [] };
}

export function toolAvailable(name) {
  if (process.env.TRIPLERE_FAKE_TOOLS) return true;
  const dir = TOOL_DIRS[name];
  if (dir && fs.existsSync(path.join(APP_DIR, 'tools', dir, WIN ? `${name}.exe` : name))) return true;
  const exts = WIN ? ['.exe', '.cmd', ''] : [''];
  return (process.env.PATH || process.env.Path || '').split(path.delimiter).some((d) => d && exts.some((e) => {
    try { return fs.statSync(path.join(d, name + e)).isFile(); } catch { return false; }
  }));
}

/** Runs a tool to completion. Never throws: {code, out, err}. */
export function run(name, args, timeout = 15000) {
  const { cmd, pre } = resolveTool(name);
  return new Promise((resolve) => {
    execFile(cmd, [...pre, ...args], { timeout, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        out: String(stdout || '').replace(/\r\n?/g, '\n'),
        err: String(stderr || '').replace(/\r\n?/g, '\n'),
      });
    });
  });
}

/** Starts a long-running tool (iOS restore). */
export function spawnTool(name, args, opts = {}) {
  const { cmd, pre } = resolveTool(name);
  return spawn(cmd, [...pre, ...args], { windowsHide: true, ...opts });
}

/** "Key: value" lines -> object (first value wins). */
export function kv(text) {
  const o = {};
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.]+):\s?(.*)$/);
    if (m && !(m[1] in o)) o[m[1]] = m[2].trim();
  }
  return o;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_');

// Names of the underlying tools never reach the screen, the reports or the ERP.
const TOOL_WORDS = [
  [/\bidevicerestore\b/gi, 'restore'], [/\bideviceenterrecovery\b/gi, 'recovery'], [/\bidevice(?:info|pair|_id)\b/gi, 'device query'],
  [/\blib(?:imobiledevice(?:-glue)?|irecovery|usbmuxd|plist|tatsu)\b/gi, 'device library'], [/\birecovery\b/gi, 'recovery'],
  [/\bcfgutil\b/gi, 'restore'], [/Apple Configurator/gi, 'restore'], [/\bplatform-tools\b/gi, 'tools'],
  [/\bfastboot\b/gi, 'bootloader'], [/\badb\b/gi, 'station'], [/\bnode(?:\.exe|\.js)?\b/gi, 'station'],
];
export const FORBIDDEN = /\b(?:idevice\w*|libimobiledevice|libirecovery|irecovery|usbmuxd|cfgutil|apple configurator|platform-tools|fastboot|adb|node\.js|node\.exe|nwipe|shredos)\b/i;
export function scrub(text) {
  let s = String(text ?? '');
  for (const [re, w] of TOOL_WORDS) s = s.replace(re, w);
  return s;
}

export function appLog(...parts) {
  const line = `${nowIso()} ${parts.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* data dir not ready yet */ }
  if (process.env.TRIPLERE_DEBUG) process.stderr.write(line);
}

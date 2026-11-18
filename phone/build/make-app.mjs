// Builds the Windows program folder (run on Windows with Node 24):
//   dist/app/Triple Re Mobile Eraser.exe   one-file program (Node single executable application)
//   dist/app/ui, assets, tools/ios, tools/android, licenses
// Usage: node phone/build/make-app.mjs <ios-tools-dir> <android-tools-dir> <rcedit.exe>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [iosTools, androidTools, rcedit] = process.argv.slice(2);
if (!iosTools || !androidTools || !rcedit) throw new Error('usage: make-app.mjs <ios-tools> <android-tools> <rcedit.exe>');
const VERSION = fs.readFileSync(path.join(PHONE, 'src', 'config.mjs'), 'utf8').match(/VERSION = '([\d.]+)'/)[1];
const BUILD = path.join(PHONE, 'dist', 'build');
const APP = path.join(PHONE, 'dist', 'app');
const EXE = path.join(APP, 'Triple Re Mobile Eraser.exe');
const sh = (cmd, args, opts = {}) => { console.log('>', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit', shell: false, ...opts }); };
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

fs.rmSync(path.join(PHONE, 'dist'), { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(APP, { recursive: true });

// 1. One CommonJS file with all station code.
sh(npx, ['--yes', 'esbuild@0.24.2', path.join(PHONE, 'src', 'main.mjs'), '--bundle', '--platform=node', '--format=cjs',
  '--target=node24', '--log-override:empty-import-meta=silent', `--outfile=${path.join(BUILD, 'app.cjs')}`], { shell: process.platform === 'win32' });

// 2. Single executable: copy node.exe, brand it, inject the app.
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
  main: path.join(BUILD, 'app.cjs'), output: path.join(BUILD, 'sea.blob'), disableExperimentalSEAWarning: true, useCodeCache: false,
}));
sh(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')]);
fs.copyFileSync(process.execPath, EXE);

// Remove the original signature (it would no longer match) when signtool is available.
const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
if (fs.existsSync(kits)) {
  const signtool = fs.readdirSync(kits).filter((v) => /^10\./.test(v)).sort().reverse()
    .map((v) => path.join(kits, v, 'x64', 'signtool.exe')).find((p) => fs.existsSync(p));
  if (signtool) {
    try { sh(signtool, ['remove', '/s', EXE]); } catch { console.log('signtool remove failed (continuing)'); }
  }
}

sh(rcedit, [EXE,
  '--set-icon', path.join(PHONE, 'assets', 'triplere.ico'),
  '--set-file-version', VERSION, '--set-product-version', VERSION,
  '--set-version-string', 'ProductName', 'Triple Re Mobile Eraser',
  '--set-version-string', 'FileDescription', 'Triple Re Mobile Eraser',
  '--set-version-string', 'CompanyName', 'Triple Re',
  '--set-version-string', 'LegalCopyright', `Copyright (c) ${new Date().getFullYear()} Triple Re`,
  '--set-version-string', 'OriginalFilename', 'Triple Re Mobile Eraser.exe',
  '--set-version-string', 'InternalName', 'TripleReMobileEraser',
]);

sh(npx, ['--yes', 'postject@1.0.0-alpha.6', EXE, 'NODE_SEA_BLOB', path.join(BUILD, 'sea.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { shell: process.platform === 'win32' });

// Windows GUI program: no black console window (PE optional header Subsystem = 2).
{
  const buf = fs.readFileSync(EXE);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const sub = pe + 4 + 20 + 68;
  console.log('subsystem was', buf.readUInt16LE(sub));
  buf.writeUInt16LE(2, sub);
  fs.writeFileSync(EXE, buf);
}

// 3. Files next to the program.
const copyDir = (from, to, filter = () => true) => {
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) {
    const s = path.join(from, n), d = path.join(to, n);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, filter);
    else if (filter(n)) fs.copyFileSync(s, d);
  }
};
copyDir(path.join(PHONE, 'ui'), path.join(APP, 'ui'));
copyDir(path.join(PHONE, 'assets'), path.join(APP, 'assets'));
copyDir(iosTools, path.join(APP, 'tools', 'ios'), (n) => !n.endsWith('.txt') && n !== 'licenses');
copyDir(path.join(iosTools, 'licenses'), path.join(APP, 'licenses', 'device-tools'));
for (const n of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'fastboot.exe']) {
  fs.mkdirSync(path.join(APP, 'tools', 'android'), { recursive: true });
  fs.copyFileSync(path.join(androidTools, n), path.join(APP, 'tools', 'android', n));
}
for (const n of ['NOTICE.txt', 'NOTICE']) {
  if (fs.existsSync(path.join(androidTools, n))) {
    fs.mkdirSync(path.join(APP, 'licenses', 'android-tools'), { recursive: true });
    fs.copyFileSync(path.join(androidTools, n), path.join(APP, 'licenses', 'android-tools', 'NOTICE.txt'));
  }
}
const runtimeLicence = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(runtimeLicence)) fs.copyFileSync(runtimeLicence, path.join(APP, 'licenses', 'runtime-LICENSE.txt'));
console.log(`built ${EXE} (${VERSION})`);

// Plays every device tool for the tests: `node fake.mjs <tool> <args...>`.
// The simulated world (devices, their modes, what succeeds) is a JSON file in TRIPLERE_FAKE_WORLD,
// which tests edit and this script updates (e.g. a restore puts the device back in normal mode).
// Output uses \r\n like the Windows builds of the real tools.
import fs from 'node:fs';

const WORLD = process.env.TRIPLERE_FAKE_WORLD;
const [tool, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(String(s).replace(/\n/g, '\r\n'));
const err = (s) => process.stderr.write(String(s).replace(/\n/g, '\r\n'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  for (let i = 0; i < 20; i++) {
    try { return JSON.parse(fs.readFileSync(WORLD, 'utf8')); } catch { /* being written */ }
  }
  return { ios: [], android: [] };
}
function save(w) {
  const tmp = `${WORLD}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 2));
  fs.renameSync(tmp, WORLD);
}
// Every change holds a lock (a directory) so concurrent tool runs never lose each other's updates.
function lock() {
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(`${WORLD}.lock`); return; } catch {
      try { if (Date.now() - fs.statSync(`${WORLD}.lock`).mtimeMs > 5000) fs.rmdirSync(`${WORLD}.lock`); } catch { /* gone */ }
      if (Date.now() - t0 > 10000) throw new Error('world lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
const unlock = () => { try { fs.rmdirSync(`${WORLD}.lock`); } catch { /* ignore */ } };
function update(fn) { lock(); try { const w = load(); fn(w); save(w); return w; } finally { unlock(); } }
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const calls = (name) => update((w) => { w.calls = w.calls || {}; w.calls[name] = (w.calls[name] || 0) + 1; });

async function main() {
  const w = load();
  calls(tool);
  switch (tool) {
    case 'idevice_id': {
      if (w.appleMissing) { err('ERROR: Unable to retrieve device list!\n'); return 1; }
      out(w.ios.filter((d) => d.mode === 'normal').map((d) => `${d.udid}\n`).join(''));
      return 0;
    }
    case 'ideviceinfo': {
      const d = w.ios.find((x) => x.udid === arg('-u') && x.mode === 'normal');
      if (!d) { err('ERROR: Device not found\n'); return 1; }
      const q = arg('-q');
      if (args.includes('-s')) {
        out([`ActivationState: ${d.activation || 'Activated'}`, `DeviceClass: ${d.cls || 'iPhone'}`, 'DeviceName: Test Phone',
          `ProductType: ${d.product}`, `ProductVersion: ${d.os || '17.5'}`, `UniqueChipID: ${BigInt('0x' + d.ecid).toString()}`,
          d.serialInSimple === false ? '' : `SerialNumber: ${d.serial}`].filter(Boolean).join('\n') + '\n');
        return 0;
      }
      if (!d.paired) { err('ERROR: Could not connect to lockdownd: Pairing dialog response pending (-19)\n'); return 1; }
      if (q === 'com.apple.fmip') { out(`IsAssociated: ${d.findMy ? 'true' : 'false'}\n`); return 0; }
      if (q === 'com.apple.disk_usage') { out(`TotalDiskCapacity: ${d.capacity || 128000000000}\nTotalDataCapacity: 1\n`); return 0; }
      out([`ActivationState: Activated`, `DeviceClass: ${d.cls || 'iPhone'}`, 'DeviceColor: 1', `ProductType: ${d.product}`,
        `ProductVersion: ${d.os || '17.5'}`, `SerialNumber: ${d.serial}`, `UniqueChipID: ${BigInt('0x' + d.ecid).toString()}`,
        `InternationalMobileEquipmentIdentity: ${d.imei || ''}`, 'WiFiAddress: aa:bb:cc:dd:ee:ff', `UniqueDeviceID: ${d.udid}`].join('\n') + '\n');
      return 0;
    }
    case 'idevicepair': {
      const d = w.ios.find((x) => x.udid === arg('-u'));
      if (!d) return 1;
      if (args[0] === 'validate' || args.includes('validate')) return d.paired ? 0 : 1;
      if (args.includes('pair')) {
        if (d.trustOnPair) { update((x) => { x.ios.find((y) => y.udid === d.udid).paired = true; }); out('SUCCESS: Paired\n'); return 0; }
        err('ERROR: Please accept the trust dialog on the screen of device, then attempt to pair again.\n');
        return 1;
      }
      return 1;
    }
    case 'ideviceenterrecovery': {
      const d = w.ios.find((x) => x.udid === args[0]);
      if (!d || d.noAutoRecovery) { err('ERROR: Could not enter recovery mode\n'); return 1; }
      update((x) => { x.ios.find((y) => y.udid === d.udid).mode = 'recovery'; });
      out('Telling device to enter recovery mode.\nDevice is successfully switching to recovery mode.\n');
      return 0;
    }
    case 'triplere-recovery-list': {
      out(w.ios.filter((d) => d.mode === 'recovery' || d.mode === 'dfu').map((d) =>
        `ECID=0x${d.ecid} MODE=${d.mode} CPID=0x8030 BDID=0x04 SRNM=${d.serial} IMEI=${d.imei || ''} PRODUCT=${d.product}\n`).join(''));
      return 0;
    }
    case 'idevicerestore': {
      const ecid = (arg('-i') || '').replace(/^0x/, '').toUpperCase().padStart(16, '0');
      const d = w.ios.find((x) => x.ecid === ecid);
      if (!d || !['recovery', 'dfu'].includes(d.mode)) { err('ERROR: Unable to find device\n'); return 1; }
      update((x) => { x.restoreArgs = (x.restoreArgs || []).concat([args]); x.ios.find((y) => y.ecid === ecid).mode = 'restore'; });
      out('Found device in Recovery mode\nidevicerestore 1.0.0 (libirecovery 1.2)\n');
      for (const [step, n] of [[1, 2], [2, 4], [3, 2], [4, 2]]) {
        for (let i = 1; i <= n; i++) { out(`progress: ${step} ${(i / n).toFixed(6)}\n`); await sleep(load().slowRestore || 40); }
      }
      if (d.restoreFail) {
        update((x) => { x.ios.find((y) => y.ecid === ecid).mode = 'recovery'; });
        err('ERROR: Unable to restore device\n');
        return 1;
      }
      out('DONE\n');
      update((x) => {
        const y = x.ios.find((z) => z.ecid === ecid);
        Object.assign(y, { mode: 'normal', paired: false, findMy: false, activation: 'Unactivated', erased: true });
      });
      return 0;
    }
    case 'adb': {
      const sIdx = args.indexOf('-s');
      const serial = sIdx >= 0 ? args[sIdx + 1] : null;
      const rest = sIdx >= 0 ? args.slice(sIdx + 2) : args;
      if (rest[0] === 'devices') {
        out('List of devices attached\n' + w.android.filter((d) => ['device', 'unauthorized', 'recovery'].includes(d.state))
          .map((d) => `${d.serial}\t${d.state} product:x model:${d.model} device:x transport_id:1\n`).join(''));
        return 0;
      }
      const d = w.android.find((x) => x.serial === serial);
      if (!d || d.state === 'gone') { err('error: device not found\n'); return 1; }
      const set = (patch) => update((x) => Object.assign(x.android.find((y) => y.serial === serial), patch));
      if (rest[0] === 'get-state') { out(`${d.state}\n`); return 0; }
      if (rest[0] === 'install') { if (d.refuseInstall) { out('Failure [INSTALL_FAILED_USER_RESTRICTED]\n'); return 1; } out('Performing Streamed Install\nSuccess\n'); return 0; }
      if (rest[0] === 'uninstall') { out('Success\n'); return 0; }
      if (rest[0] === 'reboot' && rest[1] === 'recovery') { set({ state: 'recovery' }); return 0; }
      if (rest[0] === 'logcat') {
        if (rest.includes('-c')) return 0;
        out(d.wipeRequested ? (d.refuseWipe ? 'E TripleReWiper: TRIPLERE_WIPE_ERROR java.lang.SecurityException\n' : 'I TripleReWiper: TRIPLERE_WIPE_REQUESTED\n') : '');
        if (d.wipeRequested && !d.refuseWipe && !d.wipedAt) set({ wipedAt: Date.now() });
        return 0;
      }
      if (rest[0] === 'shell') {
        const cmd = rest.slice(1).join(' ');
        if (cmd === 'getprop') {
          out(Object.entries({
            'ro.serialno': d.serial, 'ro.product.manufacturer': d.manufacturer || 'samsung', 'ro.product.brand': 'samsung',
            'ro.product.model': d.model, 'ro.build.version.release': d.android || '14', 'ro.crypto.state': d.crypto ?? 'encrypted',
            'ro.crypto.type': 'file', 'ro.adb.secure': '1', 'persist.sys.usb.config': 'mtp,adb',
          }).map(([k, v]) => `[${k}]: [${v}]\n`).join(''));
          return 0;
        }
        if (cmd.startsWith('dumpsys account')) {
          out(`User UserInfo{0:Owner:c13} :\n  Accounts: ${(d.accounts || []).length}\n` + (d.accounts || []).map((a) => `    Account {name=${a.name}, type=${a.type}}\n`).join(''));
          return 0;
        }
        if (cmd.startsWith('service call iphonesubinfo')) {
          if (!d.imei) { out('Result: Parcel(ffffffff ...)\n'); return 0; }
          const s = d.imei;
          out(`Result: Parcel(\n  0x00000000: 00000000 0000000f 00350033 00380030 '........${s.slice(0, 4).split('').join('.')}'\n  0x00000010: 00350033 '${s.slice(4).split('').join('.')}.')\n`);
          return 0;
        }
        if (cmd.startsWith('dpm set-active-admin')) { out(d.refuseAdmin ? 'Error: java.lang.SecurityException\n' : 'Success: Active admin set to component {net.triplere.wiper/net.triplere.wiper.AdminReceiver}\n'); return 0; }
        if (cmd.startsWith('dpm remove-active-admin')) { out('Success\n'); return 0; }
        if (cmd.startsWith('am start')) {
          set({ wipeRequested: true });
          out('Starting: Intent { cmp=net.triplere.wiper/.WipeActivity }\nStatus: ok\n');
          // The phone reboots into the reset a moment later.
          if (!d.refuseWipe) update((x) => { x.android.find((y) => y.serial === serial).goneAfter = Date.now() + 1500; });
          return 0;
        }
        return 0;
      }
      return 0;
    }
    case 'fastboot': {
      if (args[0] === 'devices') { out(w.android.filter((d) => d.state === 'fastboot').map((d) => `${d.serial}\tfastboot\n`).join('')); return 0; }
      const serial = arg('-s');
      if (args.includes('getvar')) { err(`(bootloader) product: ${w.android.find((d) => d.serial === serial)?.model || 'x'}\n(bootloader) unlocked: ${w.android.find((d) => d.serial === serial)?.unlocked ? 'yes' : 'no'}\nall: Done\n`); return 0; }
      if (args.includes('-w')) { err('Erasing userdata... OKAY\nErasing metadata... OKAY\n'); return 0; }
      if (args.includes('reboot')) { update((x) => { x.android.find((d) => d.serial === serial).state = 'gone'; }); return 0; }
      return 0;
    }
    default:
      err(`unknown tool ${tool}\n`);
      return 2;
  }
}

// A phone that accepted the wipe disappears from USB debugging shortly after.
update((w) => {
  for (const d of w.android || []) if (d.goneAfter && Date.now() > d.goneAfter && d.state === 'device') d.state = 'gone';
});
main().then((code) => process.exit(code ?? 0), (e) => { err(String(e.stack || e)); process.exit(3); });

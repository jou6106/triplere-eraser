// End-to-end tests of the station with simulated iPhones, iPads and Android phones, a mock ERP
// and the real licence check. Run: node --test phone/tests/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FORBIDDEN, PHONE, World, confText, dev, licenceLines, mockErp, startStation, testKeys, tmpdir } from './helpers.mjs';

const IPHONE = { udid: '00008030-001A2B3C4D5E602E', ecid: '001A2B3C4D5E602E', product: 'iPhone12,1', serial: 'F2LXK0AAN72J', imei: '356789012345678', mode: 'normal', paired: true, findMy: false };
const LOCKED = { udid: '00008101-0011223344556677', ecid: '0011223344556677', product: 'iPhone13,2', serial: 'G6TZ1234Q1GH', imei: '353000111222333', mode: 'normal', paired: false, serialInSimple: false };
const IPAD = { udid: '00008027-0099887766554433', ecid: '0099887766554433', product: 'iPad13,18', cls: 'iPad', serial: 'DMPXK9AAHP5V', mode: 'normal', paired: true, findMy: false };
const SAMSUNG = { serial: 'R58N123ABCD', state: 'device', model: 'SM-A546E', manufacturer: 'samsung', imei: '351234567890123', accounts: [{ name: 'owner@gmail.com', type: 'com.google' }] };

let keys, erp, keyDir;
before(async () => {
  keyDir = tmpdir('keys');
  keys = testKeys(keyDir);
  erp = await mockErp(keys);
});
after(async () => { await erp.close(); });

async function fresh(opts = {}) {
  const data = tmpdir('data');
  const world = new World(data);
  if (opts.conf !== false) fs.writeFileSync(path.join(data, 'upload.conf'), opts.conf || confText(erp, keys));
  if (opts.job !== false) fs.writeFileSync(path.join(data, 'job.json'), JSON.stringify({ client_name: 'Vodafone Egypt', technician_name: 'Ahmed', work_order: 'WO-55' }));
  world.update((w) => { w.ios = opts.ios || []; w.android = opts.android || []; w.appleMissing = opts.appleMissing || false; });
  const st = await startStation({ data, world, keys, erp, env: opts.env });
  return { data, world, st };
}

function noToolNames(text, where) {
  const m = String(text).match(FORBIDDEN);
  assert.equal(m, null, `${where} mentions "${m && m[0]}"`);
}

describe('licence', () => {
  test('missing licence: shown as missing and erase is refused', async () => {
    const { st } = await fresh({ conf: false });
    try {
      const s = await st.state();
      assert.equal(s.licence.state, 'missing');
      const r = await st.post('/api/erase', { ids: ['x'] });
      assert.equal(r.status, 403);
    } finally { await st.stop(); }
  });

  test('import: wrong file rejected, signed file accepted, edited expiry rejected', async () => {
    const { st, data } = await fresh({ conf: false });
    try {
      let r = await st.post('/api/licence/import', { text: 'hello' });
      assert.equal(r.status, 400);
      const good = confText(erp, keys);
      const forged = good.replace(/LICENSE_EXPIRES="[^"]+"/, 'LICENSE_EXPIRES="2099-01-01"');
      r = await st.post('/api/licence/import', { text: forged });
      assert.equal(r.status, 400, 'a licence with an edited date must not import');
      assert.ok(!fs.existsSync(path.join(data, 'upload.conf')));
      r = await st.post('/api/licence/import', { text: good.replace(/\n/g, '\r\n') });
      assert.equal(r.status, 200);
      assert.equal(r.body.licence.state, 'valid');
      const saved = fs.readFileSync(path.join(data, 'upload.conf'), 'utf8');
      assert.match(saved, /^UPLOAD_TOKEN="tre_test_key"$/m);
      assert.equal((await st.state()).licence.name, 'PC-01 (test)');
    } finally { await st.stop(); }
  });

  test('expired licence is renewed from the ERP; a stopped key removes it', async () => {
    const { st, data } = await fresh({ conf: confText(erp, keys, { expiresOffset: -2 }) });
    try {
      // Renewal runs at start.
      await st.until((s) => s.licence.state === 'valid', 8000, 'renewed licence');
      erp.revoked = true;
      const r = await st.post('/api/licence/renew', {});
      assert.equal(r.body.result, 'revoked');
      assert.equal(r.body.licence.state, 'missing');
      assert.doesNotMatch(fs.readFileSync(path.join(data, 'upload.conf'), 'utf8'), /LICENSE_/);
    } finally { erp.revoked = false; await st.stop(); }
  });

  test('job details are required before erasing', async () => {
    const { st } = await fresh({ job: false, ios: [IPHONE] });
    try {
      await st.until((s) => dev(s, `ios:${IPHONE.ecid}`), 8000, 'iphone');
      const r = await st.post('/api/erase', { ids: [`ios:${IPHONE.ecid}`] });
      assert.equal(r.status, 400);
    } finally { await st.stop(); }
  });
});

describe('iPhone / iPad', () => {
  test('trusted iPhone: identity read, erase-restore, report uploaded with certificate', async () => {
    const { st, world, data } = await fresh({ ios: [IPHONE] });
    const id = `ios:${IPHONE.ecid}`;
    try {
      const d = await st.until((s) => { const x = dev(s, id); return x && x.info.findMy === 'off' && x; }, 10000, 'trusted iphone');
      assert.equal(d.info.serial, IPHONE.serial);
      assert.equal(d.info.imei, IPHONE.imei);
      assert.equal(d.info.name, 'iPhone 11');
      assert.equal(d.info.capacity, '128 GB');
      assert.equal(d.needsAck, false);
      const before = erp.uploads.length;
      const r = await st.post('/api/erase', { ids: [id] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const done = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'done' && x; }, 20000, 'erase done');
      assert.equal(done.job.upload.ok, true);
      assert.match(done.job.certificates[0].number, /^TRE-\d+$/);
      const up = erp.uploads.slice(before).pop();
      assert.equal(up.client_name, 'Vodafone Egypt');
      assert.equal(up.technician_name, 'Ahmed');
      assert.equal(up.work_order, 'WO-55');
      assert.match(up.evidence, /^### TRIPLERE-MOBILE-ERASURE v1$/m);
      assert.match(up.evidence, /^platform=ios$/m);
      assert.match(up.evidence, /^reset_confirmed=yes$/m);
      assert.match(up.evidence, /^tool=Triple Re Mobile Eraser /m);
      assert.match(up.evidence, /^### before\n[\s\S]*^SerialNumber: F2LXK0AAN72J$/m);
      assert.match(up.evidence, /^IsAssociated: false$/m);
      assert.match(up.evidence, /^### after\n[\s\S]*^ActivationState: Unactivated$/m);
      assert.match(up.evidence, /^firmware_installed=18\.1 \(22B83\)$/m);
      noToolNames(up.evidence, 'iOS evidence');
      noToolNames(done.job.log.join('\n'), 'job log');
      const w = world.read();
      assert.deepEqual(w.restoreArgs[0].slice(0, 4), ['-e', '-y', '-P', '-i']);
      assert.ok(w.restoreArgs[0].at(-1).endsWith('Universal_18.1_22B83_Restore.ipsw'));
      const hist = (await st.state()).history;
      assert.equal(hist[0].uploaded, true);
      assert.ok(fs.readdirSync(path.join(data, 'reports')).length >= 1);
    } finally { await st.stop(); }
  });

  test('passcode-locked iPhone: needs the Find My warning, identity from Recovery, erased', async () => {
    const { st } = await fresh({ ios: [LOCKED] });
    const id = `ios:${LOCKED.ecid}`;
    try {
      const d = await st.until((s) => { const x = dev(s, id); return x && x.mode === 'locked' && x; }, 10000, 'locked iphone');
      assert.equal(d.needsAck, true);
      assert.equal((await st.post('/api/erase', { ids: [id] })).status, 409);
      const before = erp.uploads.length;
      assert.equal((await st.post('/api/erase', { ids: [id], ackLocks: true })).status, 200);
      const done = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'done' && x; }, 20000, 'locked erase done');
      assert.equal(done.info.serial, LOCKED.serial, 'serial read in Recovery mode');
      const up = erp.uploads.slice(before).pop();
      assert.match(up.evidence, /^serial=G6TZ1234Q1GH$/m);
      assert.match(up.evidence, /^### before\nSerialNumber: G6TZ1234Q1GH$/m);
      assert.match(up.evidence, /^find_my_ack=yes/m);
      noToolNames(up.evidence, 'locked iOS evidence');
    } finally { await st.stop(); }
  });

  test('device that will not enter Recovery by command: asks for the buttons, continues by itself', async () => {
    const { st, world } = await fresh({ ios: [{ ...IPHONE, noAutoRecovery: true }] });
    const id = `ios:${IPHONE.ecid}`;
    try {
      await st.until((s) => dev(s, id)?.info.findMy === 'off', 10000, 'iphone');
      await st.post('/api/erase', { ids: [id] });
      const w = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'waiting-recovery' && x; }, 15000, 'waiting for buttons');
      assert.ok(w.recoverySteps.length >= 2);
      assert.match(w.recoverySteps.join(' '), /Volume Up/);
      world.update((x) => { x.ios[0].mode = 'recovery'; });
      await st.until((s) => dev(s, id)?.job.state === 'done', 20000, 'done after buttons');
    } finally { await st.stop(); }
  });

  test('iPhone and iPad together: one firmware download per file, both erased', async () => {
    const { st } = await fresh({ ios: [IPHONE, IPAD] });
    const ids = [`ios:${IPHONE.ecid}`, `ios:${IPAD.ecid}`];
    try {
      await st.until((s) => ids.every((i) => dev(s, i)?.info.findMy === 'off'), 10000, 'both devices');
      const s0 = await st.state();
      assert.equal(dev(s0, ids[1]).kind, 'ipad');
      assert.equal(dev(s0, ids[1]).info.name, 'iPad (10th gen)');
      const fw0 = erp.fwDownloads;
      assert.equal((await st.post('/api/erase', { ids })).status, 200);
      await st.until((s) => ids.every((i) => dev(s, i)?.job.state === 'done'), 25000, 'both done');
      assert.equal(erp.fwDownloads - fw0, 1, 'both devices share one firmware download');
    } finally { await st.stop(); }
  });

  test('restore failure: shown as failed with a clear message, can be retried', async () => {
    const { st, world } = await fresh({ ios: [{ ...IPHONE, restoreFail: true }] });
    const id = `ios:${IPHONE.ecid}`;
    try {
      await st.until((s) => dev(s, id)?.info.findMy === 'off', 10000, 'iphone');
      await st.post('/api/erase', { ids: [id] });
      const f = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'failed' && x; }, 20000, 'failed');
      assert.match(f.job.message, /جرّب تاني/);
      world.update((x) => { x.ios[0].restoreFail = false; });
      assert.equal((await st.post('/api/erase', { ids: [id] })).status, 200);
      await st.until((s) => dev(s, id)?.job.state === 'done', 20000, 'retry done');
    } finally { await st.stop(); }
  });

  test('no Apple driver: iPhones are not offered, the screen shows the reason', async () => {
    const { st } = await fresh({ ios: [IPHONE], appleMissing: true });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await st.state();
      assert.equal(s.status.apple, false);
      assert.equal(s.devices.length, 0);
    } finally { await st.stop(); }
  });
});

describe('Samsung / Android', () => {
  test('USB debugging: account warning, automatic factory reset, evidence', async () => {
    const { st } = await fresh({ android: [SAMSUNG] });
    const id = `android:${SAMSUNG.serial}`;
    try {
      const d = await st.until((s) => { const x = dev(s, id); return x && x.info.accounts && x; }, 10000, 'samsung');
      assert.equal(d.info.accounts.google, 1);
      assert.equal(d.info.encryption, 'encrypted (file)');
      assert.equal(d.info.imei, SAMSUNG.imei);
      assert.equal(d.needsAck, true);
      assert.equal((await st.post('/api/erase', { ids: [id] })).status, 409);
      const before = erp.uploads.length;
      assert.equal((await st.post('/api/erase', { ids: [id], ackLocks: true })).status, 200);
      const done = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'done' && x; }, 20000, 'android done');
      assert.equal(done.job.upload.ok, true);
      const up = erp.uploads.slice(before).pop();
      assert.match(up.evidence, /^platform=android$/m);
      assert.match(up.evidence, /^encryption=encrypted \(file\)$/m);
      assert.match(up.evidence, /^accounts_google=1$/m);
      assert.match(up.evidence, /^frp_ack=yes/m);
      assert.match(up.evidence, /^### before\n[\s\S]*^ro\.serialno: R58N123ABCD$/m);
      assert.doesNotMatch(up.evidence, /owner@gmail\.com/, 'account names are not copied into the report');
      noToolNames(up.evidence, 'android evidence');
      noToolNames(done.job.log.join('\n'), 'android job log');
    } finally { await st.stop(); }
  });

  test('phone refuses the wiper app: goes to Recovery, technician confirms', async () => {
    const { st } = await fresh({ android: [{ ...SAMSUNG, accounts: [], refuseInstall: true }] });
    const id = `android:${SAMSUNG.serial}`;
    try {
      await st.until((s) => dev(s, id)?.info.accounts, 10000, 'samsung');
      await st.post('/api/erase', { ids: [id] });
      await st.until((s) => dev(s, id)?.job.state === 'awaiting-confirm', 15000, 'awaiting confirm');
      assert.equal((await st.post('/api/confirm', { id })).status, 200);
      const done = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'done' && x; }, 10000, 'done');
      assert.equal(done.job.upload.ok, true);
    } finally { await st.stop(); }
  });

  test('locked phone added by serial, erased in Recovery and confirmed', async () => {
    const { st } = await fresh();
    try {
      let r = await st.post('/api/manual', { serial: 'bad serial!' });
      assert.equal(r.status, 400);
      r = await st.post('/api/manual', { serial: 'RF8T90XYZ12', model: 'SM-G991B', manufacturer: 'Samsung', imei: '35-111222-333444-5' });
      assert.equal(r.status, 200);
      const id = r.body.id;
      const s = await st.state();
      assert.equal(dev(s, id).info.imei, '351112223334445');
      assert.equal((await st.post('/api/erase', { ids: [id], ackLocks: true })).status, 200);
      await st.until((x) => dev(x, id)?.job.state === 'awaiting-confirm', 5000, 'awaiting confirm');
      await st.post('/api/confirm', { id });
      await st.until((x) => dev(x, id)?.job.state === 'done', 8000, 'done');
    } finally { await st.stop(); }
  });
});

describe('uploads and safety', () => {
  test('offline: report kept, uploaded later', async () => {
    const { st } = await fresh({ android: [{ ...SAMSUNG, serial: 'R58OFFLINE1', accounts: [] }] });
    const id = 'android:R58OFFLINE1';
    try {
      await st.until((s) => dev(s, id)?.info.accounts, 10000, 'phone');
      erp.down = true;
      await st.post('/api/erase', { ids: [id] });
      const d = await st.until((s) => { const x = dev(s, id); return x && x.job.state === 'done' && x; }, 20000, 'done offline');
      assert.equal(d.job.upload.ok, false);
      assert.equal((await st.state()).pending, 1);
      erp.down = false;
      await st.post('/api/retry-uploads', {});
      const s = await st.state();
      assert.equal(s.pending, 0);
      assert.equal(s.history[0].uploaded, true);
    } finally { erp.down = false; await st.stop(); }
  });

  test('only its own page can drive the station', async () => {
    const { st } = await fresh();
    try {
      assert.equal((await st.post('/api/job', { client_name: 'x' }, {})).status, 403, 'no custom header');
      assert.equal((await st.post('/api/job', { client_name: 'x' }, { 'X-TripleRe': '1', Origin: 'https://evil.example' })).status, 403);
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: st.port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
      });
      assert.equal(status, 403, 'DNS rebinding');
      assert.equal((await fetch(`${st.base}/../../etc/passwd`)).status, 404);
    } finally { await st.stop(); }
  });

  test('screens and assets never name the underlying tools', () => {
    for (const f of fs.readdirSync(path.join(PHONE, 'ui'))) {
      if (!/\.(html|js|css)$/.test(f)) continue;
      noToolNames(fs.readFileSync(path.join(PHONE, 'ui', f), 'utf8'), `ui/${f}`);
    }
    // Every Arabic/English message in the station source is checked too (log lines reach the screen).
    for (const f of fs.readdirSync(path.join(PHONE, 'src'))) {
      const src = fs.readFileSync(path.join(PHONE, 'src', f), 'utf8');
      for (const m of src.matchAll(/(['`])((?:(?!\1).)*[؀-ۿ](?:(?!\1).)*)\1/g)) noToolNames(m[2], `src/${f} message`);
    }
  });
});

test('licence lines helper produces a verifiable licence', () => {
  assert.equal(licenceLines(keys).length, 4);
});

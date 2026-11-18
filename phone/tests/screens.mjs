// Screenshots of every screen, driven like a technician would (clicks through Chrome DevTools),
// with simulated devices and the mock ERP. Usage: node phone/tests/screens.mjs <out-dir> [chrome-path]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { World, confText, mockErp, startStation, testKeys, tmpdir } from './helpers.mjs';

const OUT = path.resolve(process.argv[2] || 'screens');
const CHROME = process.argv[3] || process.env.CHROME
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    .find((p) => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(port) {
  let list;
  for (let i = 0; i < 50; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.find((t) => t.type === 'page')) break; } catch { /* starting */ }
    await sleep(200);
  }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    send,
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; },
    async shot(name) {
      await sleep(700);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('saved', name);
    },
    close() { ws.close(); },
  };
}

const keys = testKeys(tmpdir('keys'));
const erp = await mockErp(keys);
const data = tmpdir('screens');
const world = new World(data);
world.update((w) => { w.slowRestore = 900; });
const st = await startStation({ data, world, keys, erp });
const dbg = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--window-size=1280,860', '--hide-scrollbars',
  `--user-data-dir=${tmpdir('chrome')}`, '--no-first-run', '--lang=ar', `${st.base}/`], { stdio: 'ignore' });
const page = await cdp(dbg);
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
const click = (sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

try {
  await sleep(1500);
  await page.shot('1-licence-missing.png');

  fs.writeFileSync(path.join(data, 'upload.conf'), confText(erp, keys, { name: 'PC-Workshop-1' }));
  await sleep(1500);
  await page.shot('2-job-details.png');
  await page.eval(`(() => { document.querySelector('#client').value = 'Vodafone Egypt'; document.querySelector('#tech').value = 'Ahmed Samir'; document.querySelector('#wo').value = 'WO-2291'; document.querySelector('#job-form').requestSubmit(); })()`);
  await sleep(1500);
  await page.shot('3-no-devices.png');

  world.update((w) => {
    w.ios = [
      { udid: '00008030-001A2B3C4D5E602E', ecid: '001A2B3C4D5E602E', product: 'iPhone14,5', serial: 'F2LXK0AAN72J', imei: '356789012345678', mode: 'normal', paired: true, findMy: false, os: '17.5.1', capacity: 128e9 },
      { udid: '00008101-0011223344556677', ecid: '0011223344556677', product: 'iPhone12,1', serial: 'G6TZ1234Q1GH', imei: '353000111222333', mode: 'normal', paired: false, serialInSimple: false, os: '16.7' },
      { udid: '00008027-0099887766554433', ecid: '0099887766554433', product: 'iPad13,18', cls: 'iPad', serial: 'DMPXK9AAHP5V', mode: 'normal', paired: true, findMy: true, os: '18.0', capacity: 64e9 },
    ];
    w.android = [
      { serial: 'R58N123ABCD', state: 'device', model: 'SM-A546E', manufacturer: 'samsung', imei: '351234567890123', accounts: [] },
      { serial: 'RF8T90XYZ12', state: 'unauthorized', model: 'SM-G991B' },
    ];
  });
  await sleep(4000);
  for (const id of ['ios:001A2B3C4D5E602E', 'ios:0099887766554433', 'android:R58N123ABCD']) await click(`.check[data-id="${id}"]`);
  await page.shot('4-devices.png');

  await click('[data-act="erase"]');
  await page.shot('5-confirm.png');
  await page.eval(`document.querySelector('#ack').checked = true`);
  await click('#go-erase');
  await sleep(4500);
  await page.shot('6-progress.png');

  await sleep(14000);
  await page.shot('7-done.png');

  await click('[data-act="reports"]');
  await page.shot('8-reports.png');
  await click('[data-act="back"]');

  // A locked iPhone that must be put into Recovery with the buttons.
  world.update((w) => { w.ios[1].noAutoRecovery = true; });
  await click('.check[data-id="ios:0011223344556677"]');
  await click('[data-act="erase"]');
  await sleep(500);
  await page.eval(`document.querySelector('#ack').checked = true`);
  await click('#go-erase');
  await sleep(3500);
  await page.shot('9-recovery-steps.png');

  await click('[data-act="manual"]');
  await page.shot('10-locked-android.png');
} finally {
  page.close();
  chrome.kill();
  await st.stop();
  await erp.close();
}

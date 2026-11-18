// Connected devices and their erase jobs, shared by the iOS and Android parts and the screens.
import { nowIso } from './util.mjs';

/** @type {Map<string, any>} */
export const devices = new Map();

// Job states the screens know:
//   idle, preparing, waiting-unlock, waiting-recovery, downloading, erasing, rebooting,
//   awaiting-confirm, uploading, done, failed
export const BUSY = new Set(['preparing', 'waiting-recovery', 'downloading', 'erasing', 'rebooting', 'awaiting-confirm', 'uploading']);

export function device(id, init) {
  if (!devices.has(id)) {
    devices.set(id, { id, connected: true, firstSeen: nowIso(), info: {}, raw: {}, job: { state: 'idle', log: [] }, ...init });
  }
  const d = devices.get(id);
  d.connected = true;
  d.lastSeen = Date.now();
  return d;
}

export function log(d, msg) {
  d.job.log.push(`${new Date().toLocaleTimeString('en-GB')}  ${msg}`);
  if (d.job.log.length > 200) d.job.log.splice(0, d.job.log.length - 200);
  d.job.message = msg;
}

export function setState(d, state, msg) {
  d.job.state = state;
  if (msg) log(d, msg);
}

export function newJob(d) {
  d.job = { state: 'preparing', log: [], startedAt: nowIso(), progress: 0, step: '' };
  return d.job;
}

/** What the screens get: no raw tool dumps. */
export function publicDevice(d) {
  const { raw, proc, ...rest } = d;
  return rest;
}

/** Marks devices that disappeared; finished ones leave the list after a while. */
export function sweep(seen) {
  for (const d of devices.values()) {
    if (seen.has(d.id)) continue;
    d.connected = false;
    const gone = Date.now() - (d.lastSeen || 0);
    if (d.job.state === 'idle' && gone > 15000) devices.delete(d.id);
    else if (['done', 'failed'].includes(d.job.state) && gone > 10 * 60000) devices.delete(d.id);
  }
}

import { acquireToken, getNextAvailableDelayMs } from './auth.js';
import { settings } from './config.js';

const queue = [];
let dispatchTimer = null;

function scheduleDispatch() {
  if (dispatchTimer || queue.length === 0) return;
  const delay = getNextAvailableDelayMs();
  if (delay === null) return;
  dispatchTimer = setTimeout(() => {
    dispatchTimer = null;
    dispatchQueued();
  }, Math.max(25, delay));
}

export function enqueueRequest(timeoutMs = settings.queueTimeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = queue.findIndex(e => e.resolve === resolve);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error('Request timed out waiting for available token'));
    }, timeoutMs);

    const slot = acquireToken();
    if (slot) {
      clearTimeout(timer);
      resolve(slot);
      return;
    }

    if (queue.length >= settings.maxQueueSize) {
      clearTimeout(timer);
      reject(new Error('Too many queued requests'));
      return;
    }

    queue.push({ resolve: (slot) => { clearTimeout(timer); resolve(slot); }, reject: (err) => { clearTimeout(timer); reject(err); } });
    scheduleDispatch();
  });
}

export function dispatchQueued() {
  while (queue.length > 0) {
    const next = queue[0];
    const slot = acquireToken();
    if (!slot) break;
    queue.shift();
    next.resolve(slot);
  }
  scheduleDispatch();
}

export function getQueueInfo() {
  return { queued: queue.length, maxQueueSize: settings.maxQueueSize, timeoutMs: settings.queueTimeoutMs };
}

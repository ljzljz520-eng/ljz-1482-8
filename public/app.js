// 通用工具：API、设备身份、网络状态
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.status = res.status; err.code = data.error; err.data = data;
    throw err;
  }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const mmss = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};
export const hhmmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${mmss(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
};
export const time = (iso) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
export const datetime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-';

// 设备身份（持久，用于主持租约与离线确认去重）
export const clientId = (() => {
  let id = localStorage.getItem('fdr_clientId');
  if (!id) { id = 'dev_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('fdr_clientId', id); }
  return id;
})();

// 当前使用者（角色+姓名）
export function getIdentity() {
  try { return JSON.parse(localStorage.getItem('fdr_identity') || 'null'); } catch { return null; }
}
export function setIdentity(v) { localStorage.setItem('fdr_identity', JSON.stringify(v)); }

// 在线状态（真网络 + 服务器可达性）
export function bindConnectivity(onChange) {
  const fire = () => onChange(navigator.onLine);
  window.addEventListener('online', fire);
  window.addEventListener('offline', fire);
  let failStreak = 0;
  setInterval(async () => {
    if (!navigator.onLine) { fire(); return; }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (failStreak > 0) { failStreak = 0; fire(); }
    } catch { failStreak++; fire(); }
  }, 5000);
}

export const online = () => navigator.onLine;

// ---------- 离线确认队列 ----------
const QUEUE_KEY = 'fdr_offline_queue_v1';
export function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
export function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

export function queueConfirm(runId, payload) {
  const q = loadQueue();
  q.push({ id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    runId, payload: { ...payload, offline: true, localAt: new Date().toISOString() }, localAt: new Date().toISOString() });
  saveQueue(q);
}

export async function flushQueue(onItem) {
  const q = loadQueue();
  const remain = [];
  for (const item of q) {
    try {
      const out = await api(`/api/runs/${item.runId}/confirm`, { method: 'POST', body: item.payload });
      onItem?.(item, out, null);
    } catch (e) {
      if (e.status === 409 && e.code === 'already_confirmed') onItem?.(item, null, e);
      else remain.push(item); // 网络/服务端错误：继续保留，稍后重传
    }
  }
  saveQueue(remain);
  return remain.length;
}

export function toast(msg, kind = 'blue') {
  let box = $('#toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast';
    Object.assign(box.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 999, display: 'flex', flexDirection: 'column', gap: '8px' });
    document.body.appendChild(box); }
  const d = document.createElement('div');
  d.className = `banner ${kind}`;
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

if ('serviceWorker' in navigator && location.hostname !== '') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

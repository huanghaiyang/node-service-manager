import { reactive, computed } from 'vue';
import { api, subscribe } from './api.js';

const MAX_LOG_LINES = 800;

export const state = reactive({
  host: null,
  services: [],
  connected: false,
  loading: true,
  bootError: '',
  logs: {},          // serviceId -> 日志行数组
  toasts: [],
  lastSnapshotAt: 0,
});

let closeStream = null;
let reconnectTimer = null;

export const runningCount = computed(
  () => state.services.filter((s) => ['running', 'starting'].includes(s.state?.status)).length,
);

export const totals = computed(() => {
  let cpu = 0;
  let mem = 0;
  let procs = 0;
  for (const s of state.services) {
    if (!s.metrics) continue;
    cpu += s.metrics.cpuPercent || 0;
    mem += s.metrics.memoryBytes || 0;
    procs += s.metrics.processCount || 0;
  }
  return { cpu, mem, procs };
});

/* ------------------------------- 提示条 ---------------------------------- */

export function toast(message, kind = 'ok', ttl = 4200) {
  const id = Math.random().toString(36).slice(2);
  state.toasts.push({ id, message, kind });
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === id);
    if (i >= 0) state.toasts.splice(i, 1);
  }, ttl);
}

/* ------------------------------- 数据加载 -------------------------------- */

export async function refresh() {
  try {
    const data = await api.list();
    state.services = data.services || [];
    state.bootError = '';
  } catch (err) {
    state.bootError = err.message;
  } finally {
    state.loading = false;
  }
}

export async function loadLogs(id, limit = MAX_LOG_LINES) {
  try {
    const data = await api.logs(id, limit);
    state.logs[id] = (data.lines || []).slice(-MAX_LOG_LINES);
  } catch (err) {
    toast(`日志加载失败：${err.message}`, 'err');
  }
}

function appendLog(entry) {
  const id = entry.serviceId;
  if (!id) return;
  if (!state.logs[id]) state.logs[id] = [];
  const arr = state.logs[id];
  arr.push(entry);
  if (arr.length > MAX_LOG_LINES) arr.splice(0, arr.length - MAX_LOG_LINES);
}

export function clearLogs(id) {
  state.logs[id] = [];
}

export function forgetLogs(id) {
  delete state.logs[id];
}

/* ------------------------------- 连接管理 -------------------------------- */

export function connect() {
  if (closeStream) closeStream();
  closeStream = subscribe({
    open: () => {
      state.connected = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    },
    error: () => {
      state.connected = false;
    },
    snapshot: (payload) => {
      if (!payload) return;
      state.connected = true;
      state.host = payload.host;
      state.lastSnapshotAt = payload.ts;
      state.services = payload.services || [];
      state.loading = false;
    },
    log: (entry) => {
      if (entry) appendLog(entry);
    },
    servicesChanged: () => {
      refresh();
    },
  });
}

export function disconnect() {
  if (closeStream) { closeStream(); closeStream = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

/* ------------------------------- 动作封装 -------------------------------- */

/** 统一处理动作 → 提示 → 刷新 的样板 */
export async function run(action, { okMessage, id } = {}) {
  try {
    await action();
    if (okMessage) toast(okMessage, 'ok');
    if (id) await loadLogs(id);
    return true;
  } catch (err) {
    toast(err.message || String(err), 'err', 6000);
    return false;
  } finally {
    refresh();
  }
}

export const actions = {
  start: (svc) => run(() => api.start(svc.id), { okMessage: `已启动 ${svc.name}`, id: svc.id }),
  stop: (svc) => run(() => api.stop(svc.id), { okMessage: `已停止 ${svc.name}` }),
  forceStop: (svc) => run(() => api.stop(svc.id, true), { okMessage: `已强制停止 ${svc.name}` }),
  restart: (svc) => run(() => api.restart(svc.id), { okMessage: `已重启 ${svc.name}`, id: svc.id }),
  killOrphan: (svc) => run(() => api.killOrphan(svc.id), { okMessage: `已终止 ${svc.name} 的残留进程` }),
  remove: (svc) => run(() => { forgetLogs(svc.id); return api.remove(svc.id, true); }, { okMessage: `已移除 ${svc.name}` }),
  startAll: () => run(() => api.startAll(), { okMessage: '已批量启动' }),
  stopAll: () => run(() => api.stopAll(), { okMessage: '已批量停止' }),
};

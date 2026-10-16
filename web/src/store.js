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
  /** 顶栏徽标用的 node 进程汇总（随 SSE 快照更新） */
  nodeSummary: { total: 0, managed: 0, source: 'none' },
  /** Node 进程检测器面板 */
  processPanel: {
    open: false,
    loading: false,
    error: '',
    data: null,
    autoRefresh: true,
    lastLoadedAt: 0,
  },
  /** 端口冲突弹窗上下文；非空即表示弹窗打开 */
  portConflict: null,
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
      state.nodeSummary = payload.nodeSummary || state.nodeSummary;
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

/* ---------------------------- Node 进程检测器 ----------------------------- */

export async function loadNodeProcesses({ refresh = false, silent = false } = {}) {
  if (!silent) state.processPanel.loading = true;
  state.processPanel.error = '';
  try {
    const data = await api.nodeProcesses(refresh);
    state.processPanel.data = data;
    state.processPanel.lastLoadedAt = Date.now();
    // 面板与顶栏徽标保持一致
    state.nodeSummary = { total: data.total, managed: data.managedCount, source: data.enumerateSource };
  } catch (err) {
    state.processPanel.error = err.message;
  } finally {
    state.processPanel.loading = false;
  }
}

const PANEL_STORAGE_KEY = 'sm.processPanel';

export function initProcessPanel() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) || '{}');
    if (typeof saved.open === 'boolean') state.processPanel.open = saved.open;
    if (typeof saved.autoRefresh === 'boolean') state.processPanel.autoRefresh = saved.autoRefresh;
  } catch { /* 忽略损坏的本地存储 */ }
}

export function persistProcessPanel() {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
      open: state.processPanel.open,
      autoRefresh: state.processPanel.autoRefresh,
    }));
  } catch { /* 忽略隐私模式下的写入失败 */ }
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

/** 真正执行启动（带可选端口覆盖） */
export async function launchService(svc, { port = null, persistPort = false } = {}) {
  try {
    const res = await api.start(svc.id, {
      ...(Number.isInteger(port) && port > 0 ? { port, persistPort } : {}),
    });
    const applied = res?.appliedPort;
    toast(applied && applied !== svc.port ? `${svc.name} 已启动（端口 ${applied}）` : `已启动 ${svc.name}`, 'ok');
    state.portConflict = null;
    await loadLogs(svc.id);
    return true;
  } catch (err) {
    toast(err.message || String(err), 'err', 7000);
    return false;
  } finally {
    refresh();
  }
}

/**
 * 启动服务：先做端口预检。
 * 预检本身失败（例如网络抖动）不应该拦住启动，直接放行。
 * 只有「确认端口被占用」时才弹出冲突对话框。
 */
export async function startService(svc) {
  let info = null;
  try {
    info = await api.preflight(svc.id);
  } catch {
    info = null;
  }
  if (info?.checked && info.occupied) {
    state.portConflict = { service: svc, info };
    return false;
  }
  return launchService(svc);
}

export const actions = {
  start: (svc) => startService(svc),
  stop: (svc) => run(() => api.stop(svc.id), { okMessage: `已停止 ${svc.name}` }),
  forceStop: (svc) => run(() => api.stop(svc.id, true), { okMessage: `已强制停止 ${svc.name}` }),
  restart: (svc) => run(() => api.restart(svc.id), { okMessage: `已重启 ${svc.name}`, id: svc.id }),
  killOrphan: (svc) => run(() => api.killOrphan(svc.id), { okMessage: `已终止 ${svc.name} 的残留进程` }),
  remove: (svc) => run(() => { forgetLogs(svc.id); return api.remove(svc.id, true); }, { okMessage: `已移除 ${svc.name}` }),
  startAll: () => run(() => api.startAll(), { okMessage: '已批量启动' }),
  stopAll: () => run(() => api.stopAll(), { okMessage: '已批量停止' }),
};

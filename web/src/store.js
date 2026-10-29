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
  /** 批量启动时被端口冲突拦下的清单；非空即表示要展示冲突汇总 */
  batchConflicts: [],
  /** 底部「活动实时输出」面板 */
  activityPanel: {
    open: true,
    height: 280,
    paused: false,
  },
  /** 跨服务的全局活动流（最近 MAX_ACTIVITY_LINES 行） */
  activity: [],
  /** 面板收起时新到的行数 */
  activityUnread: 0,
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

/* ---------------------------- 活动实时输出流 ------------------------------ */

const MAX_ACTIVITY_LINES = 400;

/**
 * 统一活动行形状。key 只用于「服务端回填快照」与「SSE 实时行」的合并去重，
 * 不参与界面展示；服务端快照与实时流可能包含同一行（打开页面瞬间的竞态）。
 */
function normalizeActivity(entry) {
  const ts = entry?.ts || new Date().toISOString();
  const serviceId = entry?.serviceId || null;
  const stream = entry?.stream || 'system';
  const text = String(entry?.text ?? '');
  return {
    key: `${serviceId || 'manager'}|${ts}|${stream}|${text}`,
    serviceId,
    ts,
    stream,
    text,
  };
}

/** 追加一行实时活动；面板暂停时不入缓冲（恢复时用服务端快照补齐） */
export function appendActivity(entry) {
  if (!entry || state.activityPanel.paused) return;
  const arr = state.activity;
  arr.push(normalizeActivity(entry));
  if (arr.length > MAX_ACTIVITY_LINES) arr.splice(0, arr.length - MAX_ACTIVITY_LINES);
  if (!state.activityPanel.open) state.activityUnread += 1;
}

/**
 * 合并服务端快照与实时流：
 *  - 快照覆盖同一行的实时副本（按 key 计数一一抵消，避免重复）；
 *  - 快照生成之后才到的实时行保留；
 *  - 整体按时间升序重排，保证全局时间线不会因合并而错乱。
 */
function mergeActivity(snapshot) {
  const remaining = new Map();
  for (const line of snapshot) remaining.set(line.key, (remaining.get(line.key) || 0) + 1);
  const extra = [];
  for (const line of state.activity) {
    const n = remaining.get(line.key) || 0;
    if (n > 0) {
      remaining.set(line.key, n - 1);
      continue;
    }
    extra.push(line);
  }
  return [...snapshot, ...extra]
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(-MAX_ACTIVITY_LINES);
}

/** 拉取所有服务的近期日志作为活动面板的初始内容 */
export async function loadActivity(limit = MAX_ACTIVITY_LINES) {
  try {
    const data = await api.activity(limit);
    const snapshot = (data.lines || []).map(normalizeActivity);
    state.activity = mergeActivity(snapshot);
    state.activityUnread = 0;
  } catch (err) {
    toast(`活动输出载入失败：${err.message}`, 'err');
  }
}

/** 只清空面板缓冲区，不动各服务落盘的日志文件 */
export function clearActivity() {
  state.activity = [];
  state.activityUnread = 0;
}

const ACTIVITY_STORAGE_KEY = 'sm.activityPanel';

export function initActivityPanel() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) || '{}');
    if (typeof saved.open === 'boolean') state.activityPanel.open = saved.open;
    const h = Number(saved.height);
    if (Number.isFinite(h) && h >= 160 && h <= 900) state.activityPanel.height = h;
  } catch { /* 忽略损坏的本地存储 */ }
}

export function persistActivityPanel() {
  try {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify({
      open: state.activityPanel.open,
      height: state.activityPanel.height,
    }));
  } catch { /* 忽略隐私模式下的写入失败 */ }
}

/* ------------------------------- 连接管理 -------------------------------- */

export function connect() {
  if (closeStream) closeStream();
  closeStream = subscribe({
    open: () => {
      const wasConnected = state.connected;
      state.connected = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (!wasConnected) {
        appendActivity({ stream: 'system', text: '实时通道已连接，开始接收活动输出' });
      }
    },
    error: () => {
      if (state.connected) {
        appendActivity({ stream: 'stderr', text: '实时通道断开，正在自动重连…' });
      }
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
      if (!entry) return;
      appendLog(entry);
      appendActivity(entry);
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

/**
 * 服务因端口冲突崩溃后，用后端诊断出的占用信息直接打开换端口对话框。
 * 这样「后端起不来」不再需要用户自己去 netstat 找原因。
 */
export function openPortConflictForHint(svc) {
  const hint = svc?.portConflictHint;
  if (!hint) return;
  state.portConflict = {
    service: svc,
    info: {
      checked: true,
      occupied: true,
      port: hint.port,
      occupants: hint.occupants || [],
      suggestion: hint.suggestion,
      fromCrash: true,
      message: hint.message,
    },
  };
}

/**
 * 批量启动：后端会先算端口冲突，把「注定会崩」的服务拦下来并返回冲突清单。
 * 这里负责把结果讲清楚 —— 尤其是别让用户以为「全部启动成功了」。
 */
export async function startAllServices() {
  try {
    const res = await api.startAll();
    const conflicts = res?.conflicts || [];
    const started = res?.started ?? (res?.results || []).filter((r) => r.ok).length;
    const failed = res?.failed ?? 0;
    if (conflicts.length) {
      state.batchConflicts = conflicts;
      toast(
        `已启动 ${started} 个；${conflicts.length} 个因端口冲突被拦下${failed ? `；${failed} 个启动失败` : ''}`,
        'err',
        8000,
      );
    } else if (started) {
      toast(`已批量启动 ${started} 个服务${failed ? `（${failed} 个失败）` : ''}`, failed ? 'err' : 'ok');
    } else {
      toast('没有需要启动的服务', 'ok');
    }
    return res;
  } catch (err) {
    toast(err.message || String(err), 'err', 7000);
    return null;
  } finally {
    refresh();
  }
}

export const actions = {
  start: (svc) => startService(svc),
  stop: (svc) => run(() => api.stop(svc.id), { okMessage: `已停止 ${svc.name}` }),
  forceStop: (svc) => run(() => api.stop(svc.id, true), { okMessage: `已强制停止 ${svc.name}` }),
  restart: (svc) => run(() => api.restart(svc.id), { okMessage: `已重启 ${svc.name}`, id: svc.id }),
  killOrphan: (svc) => run(() => api.killOrphan(svc.id), { okMessage: `已终止 ${svc.name} 的残留进程` }),
  adopt: (svc) => run(
    () => api.adopt(svc.id, svc.state?.pid || svc.state?.externalHint?.pid || null),
    { okMessage: `已接管 ${svc.name} 的外部进程`, id: svc.id },
  ),
  scanExternal: () => run(() => api.scanExternal(), { okMessage: '已扫描外部运行的进程' }),
  remove: (svc) => run(() => { forgetLogs(svc.id); return api.remove(svc.id, true); }, { okMessage: `已移除 ${svc.name}` }),
  startAll: () => startAllServices(),
  stopAll: () => run(() => api.stopAll(), { okMessage: '已批量停止' }),
};

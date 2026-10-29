const BASE = import.meta.env.VITE_API_BASE || '';

async function request(path, { method = 'GET', body, query } = {}) {
  let url = `${BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw Object.assign(new Error(`无法连接治理服务端：${err.message}`), { code: 'NETWORK' });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    throw Object.assign(new Error(json?.message || `请求失败（HTTP ${res.status}）`), {
      code: json?.code || `HTTP_${res.status}`,
      status: res.status,
    });
  }
  return json;
}

export const api = {
  health: () => request('/api/health'),
  system: () => request('/api/system'),

  list: () => request('/api/services'),
  get: (id) => request(`/api/services/${id}`),
  create: (payload) => request('/api/services', { method: 'POST', body: payload }),
  update: (id, patch) => request(`/api/services/${id}`, { method: 'PATCH', body: patch }),
  remove: (id, force = true) => request(`/api/services/${id}`, { method: 'DELETE', query: { force } }),

  start: (id, opts = {}) => request(`/api/services/${id}/start`, { method: 'POST', body: opts }),
  stop: (id, force = false) => request(`/api/services/${id}/stop`, { method: 'POST', body: { force } }),
  restart: (id, opts = {}) => request(`/api/services/${id}/restart`, { method: 'POST', body: opts }),
  killOrphan: (id) => request(`/api/services/${id}/kill-orphan`, { method: 'POST', body: {} }),
  /** 接管「外部运行中」的进程，纳入托管（弱信号下需显式给出 pid） */
  adopt: (id, pid) => request(`/api/services/${id}/adopt`, { method: 'POST', body: pid ? { pid } : {} }),
  /** 立即触发一次外部运行探测 */
  scanExternal: () => request('/api/external/scan', { method: 'POST', body: {} }),
  /** 开机自启动状态 / 开关（dryRun 只预览会写什么，不动系统） */
  autostart: () => request('/api/autostart'),
  setAutostart: (enabled, dryRun = false) => request('/api/autostart', {
    method: 'POST',
    body: dryRun ? { enabled, dryRun: true } : { enabled },
  }),
  /** 全局设置 */
  getSettings: () => request('/api/settings'),
  patchSettings: (patch) => request('/api/settings', { method: 'PATCH', body: patch }),
  /** 手动恢复「上次在运行」的服务（与开机自启动同一套逻辑） */
  restoreServices: () => request('/api/services/restore', { method: 'POST', body: {} }),
  /** 任务栏托盘 */
  getTray: () => request('/api/tray'),
  setTray: (enabled) => request('/api/tray', { method: 'POST', body: { enabled } }),
  plan: (id) => request(`/api/services/${id}/plan`),
  /** 启动前端口预检：目标端口是否被占用、占用者是谁、随机可用端口 */
  preflight: (id, port) => request(`/api/services/${id}/preflight`, { query: { port } }),

  /** Node 进程检测器 */
  nodeProcesses: (refresh = false) => request('/api/processes/node', { query: { refresh: refresh ? 1 : undefined } }),

  startAll: () => request('/api/services/start-all', { method: 'POST', body: {} }),
  stopAll: () => request('/api/services/stop-all', { method: 'POST', body: {} }),

  logs: (id, limit = 800) => request(`/api/services/${id}/logs`, { query: { limit } }),
  clearLogs: (id) => request(`/api/services/${id}/logs`, { method: 'DELETE' }),
  /** 底部活动面板回填：聚合所有服务的近期日志 */
  activity: (limit = 400) => request('/api/activity', { query: { limit } }),

  roots: () => request('/api/fs/roots'),
  listDir: (path) => request('/api/fs/list', { query: { path } }),
  analyze: (packageJsonPath) => request('/api/package/analyze', { method: 'POST', body: { packageJsonPath } }),
  scan: (dir, depth = 2) => request('/api/scan', { method: 'POST', body: { dir, depth } }),
};

/** SSE 订阅，返回关闭函数 */
export function subscribe(handlers) {
  const es = new EventSource(`${BASE}/api/events`);
  const bind = (name) => (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { /* ignore */ }
    handlers[name]?.(data);
  };
  es.addEventListener('hello', bind('hello'));
  es.addEventListener('snapshot', bind('snapshot'));
  es.addEventListener('log', bind('log'));
  es.addEventListener('status', bind('status'));
  es.addEventListener('services-changed', bind('servicesChanged'));
  es.onopen = () => handlers.open?.();
  es.onerror = () => handlers.error?.();
  return () => es.close();
}

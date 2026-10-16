import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORT, HOST, SAMPLE_INTERVAL_MS, PORT_SAMPLE_INTERVAL_MS, ensureDirs, ROOT_DIR, DATA_DIR,
} from './config.js';
import { ServiceStore } from './store.js';
import { LogStore } from './logs.js';
import { ProcessManager, STATUS, buildLaunchPlan } from './pm.js';
import { ProcessSampler } from './metrics.js';
import { PortScanner } from './ports.js';
import {
  analyzePackage, listDirectory, listDriveRoots, scanForPackages, PackageJsonError,
} from './packageScanner.js';
import { displayName, formatBytes } from './util.js';

const DIST_DIR = path.resolve(fileURLToPath(new URL('../../dist', import.meta.url)));

/* ------------------------------- 基础设施 --------------------------------- */

ensureDirs();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// 仅本机使用，放开本地来源即可（Vite dev server 与生产同源都覆盖）
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

const store = new ServiceStore().load();
const logs = new LogStore((entry) => {
  broadcast('log', entry);
});
const pm = new ProcessManager(store, logs);
const sampler = new ProcessSampler();
const portScanner = new PortScanner();

/** 每个服务的指标历史，用于前端 sparkline */
const HISTORY_LEN = 60;
const history = new Map();
const lastMetrics = new Map();

function pushHistory(id, point) {
  let h = history.get(id);
  if (!h) {
    h = { ts: [], cpu: [], memory: [] };
    history.set(id, h);
  }
  h.ts.push(point.ts);
  h.cpu.push(Number(point.cpuPercent.toFixed(2)));
  h.memory.push(point.memoryBytes);
  if (h.ts.length > HISTORY_LEN) {
    h.ts.shift();
    h.cpu.shift();
    h.memory.shift();
  }
  return h;
}

/* ----------------------------- 视图 & 采样 -------------------------------- */

function serviceView(svc, { withHistory = true } = {}) {
  const state = pm.stateOf(svc.id);
  const metrics = lastMetrics.get(svc.id) || null;
  // 端口/入口是「活数据」：没有存活进程就必须为空。
  // 否则停止后到下一个采样周期之间（最多 3s）界面会继续声称服务在监听某个端口。
  const live = Boolean(state.pid);
  const ports = live ? (metrics?.ports || []) : [];
  const entry = resolveEntry(svc, { ports });
  return {
    ...svc,
    state,
    metrics: live ? metrics : null,
    ports,
    entry: {
      url: entry.url,
      source: entry.source,
      // 该入口是否来自真实探测（false 表示端口还没 bind，或只是配置声明）
      live: entry.source === 'detected',
    },
    portScan: {
      provider: portScanner.provider,
      providerLabel: portScanner.providerLabel,
      warning: portScanner.warning,
      sampledAt: portScanner.sampledAt ? new Date(portScanner.sampledAt).toISOString() : null,
    },
    history: withHistory ? (history.get(svc.id) || { ts: [], cpu: [], memory: [] }) : undefined,
    logBytes: logs.state.get(svc.id)?.bytes || { out: 0, err: 0 },
    managed: true,
  };
}

let sampling = false;
let lastPortSampledAt = 0;

/**
 * 解析服务的浏览器入口地址。
 *   1. 配置里显式填了入口地址 → 直接用（例如 https、内网域名、带路径的健康页）
 *   2. 否则取探测到的 TCP 监听端口（优先配置声明的那个）
 *   3. 服务未起来、端口还没 bind 时，退化为声明端口，保证「即将可用」的入口仍可点
 */
function resolveEntry(svc, { ports = [] } = {}) {
  if (svc.entryUrl) return { url: svc.entryUrl, source: 'override' };
  const tcp = ports.filter((p) => p.proto === 'tcp');
  const preferred = svc.port ? tcp.find((p) => p.port === svc.port) : null;
  const primary = preferred || tcp[0];
  if (primary) return { url: `http://127.0.0.1:${primary.port}/`, source: 'detected', port: primary.port };
  if (svc.port) return { url: `http://127.0.0.1:${svc.port}/`, source: 'declared', port: svc.port };
  return { url: '', source: 'none' };
}

async function sampleOnce() {
  if (sampling) return null;
  sampling = true;
  try {
    const roots = [];
    for (const svc of store.list()) {
      const st = pm.stateOf(svc.id);
      if (st.pid) roots.push({ id: svc.id, pid: st.pid });
    }
    const snapshot = await sampler.sample(roots.map((r) => r.pid));
    const ts = snapshot.ts;

    // 监听端口：比指标采样慢一档刷新；一次刷新覆盖所有服务
    if (roots.length && ts - lastPortSampledAt >= PORT_SAMPLE_INTERVAL_MS) {
      lastPortSampledAt = ts;
      await portScanner.refresh().catch(() => { /* 探测失败就沿用上一轮结果 */ });
    }

    for (const { id, pid } of roots) {
      const agg = sampler.aggregate(snapshot, pid);
      agg.sampledAt = new Date(ts).toISOString();
      // 端口按「该服务实际归属的进程集合」取（进程树支持时含子进程）
      agg.ports = portScanner.pick(agg.processes.map((p) => p.pid));
      // 再逐个进程标出它自己监听的端口：monorepo 里一眼看出哪个子进程起了、占哪个端口
      for (const proc of agg.processes) {
        const own = portScanner.pick([proc.pid]);
        if (own.length) proc.ports = own;
      }
      lastMetrics.set(id, agg);
      pushHistory(id, { ts, ...agg });
    }
    for (const svc of store.list()) {
      if (!roots.some((r) => r.id === svc.id)) {
        lastMetrics.delete(svc.id);
      }
    }
    return { ts, host: sampler.hostMetrics(), snapshot };
  } finally {
    sampling = false;
  }
}

async function snapshotPayload() {
  const host = sampler.hostMetrics();
  const services = store.list().map((s) => serviceView(s));
  // 顶栏徽标用的轻量汇总（复用检测器的缓存，不额外采集）
  const nodeSummary = await (async () => {
    try {
      const listing = await sampler.listNodeProcesses({ ttlMs: 8000 });
      let managed = 0;
      for (const row of listing.rows) if (managedMatchFor(row.pid)) managed += 1;
      return { total: listing.rows.length, managed, source: listing.source };
    } catch {
      return { total: 0, managed: 0, source: 'none' };
    }
  })();
  return {
    ts: Date.now(),
    host,
    nodeSummary,
    services,
  };
}

/** 采样并推送 */
let sampleTimer = null;

/* --------------------------- Node 进程检测器 ------------------------------ */

/** 该 pid 是否属于某个已托管服务（根进程或进程树成员） */
function managedMatchFor(pid) {
  for (const svc of store.list()) {
    const st = pm.stateOf(svc.id);
    if (st.pid === pid) return { serviceId: svc.id, serviceName: svc.name, matchedBy: 'pid', role: 'root' };
  }
  for (const svc of store.list()) {
    const members = lastMetrics.get(svc.id)?.processes;
    if (members?.some((p) => p.pid === pid)) {
      return { serviceId: svc.id, serviceName: svc.name, matchedBy: 'pid', role: 'member' };
    }
  }
  return null;
}

/** 服务根目录（归一化），用于按命令行/工作目录反查归属 */
function managedRoots() {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return store.list().map((svc) => ({
    id: svc.id,
    name: svc.name,
    roots: [norm(svc.cwd), norm(svc.root)].filter(Boolean),
  }));
}

/** 从命令行里找出它属于哪个托管服务（用于识别不是我们直接拉起的子进程） */
function matchByCommandLine(commandLine) {
  if (!commandLine) return null;
  const hay = String(commandLine).replace(/\\/g, '/').toLowerCase();
  let best = null;
  for (const svc of managedRoots()) {
    for (const root of svc.roots) {
      if (root && hay.includes(root) && (!best || root.length > best.len)) {
        best = { serviceId: svc.id, serviceName: svc.name, matchedBy: 'commandline', role: 'related', len: root.length };
      }
    }
  }
  if (!best) return null;
  return { serviceId: best.serviceId, serviceName: best.serviceName, matchedBy: best.matchedBy, role: best.role };
}

/** 组装 node 进程列表（优先复用常规采样结果，降级时才单独枚举） */
async function buildNodeProcessList({ details = null, force = false } = {}) {
  const listing = await sampler.listNodeProcesses({ force });
  const list = [];
  for (const row of listing.rows) {
    const match = managedMatchFor(row.pid)
      || matchByCommandLine(details?.get(row.pid)?.commandLine)
      || null;
    list.push({
      pid: row.pid,
      ppid: row.ppid || 0,
      name: row.name || 'node',
      memoryBytes: row.rss || 0,
      cpuPercent: ((listing.cpuByPid.get(row.pid) || 0) / (listing.cores || 1)) * 100,
      cpuPercentPerCore: (listing.cpuByPid.get(row.pid) || 0) * 100,
      ports: portScanner.pick([row.pid]),
      commandLine: details?.get(row.pid)?.commandLine ?? null,
      exePath: details?.get(row.pid)?.exePath ?? null,
      startedAt: details?.get(row.pid)?.startedAt ?? null,
      managed: Boolean(match),
      ...(match || { serviceId: null, serviceName: null, matchedBy: null, role: null }),
    });
  }
  list.sort((a, b) => Number(b.managed) - Number(a.managed) || b.memoryBytes - a.memoryBytes);
  return { list, source: listing.source };
}

/**
 * 服务刚 spawn 时补采一次，尽量让卡片在「启动中」就能显示内存与进程数，
 * 不必干等下一个采样周期（默认 3s）。若此刻常规采样正在进行，本次会被跳过，
 * 由下一个常规周期兜住——最坏情况即退回原来的行为。
 */
let quickSampleTimer = null;
function scheduleQuickSample(delay = 900) {
  if (quickSampleTimer) return;
  quickSampleTimer = setTimeout(async () => {
    quickSampleTimer = null;
    try {
      await sampleOnce();
      broadcast('snapshot', await snapshotPayload());
    } catch { /* 下一轮常规采样会兜住 */ }
  }, delay);
  if (quickSampleTimer.unref) quickSampleTimer.unref();
}

pm.on('status', (id, st) => {
  if (!st) return;
  // 终止态：立即丢弃该服务的指标与端口快照，不必等下一个采样周期
  if ([STATUS.STOPPED, STATUS.EXITED, STATUS.CRASHED].includes(st.status)) {
    lastMetrics.delete(id);
  }
  // 进程一旦 spawn 就补采（此时内存/进程数已经有意义），不必等到 RUNNING 提升
  if (st.status === STATUS.STARTING || st.status === STATUS.RUNNING) scheduleQuickSample(900);
});

function startSamplingLoop() {
  const tick = async () => {
    try {
      await sampleOnce();
      broadcast('snapshot', await snapshotPayload());
    } catch (err) {
      console.error('[metrics] 采样失败:', err.message);
    }
  };
  sampleTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
  if (sampleTimer.unref) sampleTimer.unref();
  setTimeout(tick, 300).unref?.();
}

/* ------------------------------ 工具函数 ---------------------------------- */

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const code = err.code || 'INTERNAL';
    const status = code === 'NOT_FOUND' ? 404
      : code === 'ALREADY_RUNNING' || code === 'ORPHANED' ? 409
        : ['INVALID_PACKAGE_JSON', 'EMPTY_PATH', 'PATH_NOT_FOUND', 'PACKAGE_NOT_FOUND', 'NOT_PACKAGE_JSON',
          'PARSE_FAILED', 'NO_SCRIPT', 'NO_ENTRY', 'SCRIPT_NOT_FOUND', 'NO_COMMAND', 'BAD_REQUEST'].includes(code) ? 400
          : 500;
    if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ ok: false, code, message: err.message });
  });
};

function requireService(req) {
  const svc = store.get(req.params.id);
  if (!svc) throw Object.assign(new Error('服务不存在'), { code: 'NOT_FOUND' });
  return svc;
}

/* -------------------------------- 路由 ------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: 'service-manager',
    version: '1.0.0',
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    dataDir: DATA_DIR,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    sseClients: sseClients.size,
    time: new Date().toISOString(),
  });
});

app.get('/api/system', wrap(async (req, res) => {
  res.json({ ok: true, host: sampler.hostMetrics() });
}));

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  sseClients.add(res);

  snapshotPayload()
    .then((payload) => {
      try { res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* ignore */ }
    })
    .catch(() => {});

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);
  if (keepAlive.unref) keepAlive.unref();

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

/* ---- 服务列表 / 增删改 ---- */

app.get('/api/services', wrap(async (req, res) => {
  res.json({ ok: true, services: store.list().map((s) => serviceView(s)) });
}));

app.post('/api/services', wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.packageJsonPath) {
    throw Object.assign(new Error('缺少 packageJsonPath'), { code: 'BAD_REQUEST' });
  }
  const info = analyzePackage(body.packageJsonPath);

  const existing = store.findBypackageJson(info.packageJsonPath);
  if (existing && body.allowDuplicate !== true) {
    throw Object.assign(new Error(`该 package.json 已被服务「${existing.name}」托管`), { code: 'BAD_REQUEST' });
  }

  const script = body.script || info.recommendedScript || '';
  const runtime = body.runtime || (script ? 'npm' : (info.entry ? 'node' : 'npm'));
  if (runtime === 'npm' && !script) {
    throw Object.assign(new Error('该 package.json 没有可用的启动 script，请改用「直接 node 启动」并确认存在入口文件'), { code: 'NO_SCRIPT' });
  }
  if (runtime === 'node' && !info.entry) {
    throw Object.assign(new Error('未能识别入口文件，请改用 npm script 或自定义命令'), { code: 'NO_ENTRY' });
  }

  const svc = store.add({
    name: body.name || displayName(info.name, info.root),
    packageJsonPath: info.packageJsonPath,
    root: info.root,
    runtime,
    script,
    command: body.command || '',
    args: Array.isArray(body.args) ? body.args : [],
    env: body.env && typeof body.env === 'object' ? body.env : {},
    cwd: body.cwd || info.root,
    port: body.port ?? null,
    entryUrl: body.entryUrl || '',
    autoRestart: Boolean(body.autoRestart),
    description: body.description || info.description || '',
    nodeVersion: info.engines?.node || '',
  });

  logs.append(svc.id, `已纳入托管：${svc.name}（${info.packageJsonPath}）`, 'system');
  broadcast('status', { serviceId: svc.id, state: pm.stateOf(svc.id) });
  broadcast('services-changed', { action: 'add', id: svc.id });

  const view = serviceView(svc);
  if (body.autoStart) {
    try {
      await pm.start(svc.id);
      view.state = pm.stateOf(svc.id);
    } catch (err) {
      view.startError = err.message;
    }
  }
  res.status(201).json({ ok: true, service: view, packageInfo: info });
}));

app.get('/api/services/:id', wrap(async (req, res) => {
  const svc = requireService(req);
  res.json({ ok: true, service: serviceView(svc) });
}));

app.patch('/api/services/:id', wrap(async (req, res) => {
  const svc = requireService(req);
  const st = pm.stateOf(svc.id);
  if (st.status === STATUS.RUNNING || st.status === STATUS.STARTING) {
    throw Object.assign(new Error('请先停止服务再修改配置'), { code: 'BAD_REQUEST' });
  }
  const patch = {};
  for (const key of ['name', 'script', 'runtime', 'command', 'args', 'env', 'cwd', 'autoRestart', 'description', 'entryUrl']) {
    if (key in req.body) patch[key] = req.body[key];
  }
  if ('port' in req.body) patch.port = req.body.port;
  const updated = store.update(svc.id, patch);
  broadcast('services-changed', { action: 'update', id: svc.id });
  res.json({ ok: true, service: serviceView(updated) });
}));

app.delete('/api/services/:id', wrap(async (req, res) => {
  const svc = requireService(req);
  const st = pm.stateOf(svc.id);
  const force = req.query.force === 'true' || req.query.force === '1';
  if (st.pid && !force) {
    throw Object.assign(new Error('服务正在运行，请先停止，或使用 force=true 一并终止'), { code: 'ALREADY_RUNNING' });
  }
  if (st.pid) {
    await pm.stop(svc.id, { force: true }).catch(() => {});
  }
  store.remove(svc.id);
  logs.release(svc.id);
  history.delete(svc.id);
  lastMetrics.delete(svc.id);
  broadcast('services-changed', { action: 'remove', id: svc.id });
  res.json({ ok: true, removed: svc.id });
}));

/* ---- 生命周期控制 ---- */

/**
 * 启动前预检：目标端口是否已被占用。
 * 只在服务未运行时才有意义（服务自己在跑时它的端口当然「被占用」）。
 * 端口来源优先级：显式 ?port > 服务配置 port > 上次实际探测到的 TCP 端口。
 */
app.get('/api/services/:id/preflight', wrap(async (req, res) => {
  const svc = requireService(req);
  const st = pm.stateOf(svc.id);
  const explicit = Number(req.query.port);
  const detected = (lastMetrics.get(svc.id)?.ports || []).filter((p) => p.proto === 'tcp');
  const candidate = Number.isInteger(explicit) && explicit > 0 ? explicit
    : (svc.port || detected[0]?.port || null);

  if (!candidate) {
    res.json({
      ok: true,
      checked: false,
      reason: 'no-port',
      message: '未配置端口，且上一次运行未探测到监听端口，无法预检',
      serviceId: svc.id,
    });
    return;
  }
  if (st.pid) {
    res.json({
      ok: true,
      checked: false,
      reason: 'running',
      port: candidate,
      message: '服务已在运行，跳过端口预检',
      serviceId: svc.id,
    });
    return;
  }

  const inspection = await portScanner.inspectPort(candidate);
  if (!inspection.occupied) {
    res.json({ ok: true, ...inspection, serviceId: svc.id, occupants: [] });
    return;
  }

  // 占用者信息：PID → 进程名，并判断是不是另一个被托管服务
  const names = await sampler.resolveProcessNames((inspection.occupants || []).map((o) => o.pid)).catch(() => new Map());
  const occupants = (inspection.occupants || []).map((o) => {
    const snapRow = sampler.lastSnapshot?.processes.get(o.pid);
    const owner = managedMatchFor(o.pid);
    return {
      pid: o.pid,
      port: o.port,
      address: o.address,
      proto: o.proto,
      name: names.get(o.pid) || snapRow?.name || null,
      memoryBytes: snapRow?.rss || 0,
      commandLine: null,
      managedServiceId: owner?.serviceId || null,
      managedServiceName: owner?.serviceName || null,
    };
  });

  // 补上占用者的命令行（一次针对性查询，失败就算了）
  try {
    const nodePids = occupants.filter((o) => /^node(\.exe)?$/i.test(o.name || '')).map((o) => o.pid);
    if (nodePids.length) {
      const details = await sampler.queryNodeProcessDetails({ pids: nodePids });
      for (const o of occupants) o.commandLine = details.get(o.pid)?.commandLine || null;
    }
  } catch { /* 拿不到命令行不影响占用判定 */ }

  const suggestion = await PortScanner.findFreePort();
  res.json({
    ok: true,
    ...inspection,
    serviceId: svc.id,
    occupants,
    suggestion,
    declaredPort: svc.port || null,
  });
}));

app.post('/api/services/:id/start', wrap(async (req, res) => {
  requireService(req);
  const port = Number(req.body?.port);
  const portOverride = Number.isInteger(port) && port > 0 ? port : null;
  const persistPort = req.body?.persistPort === true;
  if (persistPort && portOverride) {
    store.update(req.params.id, { port: portOverride });
  }
  const state = await pm.start(req.params.id, { portOverride });
  res.json({ ok: true, state, appliedPort: state.effectivePort ?? null });
}));

app.post('/api/services/:id/stop', wrap(async (req, res) => {
  requireService(req);
  const force = req.body?.force === true;
  const result = await pm.stop(req.params.id, { force });
  res.json({ ok: true, ...result, state: pm.stateOf(req.params.id) });
}));

app.post('/api/services/:id/restart', wrap(async (req, res) => {
  requireService(req);
  const port = Number(req.body?.port);
  const portOverride = Number.isInteger(port) && port > 0 ? port : null;
  const state = await pm.restart(req.params.id, { portOverride });
  res.json({ ok: true, state, appliedPort: state.effectivePort ?? null });
}));

/* ---- Node 进程检测器 ---- */

app.get('/api/processes/node', wrap(async (req, res) => {
  const wantRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const wantDetail = req.query.detail !== '0';
  if (wantRefresh) {
    await sampleOnce();
    await portScanner.refresh().catch(() => {});
  } else if (!sampler.lastSnapshot) {
    await sampleOnce();
  }
  const details = wantDetail
    ? await sampler.queryNodeProcessDetails({ force: wantRefresh }).catch(() => null)
    : null;
  const { list: processes, source } = await buildNodeProcessList({ details, force: wantRefresh });
  res.json({
    ok: true,
    sampledAt: sampler.lastSnapshot ? new Date(sampler.lastSnapshot.ts).toISOString() : null,
    portSampledAt: portScanner.sampledAt ? new Date(portScanner.sampledAt).toISOString() : null,
    enumerateSource: source,
    detailAvailable: Boolean(details && details.size),
    metricsProvider: sampler.provider,
    metricsTreeSupported: sampler.treeSupported,
    portProvider: portScanner.provider,
    total: processes.length,
    managedCount: processes.filter((p) => p.managed).length,
    processes,
  });
}));

app.post('/api/services/:id/kill-orphan', wrap(async (req, res) => {
  requireService(req);
  const result = await pm.killOrphan(req.params.id);
  res.json({ ok: true, ...result, state: pm.stateOf(req.params.id) });
}));

/** 预览实际会执行的命令 */
app.get('/api/services/:id/plan', wrap(async (req, res) => {
  const svc = requireService(req);
  const plan = buildLaunchPlan(svc);
  res.json({ ok: true, plan });
}));

/* ---- 日志 ---- */

app.get('/api/services/:id/logs', wrap(async (req, res) => {
  requireService(req);
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const data = logs.read(req.params.id, limit);
  res.json({
    ok: true,
    lines: data.lines,
    total: data.total,
    bytes: data.bytes,
    paths: logs.paths(req.params.id),
  });
}));

app.delete('/api/services/:id/logs', wrap(async (req, res) => {
  requireService(req);
  logs.clear(req.params.id);
  res.json({ ok: true });
}));

/* ---- package.json 定位 ---- */

app.get('/api/fs/roots', wrap(async (req, res) => {
  res.json({ ok: true, roots: listDriveRoots(), separator: path.sep, platform: process.platform });
}));

app.get('/api/fs/list', wrap(async (req, res) => {
  const target = req.query.path || (process.platform === 'win32' ? 'C:\\' : '/');
  const data = await listDirectory(target);
  res.json({ ok: true, ...data });
}));

app.post('/api/package/analyze', wrap(async (req, res) => {
  const info = analyzePackage(req.body?.packageJsonPath || req.body?.path);
  const existing = store.findBypackageJson(info.packageJsonPath);
  res.json({ ok: true, packageInfo: info, managedBy: existing ? { id: existing.id, name: existing.name } : null });
}));

app.post('/api/scan', wrap(async (req, res) => {
  const dir = req.body?.dir || req.body?.path;
  if (!dir) throw Object.assign(new Error('缺少 dir'), { code: 'BAD_REQUEST' });
  const depth = Math.max(0, Math.min(Number(req.body?.depth ?? 2), 5));
  const data = await scanForPackages(dir, { depth });
  const managed = new Set(store.list().map((s) => s.packageJsonPath.toLowerCase()));
  data.results = data.results.map((r) => ({ ...r, alreadyManaged: managed.has(r.packageJsonPath.toLowerCase()) }));
  res.json({ ok: true, ...data });
}));

/* ---- 批量操作 ---- */

app.post('/api/services/start-all', wrap(async (req, res) => {
  const results = [];
  for (const svc of store.list()) {
    try {
      const st = pm.stateOf(svc.id);
      if (st.status === STATUS.RUNNING || st.status === STATUS.STARTING) {
        results.push({ id: svc.id, name: svc.name, skipped: true, reason: '已在运行' });
        continue;
      }
      await pm.start(svc.id);
      results.push({ id: svc.id, name: svc.name, ok: true });
    } catch (err) {
      results.push({ id: svc.id, name: svc.name, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, results });
}));

app.post('/api/services/stop-all', wrap(async (req, res) => {
  const results = [];
  for (const svc of store.list()) {
    try {
      const st = pm.stateOf(svc.id);
      if (!st.pid) {
        results.push({ id: svc.id, name: svc.name, skipped: true, reason: '未运行' });
        continue;
      }
      await pm.stop(svc.id, { force: true });
      results.push({ id: svc.id, name: svc.name, ok: true });
    } catch (err) {
      results.push({ id: svc.id, name: svc.name, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, results });
}));

/* ---- 静态资源（生产构建产物） ---- */

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Node 服务治理工具</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e6e8ee;padding:48px;line-height:1.7}
code{background:#1b1f27;padding:2px 6px;border-radius:4px;color:#7ee2b8}</style></head><body>
<h1>Node 服务治理工具</h1>
<p>前端尚未构建。请执行：</p>
<p><code>npm run build</code> 然后重启本服务，或使用 <code>npm run dev</code> 同时启动前后端。</p>
<p>API 已就绪：<a style="color:#7ee2b8" href="/api/health">/api/health</a></p>
</body></html>`);
  });
}

/* -------------------------------- 启动 ------------------------------------ */

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Node 服务治理工具已启动');
  console.log(`  ▸ 控制台:   http://${HOST}:${PORT}`);
  console.log(`  ▸ 数据目录: ${DATA_DIR}`);
  console.log(`  ▸ 平台:     ${process.platform} / node ${process.version}`);
  if (fs.existsSync(DIST_DIR)) console.log(`  ▸ 前端产物: ${DIST_DIR}`);
  else console.log('  ▸ 前端产物: 尚未构建（npm run build）');
  console.log('');
  pm.reconcileOnBoot();
  startSamplingLoop();
  // 预热能力探测：让界面首屏就能显示真实的指标采集器与端口探测方式，而不是「待探测」
  sampler.detect().catch(() => {});
  portScanner.detect().catch(() => {});
});

// 端口占用等监听错误必须显式失败退出，否则会被 uncaughtException 兜住并静默退出，
// 使用者只会看到「命令成功但什么都没起来」，极难排查。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  [启动失败] 端口 ${HOST}:${PORT} 已被占用。`);
    console.error('  请先结束占用该端口的进程，或用 SM_PORT 指定其它端口，例如：');
    console.error(`    ${process.platform === 'win32' ? 'set SM_PORT=5180 && npm start' : 'SM_PORT=5180 npm start'}\n`);
  } else {
    console.error('\n  [启动失败]', err.message, '\n');
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[service-manager] 收到 ${signal}，正在退出（托管的服务进程会继续运行，下次启动时可识别为「外部运行中」）…`);
  clearInterval(sampleTimer);
  pm.dispose();
  store.flush();
  for (const res of sseClients) {
    try { res.end(); } catch { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

export { app, server, store, logs, pm, sampler };

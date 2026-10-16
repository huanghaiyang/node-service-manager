/**
 * 端到端冒烟测试：定位 package.json → 纳管 → 启动 → 日志 → 指标(CPU/内存) → 端口/入口 → 停止
 * 用法：先 `npm start` 起服务端，再 `node scripts/smoke-test.mjs`
 *
 * 所有路径都从脚本位置推导，不写死本机绝对路径（既便于移植，也避免把开发机目录结构带进仓库）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES_DIR = fileURLToPath(new URL('../examples', import.meta.url));
const DEMO_DIR = path.join(EXAMPLES_DIR, 'demo-service');

const BASE = process.env.SM_BASE || 'http://127.0.0.1:5178';
const PKG = process.env.SM_PKG || path.join(DEMO_DIR, 'package.json');
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

console.log(`\n=== Node 服务治理工具 · 端到端冒烟测试 ===\n服务端: ${BASE}\n目标包: ${PKG}\n`);

/* 0. 健康检查 */
const health = await api('/api/health');
check('健康检查 /api/health', health.ok && health.json?.ok === true, `pid=${health.json?.pid}`);

/* 1. 解析 package.json */
const analyze = await api('/api/package/analyze', { method: 'POST', body: { packageJsonPath: PKG } });
check('解析 package.json', analyze.ok && analyze.json?.packageInfo?.name === 'demo-service',
  `recommendedScript=${analyze.json?.packageInfo?.recommendedScript} entry=${analyze.json?.packageInfo?.entry ? '✓' : '✗'}`);

/* 2. 纳管（幂等：已存在就先删除） */
const list0 = await api('/api/services');
for (const s of list0.json?.services || []) {
  if (norm(s.packageJsonPath) === norm(PKG)) {
    await api(`/api/services/${s.id}/stop`, { method: 'POST', body: { force: true } });
    await api(`/api/services/${s.id}?force=true`, { method: 'DELETE' });
  }
}
const created = await api('/api/services', { method: 'POST', body: { packageJsonPath: PKG, port: 7100, autoRestart: false } });
check('纳管服务 POST /api/services', created.status === 201 && created.json?.ok === true, `id=${created.json?.service?.id}`);
const id = created.json.service.id;

/* 3. 启动计划可预览 */
const plan = await api(`/api/services/${id}/plan`);
check('预览启动计划', plan.ok && plan.json?.plan?.display, `mode=${plan.json?.plan?.mode} → ${plan.json?.plan?.display}`);

/* 4. 启动 */
const started = await api(`/api/services/${id}/start`, { method: 'POST', body: {} });
const pid = started.json?.state?.pid;
check('启动服务', started.ok && pid > 0, `pid=${pid}`);

await sleep(2500);
const running = (await api(`/api/services/${id}`)).json?.service;
check('状态变为 running', running.state.status === 'running', `status=${running.state.status}`);
check('进程存活', await alive(pid), `pid=${pid}`);

/* 5. 日志采集（文件描述符 stdio + tail） */
const logs1 = await api(`/api/services/${id}/logs?limit=200`);
const lines = logs1.json?.lines || [];
check('采集到日志', lines.length > 0, `${lines.length} 行, 磁盘 ${JSON.stringify(logs1.json.bytes)}`);
check('日志含服务启动输出', lines.some((l) => /listening on/.test(l.text)), lines.find((l) => /listening on/.test(l.text))?.text || '未找到');
const dupSystem = lines.filter((l, i) => i > 0 && l.stream === 'system' && lines[i - 1].text === l.text);
check('系统日志无重复（回归）', dupSystem.length === 0, dupSystem.length ? `重复 ${dupSystem.length} 条` : '无重复');

/* 6. 指标：先制造 CPU 负载 */
const port = 7100;
for (let i = 0; i < 6; i += 1) {
  try { await fetch(`http://127.0.0.1:${port}/load/up`); } catch { /* 忽略 */ }
}
await sleep(7000);
const loaded = (await api(`/api/services/${id}`)).json?.service;
const m = loaded.metrics;
check('上报内存占用', m && m.memoryBytes > 10 * 1024 * 1024, m ? `${(m.memoryBytes / 1048576).toFixed(1)} MB` : 'null');
check('上报 CPU 占用', m && m.cpuPercent > 1, m ? `占整机 ${m.cpuPercent.toFixed(2)}% / 单核基准 ${m.cpuPercentPerCore.toFixed(1)}%` : 'null');
check('指标采样作用域已知', m && ['tree', 'process'].includes(m.scope), `scope=${m?.scope}（${m?.scope === 'process' ? '当前环境 WMI 不可用，仅主进程' : '进程树'}）`);
check('指标历史累积（用于曲线）', (loaded.history?.ts?.length || 0) >= 2, `${loaded.history?.ts?.length || 0} 个采样点`);

/* 6b. 监听端口探测 + 浏览器入口 */
check('探测到监听端口', (loaded.ports || []).some((p) => p.port === port && p.proto === 'tcp'),
  JSON.stringify(loaded.ports || []));
check('入口地址按探测端口推导', loaded.entry?.url === `http://127.0.0.1:${port}/` && loaded.entry?.live === true,
  `${loaded.entry?.url}（source=${loaded.entry?.source}, live=${loaded.entry?.live}）`);
const entryReachable = await fetch(loaded.entry.url, { signal: AbortSignal.timeout(3000) })
  .then(() => true).catch(() => false);
check('入口地址可访问', entryReachable, loaded.entry.url);
check('端口探测方式已知', Boolean(loaded.portScan?.provider), `${loaded.portScan?.provider} / ${loaded.portScan?.providerLabel}`);

/* 7. 宿主指标 */
const sys = await api('/api/system');
check('宿主指标 /api/system', sys.ok && sys.json?.host?.cores > 0,
  `${sys.json?.host?.cores} 核 / 内存 ${(sys.json?.host?.usedMemory / 1073741824).toFixed(1)}GB 已用 / 采集器 ${sys.json?.host?.metricsProvider}`);

/* 8. 停止 */
const stopped = await api(`/api/services/${id}/stop`, { method: 'POST', body: {} });
await sleep(600);
check('停止服务', stopped.ok && stopped.json?.state?.status === 'stopped', `status=${stopped.json?.state?.status}`);
check('进程已被终止', !(await alive(pid)), `pid=${pid}`);
try {
  await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
  check('服务端口已释放', false, `端口 ${port} 仍在响应`);
} catch {
  check('服务端口已释放', true, `端口 ${port} 已关闭`);
}

const stoppedSvc = (await api(`/api/services/${id}`)).json?.service;
check('停止后端口探测结果清空', (stoppedSvc.ports || []).length === 0, JSON.stringify(stoppedSvc.ports || []));
check('停止后入口退化为配置声明', stoppedSvc.entry?.source === 'declared' && stoppedSvc.entry?.live === false,
  `${stoppedSvc.entry?.url}（source=${stoppedSvc.entry?.source}）`);

/* 8b. 手工指定入口地址（支持省略协议） */
const patched = await api(`/api/services/${id}`, { method: 'PATCH', body: { entryUrl: 'app.internal:8080/health' } });
const patchedSvc = (await api(`/api/services/${id}`)).json?.service;
check('入口地址可手工覆盖并自动补协议',
  patchedSvc.entry?.url === 'http://app.internal:8080/health' && patchedSvc.entry?.source === 'override',
  `${patchedSvc.entry?.url}（source=${patchedSvc.entry?.source}）`);
void patched;

/* 9. 重启一次，验证 restart 链路 */
const restarted = await api(`/api/services/${id}/restart`, { method: 'POST', body: {} });
await sleep(2200);
const after = (await api(`/api/services/${id}`)).json?.service;
check('重启服务', after.state.status === 'running' && after.state.pid !== pid, `新 pid=${after.state.pid}（旧 ${pid}）`);

/* 9a. 回归：重启后，上一代进程「迟到的 exit 事件」不得篡改新一代的状态与 PID。
       修复前这里会变成 crashed + pid=null，而新进程仍在跑并占着端口 —— 进程逃逸。 */
await sleep(2500);
const settled = (await api(`/api/services/${id}`)).json?.service;
check('重启后状态与 PID 不被上一代 exit 篡改（代次隔离回归）',
  settled.state.status === 'running' && settled.state.pid === after.state.pid,
  `2.5s 后 status=${settled.state.status} pid=${settled.state.pid}（期望 running / ${after.state.pid}）`);

await api(`/api/services/${id}/stop`, { method: 'POST', body: { force: true } });

/* 9b. 回归：强制停止后，稍后到达的 exit 事件不能把状态回写成 crashed
       （进程可能先被系统回收、exit 事件随后才送达，属真实竞态） */
let raceStatuses = [];
for (let i = 0; i < 5; i += 1) {
  await api(`/api/services/${id}/start`, { method: 'POST', body: {} });
  await sleep(1400);
  await api(`/api/services/${id}/stop`, { method: 'POST', body: { force: true } });
  await sleep(1000); // 故意等足够久，让 exit 事件一定已经送达
  const st = (await api(`/api/services/${id}`)).json?.service;
  raceStatuses.push(st.state.status);
}
check('强制停止后状态稳定为 stopped（exit 竞态回归）',
  raceStatuses.every((s) => s === 'stopped'),
  `5 轮结果：${raceStatuses.join(' / ')}`);

/* 10. 目录定位能力 */
const parent = await api('/api/fs/list?path=' + encodeURIComponent(EXAMPLES_DIR));
check('目录浏览：列出子目录', parent.ok && (parent.json?.dirs?.length || 0) > 0,
  `${parent.json?.dirs?.length} 个子目录，其中 ${parent.json?.packages?.length} 个 package.json`);

const listing = await api('/api/fs/list?path=' + encodeURIComponent(DEMO_DIR));
check('目录浏览：命中 package.json', listing.ok && (listing.json?.packages?.length || 0) === 1,
  listing.json?.packages?.[0] ? `${listing.json.packages[0].name}@${listing.json.packages[0].version}，推荐 script=${listing.json.packages[0].recommendedScript}` : '未命中');
check('目录浏览：返回上级路径', Boolean(listing.json?.parent), `parent=${norm(listing.json?.parent)}`);

const scan = await api('/api/scan', { method: 'POST', body: { dir: EXAMPLES_DIR, depth: 3 } });
check('批量扫描 package.json', scan.ok && (scan.json?.results?.length || 0) > 0, `命中 ${scan.json?.results?.length} 个`);

/* 清理：保留托管记录以便前端演示，这里只删除本次测试产生的服务 */
await api(`/api/services/${id}?force=true`, { method: 'DELETE' });
check('移除托管记录', (await api('/api/services')).json?.services?.length === 0, '清理完成');

console.log(`\n=== 结果: ${results.length - failed}/${results.length} 通过 ===\n`);
process.exit(failed ? 1 : 0);

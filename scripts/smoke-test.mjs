/**
 * 端到端冒烟测试：定位 package.json → 纳管 → 启动 → 日志 → 指标(CPU/内存) → 端口/入口 → 停止
 * 用法：先 `npm start` 起服务端，再 `node scripts/smoke-test.mjs`
 *
 * 所有路径都从脚本位置推导，不写死本机绝对路径（既便于移植，也避免把开发机目录结构带进仓库）。
 */
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
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

/** 该端口上是否已有服务在响应（用于验证端口确实被新进程占用/释放） */
async function portTaken(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) });
    return true;
  } catch {
    return false;
  }
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

/* 9c. 端口占用预检 → 随机分配可用端口 → 用新端口启动
      测试自己在本进程内占住端口，因此不依赖任何外部进程，可重复运行。 */
const CONFLICT_PORT = 7105;
const squatter = net.createServer(() => {});
await new Promise((resolve, reject) => {
  squatter.once('error', reject);
  squatter.listen(CONFLICT_PORT, '127.0.0.1', resolve);
});
await api(`/api/services/${id}`, { method: 'PATCH', body: { port: CONFLICT_PORT } });

const pf = (await api(`/api/services/${id}/preflight`)).json;
check('预检发现目标端口被占用', pf.checked === true && pf.occupied === true, `via=${pf.via} port=${pf.port}`);
check('预检定位到占用者 PID', pf.occupants?.[0]?.pid === process.pid,
  `occupant=${JSON.stringify(pf.occupants?.[0] || null)}`);
check('预检给出随机可用端口', Number.isInteger(pf.suggestion) && pf.suggestion > 0, `suggestion=${pf.suggestion}`);
check('预检给出的端口确实是空闲的', pf.suggestion ? !(await portTaken(pf.suggestion)) : false, `port=${pf.suggestion}`);

const startedOnNew = await api(`/api/services/${id}/start`, { method: 'POST', body: { port: pf.suggestion } });
check('用推荐端口启动成功', startedOnNew.ok && startedOnNew.json.appliedPort === pf.suggestion,
  `appliedPort=${startedOnNew.json?.appliedPort}`);

// 端口表是 5s 一档的快照，给它足够时间收敛；期间持续确认服务确实在运行
let svcNew = null;
let listening = false;
for (let i = 0; i < 6 && !listening; i += 1) {
  await sleep(2000);
  svcNew = (await api(`/api/services/${id}`)).json.service;
  listening = (svcNew.ports || []).some((p) => p.port === pf.suggestion);
}
check('实际监听的是新端口', listening,
  `status=${svcNew?.status ?? svcNew?.state?.status} pid=${svcNew?.state?.pid} ports=${JSON.stringify(svcNew?.ports || [])}`);

/* 9d. Node 进程检测器 */
const det = (await api('/api/processes/node?refresh=1')).json;
const mine = (det.processes || []).filter((p) => p.serviceId === id);
check('进程检测器标记出已托管的 node 进程', mine.length > 0,
  mine.map((p) => `${p.pid}(${p.role},${p.matchedBy})`).join(', ') || `total=${det.total}`);
check('标记出的进程带上了自己的监听端口',
  mine.some((p) => (p.ports || []).some((x) => x.port === pf.suggestion)),
  JSON.stringify(mine.map((p) => p.ports)));
check('检测器返回枚举来源与占用信息', Boolean(det.enumerateSource) && Array.isArray(det.processes),
  `source=${det.enumerateSource}, total=${det.total}, managed=${det.managedCount}`);

await api(`/api/services/${id}/stop`, { method: 'POST', body: { force: true } });
await new Promise((resolve) => squatter.close(resolve));
await sleep(600);

/* 9e. 崩溃诊断：应用自己绑 127.0.0.1 且端口被占 → 认出 EADDRINUSE 端口、查明占用者、给出推荐端口
       （image-clip 这类 monorepo 后端起不来的典型现场） */
const CRASH_PORT = 7799;
const crashAppDir = path.join(os.tmpdir(), 'sm-eaddr-app');
await fs.promises.mkdir(crashAppDir, { recursive: true });
await fs.promises.writeFile(
  path.join(crashAppDir, 'package.json'),
  JSON.stringify({ name: 'sm-eaddr-app', version: '1.0.0', private: true, type: 'module', scripts: { start: 'node index.js' } }, null, 2),
  'utf8',
);
await fs.promises.writeFile(
  path.join(crashAppDir, 'index.js'),
  [
    "import http from 'node:http';",
    `const PORT = Number(process.env.PORT ?? ${CRASH_PORT});`,
    "const server = http.createServer((q, s) => s.end('ok'));",
    "server.listen(PORT, '127.0.0.1', () => console.log('listening', PORT));",
    '',
  ].join('\n'),
  'utf8',
);

const crashSquat = net.createServer(() => {});
await new Promise((resolve, reject) => {
  crashSquat.once('error', reject);
  crashSquat.listen(CRASH_PORT, '127.0.0.1', resolve);
});
const crashSvc = await api('/api/services', {
  method: 'POST',
  body: { packageJsonPath: path.join(crashAppDir, 'package.json'), port: CRASH_PORT, name: 'sm-eaddr-app' },
});
const crashId = crashSvc.json?.service?.id;
if (crashId) {
  await api(`/api/services/${crashId}/start`, { method: 'POST', body: {} });
  await sleep(3500);
  const crashed = (await api(`/api/services/${crashId}`)).json?.service;
  check('端口被占时启动失败被判定为 crashed', crashed?.state?.status === 'crashed', `status=${crashed?.state?.status}`);
  check('崩溃后从日志认出被占用的端口', crashed?.state?.crashPort === CRASH_PORT, `crashPort=${crashed?.state?.crashPort}`);
  check('lastError 直接说明端口被占用', /端口 7799 已被占用/.test(crashed?.state?.lastError || ''), crashed?.state?.lastError);
  check('崩溃诊断给出占用者 PID', crashed?.portConflictHint?.occupants?.[0]?.pid === process.pid,
    `occupant=${JSON.stringify(crashed?.portConflictHint?.occupants?.[0] || null)}`);
  check('崩溃诊断给出随机可用端口', Number.isInteger(crashed?.portConflictHint?.suggestion),
    `suggestion=${crashed?.portConflictHint?.suggestion}`);
  const pfAfterCrash = (await api(`/api/services/${crashId}/preflight`)).json;
  check('二次启动前预检能提前拦住（复用崩溃端口）',
    pfAfterCrash?.checked === true && pfAfterCrash?.port === CRASH_PORT && pfAfterCrash?.occupied === true,
    `checked=${pfAfterCrash?.checked} port=${pfAfterCrash?.port} occupied=${pfAfterCrash?.occupied}`);
  const hintPort = crashed?.portConflictHint?.suggestion;
  if (hintPort) {
    await api(`/api/services/${crashId}/start`, { method: 'POST', body: { port: hintPort } });
    await sleep(3000);
    const recovered = (await api(`/api/services/${crashId}`)).json?.service;
    check('按推荐端口换端口后恢复正常', recovered?.state?.status === 'running' && !recovered?.portConflictHint,
      `status=${recovered?.state?.status} port=${recovered?.state?.effectivePort}`);
    await api(`/api/services/${crashId}/stop`, { method: 'POST', body: { force: true } });
  }
  await api(`/api/services/${crashId}?force=true`, { method: 'DELETE' });
}
await new Promise((resolve) => crashSquat.close(resolve));
await fs.promises.rm(crashAppDir, { recursive: true, force: true }).catch(() => {});
await sleep(600);

/* 9f. 日志清洗：子进程输出的 ANSI 颜色码 / 光标控制 / \r 进度条都要变成可读纯文本
       （vite、npm、webpack 等在被重定向到文件后仍会输出颜色码，直接显示就是乱码） */
const ansiAppDir = path.join(os.tmpdir(), 'sm-ansi-app');
await fs.promises.mkdir(ansiAppDir, { recursive: true });
await fs.promises.writeFile(
  path.join(ansiAppDir, 'package.json'),
  JSON.stringify({ name: 'sm-ansi-app', version: '1.0.0', private: true, type: 'module', scripts: { start: 'node index.js' } }, null, 2),
  'utf8',
);
await fs.promises.writeFile(
  path.join(ansiAppDir, 'index.js'),
  [
    "const E = '\\u001b';",
    "console.log(`${E}[2m16:03:52${E}[22m ${E}[36m${E}[1m[vite]${E}[22m${E}[39m ${E}[90m${E}[2m(client)${E}[22m${E}[39m ${E}[32mhmr update${E}[39m`);",
    "console.log(`${E}[31m红色${E}[0m ${E}[42m绿底${E}[0m 普通文字`);",
    "console.log(`before${E}[2K${E}[1Gafter-clear-line`);",
    "process.stdout.write('构建中 10%\\r');",
    "process.stdout.write('构建中 100%\\n');",
    "console.log(`NO_COLOR=${process.env.NO_COLOR} FORCE_COLOR=${process.env.FORCE_COLOR}`);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'),
  'utf8',
);

const ansiSvc = await api('/api/services', {
  method: 'POST',
  body: { packageJsonPath: path.join(ansiAppDir, 'package.json'), name: 'sm-ansi-app' },
});
const ansiId = ansiSvc.json?.service?.id;
if (ansiId) {
  await api(`/api/services/${ansiId}/start`, { method: 'POST', body: {} });
  await sleep(3000);
  const ansiLogs = (await api(`/api/services/${ansiId}/logs?limit=200`)).json?.lines || [];
  const ansiOut = ansiLogs.filter((l) => l.stream === 'stdout');
  const ansiText = ansiOut.map((l) => l.text).join('\n');
  check('日志中不含 ANSI 控制字节', !/[\u001B\u009B]/.test(ansiText),
    ansiOut.find((l) => /[\u001B\u009B]/.test(l.text))?.text || '无');
  check('ANSI 颜色码被还原为纯文本', ansiOut.some((l) => l.text === '16:03:52 [vite] (client) hmr update'),
    ansiOut.find((l) => l.text.includes('[vite]'))?.text || '未找到 vite 行');
  check('光标控制序列被清除', ansiOut.some((l) => l.text === 'beforeafter-clear-line'),
    ansiOut.find((l) => l.text.startsWith('before'))?.text || '未找到');
  check('\\r 进度条只保留最终状态', ansiOut.some((l) => l.text === '构建中 100%')
    && !ansiOut.some((l) => l.text.includes('构建中 10%')),
    JSON.stringify(ansiOut.filter((l) => l.text.includes('构建中')).map((l) => l.text)));
  check('默认向子进程注入 NO_COLOR / FORCE_COLOR', ansiOut.some((l) => /NO_COLOR=1 FORCE_COLOR=0/.test(l.text)),
    ansiOut.find((l) => l.text.startsWith('NO_COLOR'))?.text || '未找到');
  await api(`/api/services/${ansiId}/stop`, { method: 'POST', body: { force: true } });
  await api(`/api/services/${ansiId}?force=true`, { method: 'DELETE' });
}
await fs.promises.rm(ansiAppDir, { recursive: true, force: true }).catch(() => {});
await sleep(400);

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

/* 9g. 外部运行探测：用户绕过本工具，自己在终端把服务跑起来
       —— 必须能发现「它其实在跑」、能接管（指标/端口生效）、并在它自己退出后发现 */
const EXT_PORT = 7801;
const extAppDir = path.join(os.tmpdir(), 'sm-ext-app');
await fs.promises.mkdir(extAppDir, { recursive: true });
await fs.promises.writeFile(
  path.join(extAppDir, 'package.json'),
  JSON.stringify({ name: 'sm-ext-app', version: '1.0.0', private: true, type: 'module', scripts: { start: 'node index.js' } }, null, 2),
  'utf8',
);
await fs.promises.writeFile(
  path.join(extAppDir, 'index.js'),
  [
    "import http from 'node:http';",
    `const PORT = Number(process.env.PORT ?? ${EXT_PORT});`,
    "http.createServer((q, s) => s.end('ext')).listen(PORT, '127.0.0.1', () => console.log('ext listening', PORT));",
    '',
  ].join('\n'),
  'utf8',
);

const extSvc = await api('/api/services', {
  method: 'POST',
  body: { packageJsonPath: path.join(extAppDir, 'package.json'), port: EXT_PORT, name: 'sm-ext-app' },
});
const extId = extSvc.json?.service?.id;
if (extId) {
  // 走「外部」路径：不经由治理工具启动，而是测试进程直接拉起
  const extOut = fs.openSync(path.join(extAppDir, 'external.out'), 'a');
  const extChild = (await import('node:child_process')).spawn(
    process.execPath,
    [path.join(extAppDir, 'index.js')],
    { stdio: ['ignore', extOut, 'ignore'] },
  );
  await sleep(6000);
  const extState = (await api(`/api/services/${extId}`)).json?.service;
  // 命令行能拿到 → 强信号断言「外部运行中」；拿不到 → 只给端口弱信号提示、不改状态
  const detailOk = Boolean((await api('/api/processes/node?refresh=1')).json?.detailAvailable);
  if (detailOk) {
    check('外部启动被判定为「外部运行中」（强信号）', extState?.state?.status === 'orphaned',
      `status=${extState?.state?.status} pid=${extState?.state?.pid}`);
    check('强信号依据为命令行且 PID 正确',
      extState?.state?.external?.matchedBy === 'commandline' && extState?.state?.pid === extChild.pid,
      JSON.stringify(extState?.state?.external || null));
  } else {
    check('只能靠端口时给出「可疑」提示', extState?.state?.externalHint?.pid === extChild.pid,
      JSON.stringify(extState?.state?.externalHint || null));
    check('弱信号不把「已停止」误标成「运行中」', extState?.state?.status === 'stopped',
      `status=${extState?.state?.status}`);
  }

  const adoptedRes = await api(`/api/services/${extId}/adopt`, { method: 'POST', body: { pid: extChild.pid } });
  check('可以接管外部进程', adoptedRes.ok && adoptedRes.json?.state?.status === 'running'
    && adoptedRes.json?.state?.adopted === true, `status=${adoptedRes.json?.state?.status}`);
  await sleep(4500);
  const adoptedState = (await api(`/api/services/${extId}`)).json?.service;
  check('接管后指标可用', (adoptedState?.metrics?.memoryBytes || 0) > 0,
    `${((adoptedState?.metrics?.memoryBytes || 0) / 1048576).toFixed(1)} MB`);
  check('接管后端口归属生效', (adoptedState?.ports || []).some((p) => p.port === EXT_PORT),
    JSON.stringify(adoptedState?.ports || []));

  // 模拟用户自己在终端里把这个进程关掉
  try { extChild.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(8000);
  const goneState = (await api(`/api/services/${extId}`)).json?.service;
  check('外部进程自行退落后状态回落', ['exited', 'stopped'].includes(goneState?.state?.status),
    `status=${goneState?.state?.status}`);
  check('退出原因指明是外部进程', /外部进程已退出/.test(goneState?.state?.lastError || ''),
    goneState?.state?.lastError);
  check('退出后 PID 清空', !goneState?.state?.pid, `pid=${goneState?.state?.pid}`);

  try { fs.closeSync(extOut); } catch { /* ignore */ }
  await api(`/api/services/${extId}?force=true`, { method: 'DELETE' });
}
await fs.promises.rm(extAppDir, { recursive: true, force: true }).catch(() => {});
await sleep(400);

/* 9h. 误判回归：只是"碰了"项目目录的进程 ≠ 服务在跑
       真实案例：node D:\sgames\gaea-rea\gaea-mcp\server.mjs 是个 MCP 服务器，
       命令行含项目目录，但和被托管的 web 服务毫无关系，却被断言成「外部运行中」。 */
const fpDir = path.join(os.tmpdir(), 'sm-fp-proj');
await fs.promises.mkdir(path.join(fpDir, 'tools'), { recursive: true });
await fs.promises.mkdir(path.join(fpDir, 'node_modules', 'fake-cli'), { recursive: true });
await fs.promises.writeFile(
  path.join(fpDir, 'package.json'),
  JSON.stringify({ name: 'sm-fp-proj', version: '1.0.0', private: true, type: 'module', scripts: { dev: 'node app.js' } }, null, 2),
  'utf8',
);
await fs.promises.writeFile(path.join(fpDir, 'app.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
await fs.promises.writeFile(path.join(fpDir, 'tools', 'helper.mjs'), 'setInterval(() => {}, 1000);\n', 'utf8');
await fs.promises.writeFile(path.join(fpDir, 'node_modules', 'fake-cli', 'cli.js'), 'setInterval(() => {}, 1000);\n', 'utf8');

const { spawn: spawnChild } = await import('node:child_process');
const spawnQuiet = (args) => spawnChild(process.execPath, args, { stdio: 'ignore' });

const fpSvc = await api('/api/services', {
  method: 'POST',
  body: { packageJsonPath: path.join(fpDir, 'package.json'), name: 'sm-fp-proj' },
});
const fpId = fpSvc.json?.service?.id;
if (fpId) {
  // 只"碰了"项目目录、但不是该服务的启动命令
  const helper = spawnQuiet([path.join(fpDir, 'tools', 'helper.mjs')]);
  await sleep(6000);
  const fpState = (await api(`/api/services/${fpId}`)).json?.service;
  const fpDetailOk = Boolean((await api('/api/processes/node?refresh=1')).json?.detailAvailable);
  check('命令行只"碰了"项目目录的进程不会被断言成外部运行中',
    fpState?.state?.status !== 'orphaned',
    `status=${fpState?.state?.status} pid=${fpState?.state?.pid}`);
  if (fpDetailOk) {
    check('降级为「可疑」提示并说明不像启动命令',
      fpState?.state?.externalHint?.pid === helper.pid
      && /不像该服务的启动命令/.test(fpState?.state?.externalHint?.detail || ''),
      JSON.stringify(fpState?.state?.externalHint || null));
  } else {
    console.log('  （当前环境读不到命令行，弱信号提示不适用）');
  }

  // 真正的"由项目脚本启动"：命令行含 <root>/node_modules/
  const runner = spawnQuiet([path.join(fpDir, 'node_modules', 'fake-cli', 'cli.js')]);
  await sleep(6000);
  const fpState2 = (await api(`/api/services/${fpId}`)).json?.service;
  if (fpDetailOk) {
    check('可佐证的外部启动仍被判为外部运行中', fpState2?.state?.status === 'orphaned',
      `status=${fpState2?.state?.status} pid=${fpState2?.state?.pid}`);
    check('佐证依据写明 node_modules', /node_modules/.test(fpState2?.state?.external?.detail || ''),
      fpState2?.state?.external?.detail);
  } else {
    check('（无命令行时）依然不会误判', fpState2?.state?.status !== 'orphaned',
      `status=${fpState2?.state?.status}`);
  }

  try { helper.kill('SIGKILL'); } catch { /* ignore */ }
  try { runner.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(500);
  await api(`/api/services/${fpId}?force=true`, { method: 'DELETE' });
}
await fs.promises.rm(fpDir, { recursive: true, force: true }).catch(() => {});
await sleep(400);

/* 清理：保留托管记录以便前端演示，这里只删除本次测试产生的服务 */
await api(`/api/services/${id}?force=true`, { method: 'DELETE' });
check('移除托管记录', (await api('/api/services')).json?.services?.length === 0, '清理完成');

console.log(`\n=== 结果: ${results.length - failed}/${results.length} 通过 ===\n`);
process.exit(failed ? 1 : 0);

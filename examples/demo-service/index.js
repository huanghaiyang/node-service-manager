/**
 * 示例服务：用于验证「启动/停止、日志、CPU/内存采集」。
 * - 监听 0.0.0.0:PORT（默认 7100）
 * - 每 2s 打印一条心跳日志
 * - 周期性做一点 CPU 计算并持有内存，便于观察指标曲线
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 7100);
const DEV = process.argv.includes('--dev');

// 制造一段持续占用的内存（约 40MB），便于观察内存曲线
const ballast = [];
for (let i = 0; i < 40; i += 1) ballast.push(Buffer.alloc(1024 * 1024, i));

let ticks = 0;
let load = 0;

const startedAt = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === '/load/up') { load = Math.min(load + 1, 8); res.end(`load=${load}\n`); return; }
  if (req.url === '/load/down') { load = Math.max(load - 1, 0); res.end(`load=${load}\n`); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    service: 'demo-service',
    mode: DEV ? 'dev' : 'prod',
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    ticks,
    load,
    rss: process.memoryUsage().rss,
    node: process.version,
  }, null, 2));
});

server.listen(PORT, () => {
  console.log(`[demo-service] listening on http://127.0.0.1:${PORT} (mode=${DEV ? 'dev' : 'prod'}, pid=${process.pid})`);
});

setInterval(() => {
  ticks += 1;
  console.log(`[demo-service] heartbeat #${ticks} rss=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB load=${load}`);
  if (ticks % 5 === 0) console.warn(`[demo-service] 这是一条 stderr 示例日志（第 ${ticks} 次心跳）`);
}, 2000);

// 按外部负载做点无意义的计算，制造可观察的 CPU 曲线
setInterval(() => {
  if (load <= 0) return;
  const until = Date.now() + load * 60;
  let x = 0;
  while (Date.now() < until) x += Math.sqrt(Math.random());
  void x;
}, 250);

process.on('SIGTERM', () => {
  console.log('[demo-service] 收到 SIGTERM，优雅退出');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => process.exit(0));

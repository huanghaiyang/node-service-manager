#!/usr/bin/env node
/**
 * 开发模式：同时启动
 *   1) 治理服务端（node --watch，改后端自动重启）
 *   2) 前端构建器（--watch，改 web/ 自动重新编译到 dist/）
 *
 * 前端没有用 HMR，改完刷新浏览器即可；对本地运维工具来说，
 * 这条链路的收益是「零原生依赖、任何机器都能构建」。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const targets = [
  {
    name: 'server',
    color: '\u001b[36m',
    cmd: process.execPath,
    args: ['--watch', path.join(ROOT, 'server', 'src', 'index.js')],
  },
  {
    name: 'web   ',
    color: '\u001b[35m',
    cmd: process.execPath,
    args: [path.join(ROOT, 'scripts', 'build-web.mjs'), '--watch'],
  },
];

const children = [];
const RESET = '\u001b[0m';

for (const t of targets) {
  const child = spawn(t.cmd, t.args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: false,
    env: { ...process.env, SM_DEV_PREFIX: t.name.trim() },
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${t.color}[${t.name}]${RESET} 退出，code=${code}`);
    }
  });
  child.on('error', (err) => {
    console.error(`${t.color}[${t.name}]${RESET} 启动失败：${err.message}`);
  });
}

console.log('\n  dev 模式已启动：');
console.log('  ▸ 治理服务端  http://127.0.0.1:' + (process.env.SM_PORT || 5178));
console.log('  ▸ 前端产物    dist/（改动 web/ 会自动重新编译，刷新浏览器生效）');
console.log('  按 Ctrl+C 退出\n');

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

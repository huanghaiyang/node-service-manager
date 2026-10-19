import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ensureDirs } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_DIR = path.join(DATA_DIR, 'tmp');
let tmpSeq = 0;

/**
 * 以文件描述符作为 stdout 执行外部命令并读回文本。
 *
 * 不用管道是刻意选择：
 *   1. 规避受限运行环境对命名管道（stdio: 'pipe'）的限制；
 *   2. 避免大输出把子进程堵死。
 * 调用方（指标采集、端口探测）都依赖这个约定。
 */
export function captureStdout(exe, args, { timeoutMs = 20000, mergeStderr = false } = {}) {
  ensureDirs();
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  return new Promise((resolve) => {
    const outFile = path.join(TMP_DIR, `cap-${process.pid}-${Date.now()}-${tmpSeq += 1}.txt`);
    let fd;
    try {
      fd = fs.openSync(outFile, 'w');
    } catch (err) {
      resolve({ ok: false, code: null, text: '', error: err.message });
      return;
    }
    let child;
    try {
      // mergeStderr：把 stderr 也写进同一个文件。命令的报错才是排查依据
      // （例如 reg / systemctl 的失败原因），默认丢弃会让错误信息变成空的。
      child = spawn(exe, args, { stdio: ['ignore', fd, mergeStderr ? fd : 'ignore'], windowsHide: true });
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
      resolve({ ok: false, code: null, text: '', error: `spawn ${err.code || err.message}` });
      return;
    }
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch { /* ignore */ }
      let text = '';
      try {
        text = fs.readFileSync(outFile, 'utf8');
      } catch { /* ignore */ }
      try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
      resolve({ ok: code === 0, code, text, error });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null, 'timeout');
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); finish(null, String(err.code || err.message)); });
    child.on('exit', (code) => { clearTimeout(timer); finish(code, null); });
  });
}

export function uid() {
  return crypto.randomBytes(8).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * ANSI 转义序列。
 * 覆盖三类：
 *   CSI  ESC [ 参数 中间字节 终止字节   —— SGR 颜色（ESC[36m）、光标移动（ESC[2K）等
 *   OSC  ESC ] ... BEL 或 ESC \         —— 设置窗口标题、超链接等
 *   双字符转义 ESC <单字符>              —— 例如 ESC(B 切换字符集
 * 子进程被重定向到文件后通常仍会输出颜色（很多工具只看是否设置了环境变量），
 * 这些字节直接显示就成了「乱码」。
 */
const ANSI_RE = /[\u001B\u009B](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-_])/g;

/** 去掉 ANSI 转义序列 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

/**
 * 日志行清洗：去 ANSI 控制符、去其它不可打印控制字符、并处理 \r 覆盖。
 *
 * 关于 \r：进度条（npm/vite/webpack）习惯用 \r 回到行首重复覆盖同一行，
 * 终端最终只显示最后一段。这里对齐这个语义，否则会看到一堆拼在一起的内容。
 */
export function sanitizeLogLine(text) {
  let s = stripAnsi(text);
  if (s.includes('\r')) {
    const parts = s.split('\r');
    s = parts[parts.length - 1];
  }
  // 保留 \t，去掉其余控制字符（含 ESC 残留、退格、振铃等）
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s;
}

/** 进程是否存活（信号 0 探测） */
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 命令行参数安全转义（Windows / POSIX 各一套） */
export function quoteArg(arg, platform = process.platform) {
  const s = String(arg);
  if (s === '') return '""';
  if (platform === 'win32') {
    if (!/[\s"^&|<>()%!]/.test(s)) return s;
    return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  }
  if (!/[\s"'$`\\&|<>()*?[\]{}#~!]/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 稳定的展示名：优先 package.json 的 name，其次目录名 */
export function displayName(pkgName, rootDir) {
  if (pkgName && typeof pkgName === 'string' && pkgName.trim()) {
    return pkgName.startsWith('@') ? pkgName.split('/').pop() : pkgName;
  }
  return path.basename(rootDir) || 'service';
}

/** 归一化路径，便于跨平台比较 */
export function normalizePath(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

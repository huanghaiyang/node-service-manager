import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 业务模块之前设置：config.js 在模块加载时就读取 SM_DATA_DIR，
// 否则测试会写到项目自己的 data/ 目录里。
export const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-unit-'));
process.env.SM_DATA_DIR = TMP_DATA;
process.env.SM_PORT = process.env.SM_PORT || '0';

/**
 * 动态 import 业务模块（确保上面的环境变量已生效）。
 * 用缓存避免同一文件内重复加载。
 */
export async function load(rel) {
  return import(new URL(`../server/src/${rel}`, import.meta.url).href);
}

/** 生成 ppid 映射：[[child, parent], ...] → Map */
export function ppidMap(pairs) {
  return new Map(pairs);
}

/** 生成 pid → 命令行 映射 */
export function cmdMap(pairs) {
  return new Map(pairs);
}

export function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

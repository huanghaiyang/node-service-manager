#!/usr/bin/env node
/**
 * 单元测试运行器（零依赖，基于内置 node:test）。
 *
 * 为什么不用 `node --test test/`：它默认给**每个测试文件**起一个子进程再汇总，
 * 而受限环境里带管道的 spawn 会被拒绝（EPERM），整轮直接跑不起来。
 * 这里改为在同一个进程里并行 import 所有测试文件 —— 断言与汇总仍由 node:test 提供。
 *
 * 用法：node scripts/unit-test.mjs [过滤子串]
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'test');
const filter = process.argv[2] || '';

const all = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.test.mjs')).sort();
const files = filter ? all.filter((f) => f.includes(filter)) : all;

if (!files.length) {
  console.error(`[unit] 没有找到测试文件${filter ? `（过滤：${filter}）` : ''}`);
  process.exit(1);
}

// 一次性把全部文件"踢"起来（不逐个 await），保证所有 test()/describe()
// 都在 node:test 的根测试开始执行之前完成注册。
await Promise.all(files.map((f) => import(new URL(`../test/${f}`, import.meta.url).href)));

console.log(`[unit] 已加载 ${files.length} 个测试文件：${files.join(', ')}`);

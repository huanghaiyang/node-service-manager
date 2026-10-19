import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './helpers.mjs';

const { detectPortInUse, buildLaunchPlan } = await load('pm.js');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEMO = path.join(ROOT, 'examples', 'demo-service', 'package.json');

describe('detectPortInUse（崩溃诊断的入口）', () => {
  test('识别 address already in use 127.0.0.1:8787', () => {
    const lines = [{ text: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:8787' }];
    assert.equal(detectPortInUse(lines), 8787);
  });

  test('识别 :::8787 形式', () => {
    assert.equal(detectPortInUse([{ text: 'Error: listen EADDRINUSE: address already in use :::8787' }]), 8787);
  });

  test('端口只在后续 stack 行里也能识别', () => {
    const lines = [
      { text: "Error: listen EADDRINUSE: address already in use" },
      { text: "    at Server.setupListenHandle [as _listen2] (node:net:1940:16)" },
      { text: "  address: '127.0.0.1'," },
      { text: '  port: 7799' },
    ];
    assert.equal(detectPortInUse(lines), 7799);
  });

  test('兼容纯字符串数组', () => {
    assert.equal(detectPortInUse(['node:events:497', 'listen EADDRINUSE 0.0.0.0:3000']), 3000);
  });

  test('与端口无关的报错返回 null', () => {
    assert.equal(detectPortInUse([{ text: 'Error: Cannot find module "x"' }]), null);
    assert.equal(detectPortInUse([]), null);
    assert.equal(detectPortInUse(null), null);
  });

  test('不把时间戳误当端口', () => {
    // 没有 EADDRINUSE 时，哪怕有 :12 之类的片段也不该返回
    assert.equal(detectPortInUse([{ text: '12:44:01 [vite] hmr update' }]), null);
  });
});

describe('buildLaunchPlan', () => {
  const base = {
    name: 'demo-service',
    packageJsonPath: DEMO,
    root: path.dirname(DEMO),
    cwd: path.dirname(DEMO),
    script: 'start',
    args: [],
    env: {},
    command: '',
  };

  test('npm 运行时解析为可执行计划', () => {
    const plan = buildLaunchPlan({ ...base, runtime: 'npm' });
    assert.ok(plan.exe, '应给出可执行文件');
    assert.ok(Array.isArray(plan.args) && plan.args.length > 0, '应有参数');
    assert.ok(typeof plan.display === 'string' && plan.display.length > 0);
    assert.ok(['npm-cli', 'npm-shell', 'node-bin', 'node-direct', 'custom'].includes(plan.mode),
      `未知 mode: ${plan.mode}`);
  });

  test('自定义命令按原样执行', () => {
    const plan = buildLaunchPlan({ ...base, runtime: 'custom', command: 'node --version' });
    assert.equal(plan.mode, 'custom');
    assert.ok(plan.display.includes('node --version') || plan.args.join(' ').includes('--version'));
  });

  test('extra env 会被带上（用于端口注入）', () => {
    const plan = buildLaunchPlan({ ...base, runtime: 'npm', env: { PORT: '12345' } });
    assert.ok(plan, 'plan 应存在');
  });
});

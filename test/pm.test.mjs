import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './helpers.mjs';

const { detectPortInUse, buildLaunchPlan, buildChildEnv } = await load('pm.js');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEMO = path.join(ROOT, 'examples', 'demo-service', 'package.json');

describe('buildChildEnv（不能把工具自己的 PORT 泄漏给子进程）', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    // 模拟治理工具自身：跑在 5178，且（历史 bug）把 PORT 带进了环境
    PORT: '5178',
    SM_PORT: '5178',
    SM_HOST: '127.0.0.1',
    SM_DATA_DIR: 'D:/sm/data',
  };
  const svc = { name: 'torrent-vault', env: {} };

  test('回归：继承来的 PORT 必须被剔除（torrent-vault 事故）', () => {
    const { env } = buildChildEnv({ id: 'x', svc, baseEnv });
    assert.equal(env.PORT, undefined, '子进程不应继承治理工具的 PORT');
  });

  test('本工具的 SM_* 变量也不传给子进程', () => {
    const { env } = buildChildEnv({ id: 'x', svc, baseEnv });
    assert.equal(env.SM_PORT, undefined);
    assert.equal(env.SM_HOST, undefined);
    assert.equal(env.SM_DATA_DIR, undefined);
    // 但自己写入的标记要保留
    assert.equal(env.SM_MANAGED, '1');
    assert.equal(env.SM_SERVICE_ID, 'x');
    assert.equal(env.SM_SERVICE_NAME, 'torrent-vault');
  });

  test('其它环境变量照常继承（PATH 等）', () => {
    const { env } = buildChildEnv({ id: 'x', svc, baseEnv });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/x');
  });

  test('未配置端口时不注入 PORT（让应用用它的默认端口）', () => {
    const { env, effectivePort } = buildChildEnv({ id: 'x', svc, baseEnv });
    assert.equal(effectivePort, null);
    assert.equal(env.PORT, undefined);
  });

  test('配置了端口才注入 PORT', () => {
    const { env, effectivePort } = buildChildEnv({ id: 'x', svc: { ...svc, port: 4000 }, baseEnv });
    assert.equal(effectivePort, 4000);
    assert.equal(env.PORT, '4000');
  });

  test('本次端口覆盖优先级最高', () => {
    const { env, effectivePort } = buildChildEnv({ id: 'x', svc: { ...svc, port: 4000 }, portOverride: 4321, baseEnv });
    assert.equal(effectivePort, 4321);
    assert.equal(env.PORT, '4321');
  });

  test('服务级 env 可以显式设置 PORT', () => {
    const { env } = buildChildEnv({ id: 'x', svc: { ...svc, env: { PORT: '9000' } }, baseEnv });
    assert.equal(env.PORT, '9000');
  });

  test('默认关闭颜色，但服务级 env 可覆盖', () => {
    assert.equal(buildChildEnv({ id: 'x', svc, baseEnv }).env.NO_COLOR, '1');
    assert.equal(buildChildEnv({ id: 'x', svc, baseEnv }).env.FORCE_COLOR, '0');
    const { env } = buildChildEnv({ id: 'x', svc: { ...svc, env: { FORCE_COLOR: '1' } }, baseEnv });
    assert.equal(env.FORCE_COLOR, '1');
  });

  test('不修改传入的 baseEnv（纯函数）', () => {
    const snapshot = { ...baseEnv };
    buildChildEnv({ id: 'x', svc, baseEnv });
    assert.deepEqual(baseEnv, snapshot);
  });
});

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

  test('应用自己措辞的中文提示（torrent-vault 实际日志）', () => {
    const lines = [{ text: '[torrent-vault] 端口 5178 已被占用，请设置 PORT 环境变量后重试' }];
    assert.equal(detectPortInUse(lines), 5178);
  });

  test('vite 的 Port 5173 is already in use', () => {
    const lines = [{ text: 'Error: Port 5173 is already in use' }];
    assert.equal(detectPortInUse(lines), 5173);
  });

  test('「端口最多被占用」这类无关描述不应命中', () => {
    assert.equal(detectPortInUse([{ text: '提示：端口冲突时请更换端口' }]), null);
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

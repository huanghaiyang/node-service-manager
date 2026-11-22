import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load, ppidMap, cmdMap } from './helpers.mjs';

const {
  normPath, depthOf, candidateRank, subtreeOf,
  corroboratesLaunch, isPmWrapper, topmostWrapper, cmdLabel,
  referencesProject, containsRoot, isShellShimName, launchGroupRoot, collectKnownPorts,
} = await load('external.js');

/** 构建 pid → 进程名 映射 */
function nameMap(pairs) {
  return new Map(pairs);
}

const ROOT = 'D:\\sgames\\gaea-rea';
const ROOT_FWD = 'd:/sgames/gaea-rea';

describe('normPath', () => {
  test('统一分隔符、去尾斜杠、小写', () => {
    assert.equal(normPath('D:\\Games\\App\\'), 'd:/games/app');
    assert.equal(normPath('d:/games/app'), 'd:/games/app');
  });
  test('空值安全', () => {
    assert.equal(normPath(''), '');
    assert.equal(normPath(null), '');
    assert.equal(normPath(undefined), '');
  });
});

describe('depthOf', () => {
  const ppid = ppidMap([[10, 0], [11, 10], [12, 11], [13, 12]]);
  test('根为 0 层', () => assert.equal(depthOf(10, ppid), 0));
  test('逐层递增', () => assert.equal(depthOf(12, ppid), 2));
  test('未知 pid 返回 0', () => assert.equal(depthOf(999, ppid), 0));
  test('自引用不会死循环', () => {
    assert.equal(depthOf(5, ppidMap([[5, 5]])), 0);
  });
});

describe('subtreeOf', () => {
  const ppid = ppidMap([[1, 0], [2, 1], [3, 1], [4, 2], [5, 9]]);
  test('包含自身与所有后代', () => {
    assert.deepEqual([...subtreeOf(1, ppid)].sort(), [1, 2, 3, 4]);
  });
  test('叶子节点只有自己', () => {
    assert.deepEqual([...subtreeOf(4, ppid)], [4]);
  });
});

describe('candidateRank', () => {
  test('高置信优于中置信', () => {
    assert.ok(candidateRank({ confidence: 'high', depth: 9 }) < candidateRank({ confidence: 'medium', depth: 0 }));
  });
  test('同置信度下更浅者更优', () => {
    assert.ok(candidateRank({ confidence: 'high', depth: 0 }) < candidateRank({ confidence: 'high', depth: 2 }));
  });
});

describe('corroboratesLaunch（这条逻辑有过真实误判，必须守住）', () => {
  test('真实误判回归：命令行只"碰了"项目目录 → 不能佐证', () => {
    const ppid = ppidMap([[100, 1]]);
    const cmds = cmdMap([[100, `"C:\\Program Files\\nodejs\\node.exe" ${ROOT}\\gaea-mcp\\server.mjs`]]);
    const why = corroboratesLaunch({
      pid: 100, ppidOf: ppid, cmdOf: cmds, portsOfPid: () => [],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: null,
    });
    assert.equal(why, null);
  });

  test('命令行引用 <root>/node_modules/ → 佐证为 node_modules', () => {
    const ppid = ppidMap([[200, 1]]);
    const cmds = cmdMap([[200, `node ${ROOT}\\node_modules\\concurrently\\dist\\bin\\concurrently.js`]]);
    const why = corroboratesLaunch({
      pid: 200, ppidOf: ppid, cmdOf: cmds, portsOfPid: () => [],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: null,
    });
    assert.equal(why, 'node_modules');
  });

  test('后代进程引用 node_modules 也算（npm 包装层本身不带项目路径）', () => {
    // 200 是 npm 包装层，201 是它拉起的项目脚本
    const ppid = ppidMap([[200, 1], [201, 200]]);
    const cmds = cmdMap([
      [200, 'node C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run dev'],
      [201, `node ${ROOT}\\node_modules\\vite\\bin\\vite.js`],
    ]);
    const why = corroboratesLaunch({
      pid: 200, ppidOf: ppid, cmdOf: cmds, portsOfPid: () => [],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: null,
    });
    assert.equal(why, 'node_modules');
  });

  test('引用服务的 package.json → 佐证为 package.json', () => {
    const ppid = ppidMap([[300, 1]]);
    const cmds = cmdMap([[300, `node runner.js --config ${ROOT}\\package.json`]]);
    const why = corroboratesLaunch({
      pid: 300, ppidOf: ppid, cmdOf: cmds, portsOfPid: () => [],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: null,
    });
    assert.equal(why, 'package.json');
  });

  test('树里有进程监听声明端口 → 佐证为 port', () => {
    const ppid = ppidMap([[400, 1]]);
    const why = corroboratesLaunch({
      pid: 400, ppidOf: ppid, cmdOf: cmdMap([[400, 'node index.js']]),
      portsOfPid: () => [{ proto: 'tcp', port: 8787, address: '127.0.0.1' }],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: 8787,
    });
    assert.equal(why, 'port');
  });

  test('端口不匹配时不算佐证', () => {
    const ppid = ppidMap([[500, 1]]);
    const why = corroboratesLaunch({
      pid: 500, ppidOf: ppid, cmdOf: cmdMap([[500, 'node index.js']]),
      portsOfPid: () => [{ proto: 'tcp', port: 9999, address: '127.0.0.1' }],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: 8787,
    });
    assert.equal(why, null);
  });

  test('路径大小写与分隔符差异也能匹配', () => {
    const ppid = ppidMap([[600, 1]]);
    const cmds = cmdMap([[600, `node ${ROOT_FWD}/node_modules/x/cli.js`]]);
    const why = corroboratesLaunch({
      pid: 600, ppidOf: ppid, cmdOf: cmds, portsOfPid: () => [],
      roots: [ROOT], packageJsonPath: null, declaredPort: null,
    });
    assert.equal(why, 'node_modules');
  });

  test('无关项目目录不会被误认', () => {
    const ppid = ppidMap([[700, 1]]);
    const cmds = cmdMap([[700, 'node D:\\sgames\\other-project\\node_modules\\vite\\bin\\vite.js']]);
    const why = corroboratesLaunch({
      pid: 700, ppidOf: ppid, cmdOf: cmds, portsOfPid: () => [],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: null,
    });
    assert.equal(why, null);
  });
});

describe('包管理器包装进程', () => {
  test('识别 npm / npx / pnpm / yarn', () => {
    assert.equal(isPmWrapper('node C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run dev'), true);
    assert.equal(isPmWrapper('node .../npx-cli.js create-vite'), true);
    assert.equal(isPmWrapper('node .../pnpm.cjs run dev'), true);
    assert.equal(isPmWrapper('node .../yarn.cjs dev'), true);
  });
  test('普通应用脚本不算包装层', () => {
    assert.equal(isPmWrapper('node node_modules\\concurrently\\dist\\bin\\concurrently.js -n a,b npm:a npm:b'), false);
    assert.equal(isPmWrapper(''), false);
    assert.equal(isPmWrapper(null), false);
  });

  test('topmostWrapper 连续包装层时取到最顶层', () => {
    // 1(shell) → 20(npx) → 21(npm) → 22(应用)
    const ppid = ppidMap([[20, 1], [21, 20], [22, 21]]);
    const cmds = cmdMap([
      [20, 'node .../npx-cli.js create-vite'],
      [21, 'node .../npm-cli.js run dev'],
      [22, 'node index.js'],
    ]);
    assert.equal(topmostWrapper(22, ppid, cmds), 20);
  });

  test('遇到非包装层就停（concurrently 不是包装层）', () => {
    // 10(npm) → 11(concurrently) → 12(应用)：不能把 concurrently 当包装层跳过
    const ppid = ppidMap([[10, 1], [11, 10], [12, 11]]);
    const cmds = cmdMap([
      [10, 'node .../npm-cli.js run dev'],
      [11, 'node .../concurrently.js -n a,b npm:a npm:b'],
      [12, 'node index.js'],
    ]);
    assert.equal(topmostWrapper(12, ppid, cmds), 12);
    // 而 concurrently 自身向上能找到 npm
    assert.equal(topmostWrapper(11, ppid, cmds), 10);
  });

  test('父进程不是包装层时保持自身', () => {
    const ppid = ppidMap([[20, 1]]);
    const cmds = cmdMap([[1, 'powershell.exe -Command node app.js']]);
    assert.equal(topmostWrapper(20, ppid, cmds), 20);
  });
});

describe('cmdLabel', () => {
  test('取路径最后两段作短标签', () => {
    assert.equal(cmdLabel(`node ${ROOT}\\gaea-mcp\\server.mjs`), 'gaea-mcp/server.mjs');
  });
  test('短路径原样', () => {
    assert.equal(cmdLabel('node index.js'), 'index.js');
  });
  test('空值返回空串', () => {
    assert.equal(cmdLabel(''), '');
    assert.equal(cmdLabel(null), '');
  });
});

describe('referencesProject / containsRoot（同前缀的兄弟目录不能误判）', () => {
  test('命中项目目录', () => {
    assert.equal(referencesProject(`node ${ROOT}\\node_modules\\vite\\bin\\vite.js`, [ROOT]), true);
  });
  test('同前缀的兄弟目录不算命中（gaea-rea-tools）', () => {
    assert.equal(referencesProject('node D:\\sgames\\gaea-rea-tools\\node_modules\\vite\\bin\\vite.js', [ROOT]), false);
  });
  test('路径边界：分隔符 / 结束 / 引号都算', () => {
    assert.equal(containsRoot('d:/sgames/gaea-rea/node_modules/x', 'd:/sgames/gaea-rea'), true);
    assert.equal(containsRoot('d:/sgames/gaea-rea', 'd:/sgames/gaea-rea'), true);
    assert.equal(containsRoot('"d:/sgames/gaea-rea" arg', 'd:/sgames/gaea-rea'), true);
    assert.equal(containsRoot('d:/sgames/gaea-reax', 'd:/sgames/gaea-rea'), false);
  });
  test('空值安全', () => {
    assert.equal(referencesProject(null, [ROOT]), false);
    assert.equal(referencesProject('node x', []), false);
  });
});

describe('corroboratesLaunch 支持多端口（同一个服务监听多个端口）', () => {
  test('已知端口集合里任意一个被监听即可佐证', () => {
    const ppid = ppidMap([[400, 1]]);
    const why = corroboratesLaunch({
      pid: 400, ppidOf: ppid, cmdOf: cmdMap([[400, 'node server.js']]),
      portsOfPid: () => [{ proto: 'tcp', port: 8080, address: '127.0.0.1' }],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`,
      declaredPorts: [3000, 8080, 5173],
    });
    assert.equal(why, 'port');
  });
  test('端口集合都不匹配时不算佐证', () => {
    const ppid = ppidMap([[401, 1]]);
    const why = corroboratesLaunch({
      pid: 401, ppidOf: ppid, cmdOf: cmdMap([[401, 'node server.js']]),
      portsOfPid: () => [{ proto: 'tcp', port: 9999, address: '127.0.0.1' }],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`,
      declaredPorts: [3000, 8080],
    });
    assert.equal(why, null);
  });
  test('仍兼容旧的 declaredPort 单端口入参', () => {
    const ppid = ppidMap([[402, 1]]);
    const why = corroboratesLaunch({
      pid: 402, ppidOf: ppid, cmdOf: cmdMap([[402, 'node server.js']]),
      portsOfPid: () => [{ proto: 'tcp', port: 8787, address: '127.0.0.1' }],
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPort: 8787,
    });
    assert.equal(why, 'port');
  });
  test('兄弟进程（跨 cmd.exe 垫片）监听另一端口也算佐证', () => {
    // 10(npm-cli) → 20(cmd.exe) → 30(vite) / 31(node api, 3000)
    const ppid = ppidMap([[10, 5], [20, 10], [30, 20], [31, 20]]);
    const cmds = cmdMap([
      [10, 'node C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run dev'],
      [30, `node ${ROOT}\\tools\\dev-proxy.js`],
      [31, 'node server/index.js'],
    ]);
    const why = corroboratesLaunch({
      pid: 10, ppidOf: ppid, cmdOf: cmds,
      portsOfPid: (pid) => (pid === 31 ? [{ proto: 'tcp', port: 3000, address: '127.0.0.1' }] : []),
      roots: [ROOT], packageJsonPath: `${ROOT}\\package.json`, declaredPorts: [3000],
    });
    assert.equal(why, 'port');
  });
});

describe('launchGroupRoot（多实例 / 多端口的核心）', () => {
  test('识别 shell 垫片', () => {
    assert.equal(isShellShimName('cmd.exe'), true);
    assert.equal(isShellShimName('powershell.exe'), true);
    assert.equal(isShellShimName('node.exe'), false);
    assert.equal(isShellShimName(''), false);
  });

  test('穿过 cmd.exe 垫片找到 npm 包装层作为启动根', () => {
    // 5(shell) → 10(node npm-cli) → 20(cmd.exe) → 30(vite) / 31(api)
    const ppid = ppidMap([[10, 5], [20, 10], [30, 20], [31, 20]]);
    const cmds = cmdMap([
      [10, 'node C:/nodejs/node_modules/npm/bin/npm-cli.js run dev'],
      [30, `node ${ROOT}\\node_modules\\vite\\bin\\vite.js`],
      [31, `node ${ROOT}\\server\\index.js`],
    ]);
    const names = nameMap([[10, 'node'], [20, 'cmd'], [30, 'node'], [31, 'node']]);
    const args = { ppidOf: ppid, nameOf: (pid) => names.get(pid), cmdOf: cmds, roots: [ROOT], packageJsonPath: `${ROOT}\\package.json` };
    assert.equal(launchGroupRoot({ pid: 30, ...args }), 10);
    assert.equal(launchGroupRoot({ pid: 31, ...args }), 10);
  });

  test('不穿过交互式终端（父进程不是 node、也不是启动垫片）', () => {
    // 30(node api) ← 40(pwsh 交互式)
    const ppid = ppidMap([[30, 40], [40, 1]]);
    const cmds = cmdMap([[30, `node ${ROOT}\\server\\index.js`]]);
    const names = nameMap([[30, 'node'], [40, 'pwsh']]);
    assert.equal(launchGroupRoot({
      pid: 30, ppidOf: ppid, nameOf: (pid) => names.get(pid), cmdOf: cmds, roots: [ROOT],
    }), 30);
  });

  test('上溯穿过 concurrently，一路取到 npm 包装层', () => {
    // 5(shell) → 10(npm) → 11(concurrently) → 20(cmd) → 30(vite) / 31(api)
    const ppid = ppidMap([[10, 5], [11, 10], [20, 11], [30, 20], [31, 20]]);
    const cmds = cmdMap([
      [10, 'node C:/nodejs/node_modules/npm/bin/npm-cli.js run dev'],
      [11, `node ${ROOT}\\node_modules\\concurrently\\dist\\bin\\concurrently.js -n a,b npm:a npm:b`],
      [30, `node ${ROOT}\\node_modules\\vite\\bin\\vite.js`],
    ]);
    const names = nameMap([[10, 'node'], [11, 'node'], [20, 'cmd']]);
    assert.equal(launchGroupRoot({
      pid: 30, ppidOf: ppid, nameOf: (pid) => names.get(pid), cmdOf: cmds, roots: [ROOT],
      packageJsonPath: `${ROOT}\\package.json`,
    }), 10);
  });
});

describe('collectKnownPorts', () => {
  test('合并配置端口、上次监听端口、崩溃端口并去重排序', () => {
    assert.deepEqual(collectKnownPorts(3000, [5173, 3000], 8787, null), [3000, 5173, 8787]);
  });
  test('过滤非法值', () => {
    assert.deepEqual(collectKnownPorts(0, -1, 70000, '3000'), [3000]);
    assert.deepEqual(collectKnownPorts(), []);
  });
});

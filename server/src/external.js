/**
 * 「外部运行探测」里的纯函数。
 *
 * 单独拆出来的原因有两个：
 *  1. 这些逻辑有过一次真实误判（把 `node <项目>/gaea-mcp/server.mjs` 认成服务在跑），
 *     最需要单元测试兜住；而 index.js 是服务入口，import 它就会起服务器，没法直接测。
 *  2. 顺带给 index.js 减负 —— 它一直是最大的文件。
 *
 * 这里只放**不依赖任何运行态**的函数：输入 pid 映射与命令行，输出判断结果。
 */

/** 路径归一化：统一分隔符、去尾斜杠、小写（Windows 大小写不敏感） */
export function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 从 ppid 链推算深度（越浅越可能是进程树根） */
export function depthOf(pid, ppidOf) {
  let depth = 0;
  let cur = pid;
  for (let i = 0; i < 32; i += 1) {
    const parent = ppidOf.get(cur);
    if (!parent || parent <= 0 || parent === cur) break;
    depth += 1;
    cur = parent;
  }
  return depth;
}

/** 候选优劣：先看信号强度，再看是不是树根（越浅越好） */
export function candidateRank(c) {
  const conf = c.confidence === 'high' ? 0 : 1;
  return conf * 1000 + Math.min(c.depth || 0, 99);
}

/** 收集某 pid 的整棵子树（含自身） */
export function subtreeOf(pid, ppidOf) {
  const childrenOf = new Map();
  for (const [child, parent] of ppidOf) {
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(child);
  }
  const out = new Set();
  const stack = [pid];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const c of childrenOf.get(cur) || []) stack.push(c);
  }
  return out;
}

/**
 * 校验「这棵进程树确实是从该项目启动的」，而不是仅仅命令里出现了这个路径。
 *
 * 这条校验是被真实误判逼出来的：`node D:\sgames\gaea-rea\gaea-mcp\server.mjs`
 * 是一个 MCP 服务器进程，命令行确实包含项目目录，但它跟被托管的 web 服务毫无关系。
 * 只看「路径包含」会把任何引用该目录的 node 进程都认成服务在跑。
 *
 * 能佐证的信号：
 *   a) 树里有进程引用 <root>/node_modules/ —— npm/pnpm 拉起项目脚本时的典型形态
 *   b) 树里有进程引用服务的 package.json
 *   c) 服务声明了端口，且树里有进程在监听它
 *
 * @returns {'node_modules'|'package.json'|'port'|null} 佐证方式；null 表示不能佐证
 */
export function corroboratesLaunch({ pid, ppidOf, cmdOf, portsOfPid, roots, packageJsonPath, declaredPort }) {
  const tree = subtreeOf(pid, ppidOf);
  const needles = [...(roots || []), packageJsonPath].filter(Boolean).map(normPath);
  for (const cur of tree) {
    const cmd = normPath(cmdOf.get(cur));
    if (cmd) {
      for (const needle of needles) {
        if (needle && cmd.includes(`${needle}/node_modules/`)) return 'node_modules';
        if (needle && cmd.includes(needle) && needle.endsWith('package.json')) return 'package.json';
      }
    }
    if (declaredPort) {
      const ports = portsOfPid(cur) || [];
      if (ports.some((p) => p.port === declaredPort)) return 'port';
    }
  }
  return null;
}

/** 包管理器包装进程（npm / pnpm / yarn / npx）—— 接管时优先选最顶层的它 */
export function isPmWrapper(cmd) {
  if (!cmd) return false;
  return /\b(npm-cli\.js|npx-cli\.js|pnpm\.c?js|yarn\.js|yarn\.cjs)\b/i.test(cmd);
}

/** 从候选 pid 向上找到最顶层的包管理器包装进程，作为接管目标 */
export function topmostWrapper(pid, ppidOf, cmdOf) {
  let best = pid;
  let cur = pid;
  for (let i = 0; i < 16; i += 1) {
    const parent = ppidOf.get(cur);
    if (!parent || parent <= 0 || !cmdOf.has(parent)) break;
    if (!isPmWrapper(cmdOf.get(parent))) break;
    best = parent;
    cur = parent;
  }
  return best;
}

/** 从命令行里取一个便于辨认的短标签，例如 gaea-mcp/server.mjs */
export function cmdLabel(commandLine) {
  if (!commandLine) return '';
  const tokens = String(commandLine).trim().split(/\s+/);
  const target = tokens.length > 1 ? tokens[tokens.length - 1] : tokens[0];
  const parts = target.replace(/["']/g, '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
}

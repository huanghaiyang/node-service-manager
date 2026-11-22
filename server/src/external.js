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

/**
 * 在已归一化的命令行里查找某个项目路径，要求「路径边界」匹配。
 *
 * 只做 includes 会误判同前缀的兄弟目录：`d:/sgames/gaea-rea` 会命中
 * `d:/sgames/gaea-rea-tools/...`。所以命中后还要看下一个字符是不是分隔符或结束。
 */
export function containsRoot(hay, needle) {
  if (!hay || !needle) return false;
  const boundary = new Set(['/', '"', "'", ' ', '\t', '\n', '\r', ';', ',', ')', ']', '}']);
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const next = hay[i + needle.length];
    if (next === undefined || boundary.has(next)) return true;
    i = hay.indexOf(needle, i + 1);
  }
  return false;
}

/** 命令行是否引用了该项目（不判断是否由项目启动，只判断引用） */
export function referencesProject(commandLine, roots, packageJsonPath = '') {
  const hay = normPath(commandLine);
  if (!hay) return false;
  const needles = [...(roots || []), packageJsonPath].map(normPath).filter(Boolean);
  return needles.some((needle) => containsRoot(hay, needle));
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
 *   c) 服务已知端口（配置的 / 上次实际监听过的 / 崩溃时撞到的）里，
 *      树中有进程正在监听 —— 同一个服务常常同时监听多个端口，
 *      所以这里判断的是**端口集合**，而不是单个声明端口。
 *
 * @returns {'node_modules'|'package.json'|'port'|null} 佐证方式；null 表示不能佐证
 */
export function corroboratesLaunch({
  pid, ppidOf, cmdOf, portsOfPid, roots, packageJsonPath, declaredPort, declaredPorts,
}) {
  const tree = subtreeOf(pid, ppidOf);
  const needles = [...(roots || []), packageJsonPath].filter(Boolean).map(normPath);
  const wantedPorts = new Set(
    [...(Array.isArray(declaredPorts) ? declaredPorts : []), declaredPort]
      .map(Number)
      .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535),
  );
  for (const cur of tree) {
    const cmd = normPath(cmdOf.get(cur));
    if (cmd) {
      for (const needle of needles) {
        if (!needle) continue;
        if (cmd.includes(`${needle}/node_modules/`)) return 'node_modules';
        if (needle.endsWith('package.json') && containsRoot(cmd, needle)) return 'package.json';
      }
    }
    if (wantedPorts.size) {
      const ports = portsOfPid(cur) || [];
      if (ports.some((p) => wantedPorts.has(Number(p.port)))) return 'port';
    }
  }
  return null;
}

/** 包管理器包装进程（npm / pnpm / yarn / npx）—— 接管时优先选最顶层的它 */
export function isPmWrapper(cmd) {
  if (!cmd) return false;
  return /\b(npm-cli\.js|npx-cli\.js|pnpm\.c?js|yarn\.js|yarn\.cjs)\b/i.test(cmd);
}

/**
 * 启动垫片：挂在 node 进程与终端之间的 shell，只负责把命令跑起来。
 *
 * Windows 下 `npm run dev` 的实际链条是：
 *   node(npm-cli.js) → cmd.exe /d /s /c "vite" → node(vite)
 * 中间的 cmd.exe 不是 node 进程，之前按「只在 node 父进程里上溯」的做法，
 * 会把同一棵启动树拆成互不相干的两个实例 —— 多端口服务因此只认到其中一个。
 */
export function isShellShimName(name) {
  const base = String(name || '').replace(/\.exe$/i, '').trim().toLowerCase();
  return ['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'busybox'].includes(base);
}

/**
 * 找到「这一组外部实例的启动根」。
 *
 * 从命中的 node 进程向上爬，只穿过：
 *   - 包管理器包装进程（npm / pnpm / yarn / npx 的 node 进程）
 *   - 命令行引用了本项目的 node 进程（concurrently / vite 之类）
 *   - 启动垫片（cmd.exe、sh -c 等非 node 进程）
 * 遇到交互式终端、IDE 等就停下。
 *
 * 返回的根 pid 的整棵子树（含跨垫片的兄弟进程）才是这个实例组；
 * 用它做采样根，多个端口、多个子服务才能一起被看见。
 */
export function launchGroupRoot({ pid, ppidOf, nameOf, cmdOf, roots, packageJsonPath }) {
  let best = pid;
  let cur = pid;
  for (let i = 0; i < 24; i += 1) {
    const parent = ppidOf.get(cur);
    if (!parent || parent <= 0 || parent === cur) break;
    if (cmdOf && cmdOf.has(parent)) {
      const parentCmd = cmdOf.get(parent);
      if (isPmWrapper(parentCmd) || referencesProject(parentCmd, roots, packageJsonPath)) {
        best = parent;
        cur = parent;
        continue;
      }
      break;
    }
    if (isShellShimName(nameOf ? nameOf(parent) : '')) {
      // 只穿过去，不把垫片本身当根（它没有可采样的 node 语义）
      cur = parent;
      continue;
    }
    break;
  }
  return best;
}

/**
 * 汇总一个服务「已知的端口」：配置声明 + 上次实际探测到的 + 崩溃时撞到的 + 本次注入的。
 *
 * 这是多端口修复的关键之一：绝大多数服务并没有配置 port（端口写在代码或 .env 里），
 * 旧逻辑只拿单个声明端口做判断，于是端口信号永远为空。
 */
export function collectKnownPorts(...sources) {
  const out = new Set();
  for (const source of sources) {
    const list = Array.isArray(source) ? source : [source];
    for (const value of list) {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535) out.add(port);
    }
  }
  return [...out].sort((a, b) => a - b);
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

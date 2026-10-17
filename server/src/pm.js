import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { STOP_GRACE_MS, AUTO_RESTART_MAX, AUTO_RESTART_WINDOW_MS } from './config.js';
import { analyzePackage, readPackageJson } from './packageScanner.js';
import { isAlive, sleep, quoteArg, normalizePath } from './util.js';

/**
 * 进程管理器：解析启动计划 → 启动 / 停止 / 重启 → 维护状态机。
 *
 * 启动方式优先级（mode）：
 *   node       直接 node <entry>                  —— 根进程即服务进程，指标最准
 *   node-bin   解析 node_modules/.bin 的 shim 后直接 node <js>  —— 同上，且不依赖 npm
 *   node-direct 脚本本身以 node 开头时直接执行
 *   npm-cli    node <npm-cli.js> run <script>     —— 兼容 npm scripts 的完整语义
 *   npm-shell  shell 执行 npm run <script>        —— 最后兜底
 */

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  EXITED: 'exited',
  CRASHED: 'crashed',
  ORPHANED: 'orphaned',
};

export { STATUS };

/* ----------------------------- 启动计划解析 -------------------------------- */

function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 找到 npm 的 CLI 入口，用于绕开 shell 启动 npm */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 把 node_modules/.bin/<name> 的 shim 解析成它真正执行的 JS 文件。
 * 这样我们就能直接 node <js>，根进程即为服务进程，指标不经过任何包装层。
 */
function resolveBinToJs(root, binName) {
  const binDir = path.join(root, 'node_modules', '.bin');
  const candidates = [binName, `${binName}.cmd`, `${binName}.ps1`, `${binName}.exe`, `${binName}.bat`];
  for (const name of candidates) {
    const shim = path.join(binDir, name);
    let st;
    try {
      st = fs.lstatSync(shim);
    } catch {
      continue;
    }
    try {
      if (st.isSymbolicLink()) {
        const target = fs.realpathSync(shim);
        if (/\.(js|cjs|mjs)$/i.test(target)) return target;
        continue;
      }
      if (!/\.(cmd|ps1|bat)$/i.test(name) && !name.includes('.')) {
        // POSIX 下无扩展名的 shim 本身常是带 shebang 的 JS
        const head = fs.readFileSync(shim, 'utf8').slice(0, 512);
        const m = head.match(/(?:exec\s+node|node)\s+"?\$?\{?basedir\}?\/?([^"\s]+\.(?:js|cjs|mjs))/i)
          || head.match(/^\s*#!.*\bnode\b/m);
        if (m) {
          if (m[1]) {
            const rel = m[1].replace(/^\.\//, '');
            const abs = path.resolve(binDir, rel);
            if (fs.existsSync(abs)) return abs;
          }
          return shim; // 本身是 node 可执行的脚本
        }
      }
      const text = fs.readFileSync(shim, 'utf8');
      // npm 生成的 .cmd：... "%dp0%\..\pkg\bin\cli.js" %*
      const m = text.match(/%dp0%\\?([^"%\r\n]+\.(?:js|cjs|mjs))/i)
        || text.match(/\$basedir\/\.\.\/([^"\s]+\.(?:js|cjs|mjs))/i)
        || text.match(/%~dp0\\?([^"%\r\n]+\.(?:js|cjs|mjs))/i);
      if (m) {
        const abs = path.resolve(binDir, m[1].replace(/^[\\/]+/, ''));
        if (fs.existsSync(abs)) return abs;
      }
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

function resolveScriptCommand(root, scriptName) {
  try {
    const pkg = readPackageJson(path.join(root, 'package.json'));
    const raw = pkg.scripts?.[scriptName];
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * 生成启动计划。返回结构会原样暴露给前端，便于使用者确认「到底跑了什么命令」。
 * @returns {{mode:string, exe:string, args:string[], shell:boolean, display:string, note?:string}}
 */
export function buildLaunchPlan(service) {
  const root = service.cwd || service.root;
  const nodeExe = process.execPath;
  const extraArgs = Array.isArray(service.args) ? service.args : [];

  if (service.runtime === 'node') {
    const info = analyzePackage(service.packageJsonPath);
    if (!info.entry) {
      throw Object.assign(new Error('未能自动识别入口文件，请改用 npm script 或自定义命令'), { code: 'NO_ENTRY' });
    }
    return {
      mode: 'node',
      exe: nodeExe,
      args: [info.entry, ...extraArgs],
      shell: false,
      display: `node ${path.relative(root, info.entry) || info.entry}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}`,
      note: '直接以 node 启动入口文件，根进程即服务进程',
    };
  }

  if (service.runtime === 'custom') {
    if (!service.command) {
      throw Object.assign(new Error('自定义命令为空'), { code: 'NO_COMMAND' });
    }
    const tokens = tokenize(service.command);
    return {
      mode: 'custom',
      exe: tokens[0],
      args: tokens.slice(1).concat(extraArgs),
      shell: true,
      display: [service.command, ...extraArgs].join(' '),
      note: '自定义命令，通过 shell 执行',
    };
  }

  // runtime === 'npm'
  const script = service.script;
  if (!script) {
    throw Object.assign(new Error('未指定 npm script'), { code: 'NO_SCRIPT' });
  }
  const command = resolveScriptCommand(root, script);
  if (!command) {
    throw Object.assign(new Error(`package.json 中不存在 script「${script}」`), { code: 'SCRIPT_NOT_FOUND' });
  }
  const tokens = tokenize(command);
  const head = tokens[0] || '';

  // 1) 脚本本身就是 node xxx.js
  if (/^node(\.exe)?$/i.test(head) && tokens[1]) {
    const first = tokens[1];
    const resolved = path.isAbsolute(first) ? first : path.resolve(root, first);
    const rest = tokens.slice(2);
    return {
      mode: 'node-direct',
      exe: nodeExe,
      args: [fs.existsSync(resolved) ? resolved : first, ...rest, ...extraArgs],
      shell: false,
      display: `node ${tokens.slice(1).join(' ')}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}`,
      note: `由 npm script「${script}」解析而来，已去除 npm 包装层`,
    };
  }

  // 2) bin 名可在 node_modules/.bin 中解析 → 直接 node 执行其 JS 入口
  if (head && !/^[.\/\\]/.test(head) && !/^(npm|pnpm|yarn|npx)$/i.test(head)) {
    const js = resolveBinToJs(root, head);
    if (js) {
      return {
        mode: 'node-bin',
        exe: nodeExe,
        args: [js, ...tokens.slice(1), ...extraArgs],
        shell: false,
        display: `node ${path.relative(root, js) || js}${tokens.length > 1 ? ` ${tokens.slice(1).join(' ')}` : ''}`,
        note: `已把 node_modules/.bin/${head} 解析为 JS 入口，指标不受包装层干扰`,
      };
    }
  }

  // 3) 兜底：npm run（优先直接用 node 调 npm-cli.js，避免 shell 引号地狱）
  const npmCli = findNpmCli();
  if (npmCli) {
    const args = [npmCli, 'run', script];
    if (extraArgs.length) args.push('--', ...extraArgs);
    return {
      mode: 'npm-cli',
      exe: nodeExe,
      args,
      shell: false,
      display: `npm run ${script}${extraArgs.length ? ` -- ${extraArgs.join(' ')}` : ''}`,
      note: '通过 npm CLI 启动；指标为进程树口径（若平台支持）',
    };
  }

  const cmdline = ['npm', 'run', script, ...(extraArgs.length ? ['--', ...extraArgs.map((a) => quoteArg(a))] : [])].join(' ');
  return {
    mode: 'npm-shell',
    exe: cmdline,
    args: [],
    shell: true,
    display: cmdline,
    note: '未找到 npm-cli.js，改用 shell 执行',
  };
}

/* ------------------------------ 进程管理器 --------------------------------- */

/**
 * 从日志尾部识别「端口被占用」并提取端口号。
 *
 * Node 生态里 EADDRINUSE 的呈现形式很杂：
 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:8787
 *   Error: listen EADDRINUSE: address already in use :::8787
 *   后面还可能跟着 stack 与 { address: '127.0.0.1', port: 8787 }
 * 所以先定位 EADDRINUSE，再在它附近若干行里找端口号。
 */
export function detectPortInUse(lines) {
  const text = (lines || []).map((l) => String(l?.text ?? l));
  const start = text.findIndex((t) => /EADDRINUSE|address already in use/i.test(t));
  if (start < 0) return null;
  // 同一行里通常直接带端口：127.0.0.1:8787 / :::8787 / :8787
  const inline = text[start].match(/:(\d{2,5})\b/);
  if (inline) {
    const port = Number(inline[1]);
    if (port > 0 && port <= 65535) return port;
  }
  // 否则看后续 stack 里的 port: 8787
  for (let i = start + 1; i < Math.min(text.length, start + 15); i += 1) {
    const m = text[i].match(/port:\s*(\d{2,5})\b/);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port <= 65535) return port;
    }
  }
  return null;
}

export class ProcessManager extends EventEmitter {
  /**
   * @param {import('./store.js').ServiceStore} store
   * @param {import('./logs.js').LogStore} logs
   */
  constructor(store, logs) {
    super();
    this.store = store;
    this.logs = logs;
    /** @type {Map<string, object>} 运行时状态 */
    this.runtime = new Map();
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.children = new Map();
    this.restartHistory = new Map();
    this._reconcileTimer = null;
  }

  /** 状态（供 API 输出），不含函数与外部句柄 */
  stateOf(id) {
    const s = this.runtime.get(id) || {};
    const child = this.children.get(id);
    const alive = child ? child.exitCode === null && !child.killed : isAlive(s.pid);
    return {
      status: s.status || STATUS.STOPPED,
      pid: s.pid || null,
      startedAt: s.startedAt || null,
      stoppedAt: s.stoppedAt || null,
      exitCode: s.exitCode ?? null,
      signal: s.signal ?? null,
      lastError: s.lastError || null,
      restarts: s.restarts || 0,
      autoRestartScheduled: Boolean(s.autoRestartScheduled),
      // 本次运行实际注入的端口（可能来自端口冲突时的临时选择）
      effectivePort: s.effectivePort ?? null,
      // 崩溃时识别出的被占用端口（由 API 层补充占用者信息）
      crashPort: s.crashPort ?? null,
      alive,
      plan: s.plan || null,
      logPaths: this.logs.paths(id),
      uptimeMs: s.startedAt && (s.status === STATUS.RUNNING || s.status === STATUS.STARTING)
        ? Date.now() - new Date(s.startedAt).getTime()
        : 0,
    };
  }

  _set(id, patch) {
    const cur = this.runtime.get(id) || { status: STATUS.STOPPED, restarts: 0 };
    const next = { ...cur, ...patch };
    this.runtime.set(id, next);
    this.emit('status', id, this.stateOf(id));
    return next;
  }

  /** 管理端启动时对齐磁盘状态：识别「进程还在但不由本端托管」的残留服务 */
  reconcileOnBoot() {
    for (const svc of this.store.list()) {
      const last = svc.lastPid;
      if (last && isAlive(last)) {
        this._set(svc.id, {
          status: STATUS.ORPHANED,
          pid: last,
          startedAt: svc.lastStartedAt || null,
          lastError: '检测到上次托管启动的进程仍在运行，但已脱离本管理端控制（可能是管理端重启导致）',
        });
        this.logs.loadTail(svc.id, 200);
        this.logs.append(svc.id, `检测到残留进程 PID=${last}，已标记为「外部运行中」`, 'system');
      } else {
        this._set(svc.id, { status: STATUS.STOPPED, pid: null, restarts: 0 });
        this.logs.loadTail(svc.id, 200);
      }
    }
    this.startReconcileLoop();
  }

  startReconcileLoop() {
    if (this._reconcileTimer) return;
    this._reconcileTimer = setInterval(() => {
      for (const [id, s] of this.runtime) {
        if (!s.pid) continue;
        if (s.status === STATUS.RUNNING || s.status === STATUS.STARTING || s.status === STATUS.ORPHANED) {
          if (!isAlive(s.pid)) {
            this.children.delete(id);
            this._set(id, {
              status: STATUS.EXITED,
              stoppedAt: new Date().toISOString(),
              lastError: s.lastError || '进程已不存在（外部终止或异常退出）',
            });
          }
        }
      }
    }, 3000);
    if (this._reconcileTimer.unref) this._reconcileTimer.unref();
  }

  /** 启动服务（可通过 portOverride 临时指定端口，用于端口冲突后换端口启动） */
  async start(id, { portOverride = null } = {}) {
    const svc = this.store.get(id);
    if (!svc) throw Object.assign(new Error('服务不存在'), { code: 'NOT_FOUND' });
    const st = this.stateOf(id);
    if (st.status === STATUS.RUNNING || st.status === STATUS.STARTING) {
      throw Object.assign(new Error('服务已在运行中'), { code: 'ALREADY_RUNNING' });
    }
    if (st.status === STATUS.ORPHANED) {
      throw Object.assign(new Error('该服务有残留进程仍在运行，请先点击「终止残留进程」'), { code: 'ORPHANED' });
    }
    if (!fs.existsSync(svc.packageJsonPath)) {
      throw Object.assign(new Error(`package.json 不存在：${svc.packageJsonPath}`), { code: 'PACKAGE_MISSING' });
    }
    if (!fs.existsSync(svc.cwd)) {
      throw Object.assign(new Error(`工作目录不存在：${svc.cwd}`), { code: 'CWD_MISSING' });
    }

    const plan = buildLaunchPlan(svc);
    const { outFd, errFd } = this.logs.openForService(id);
    this.logs.append(id, `准备启动：${plan.display}`, 'system');
    if (plan.note) this.logs.append(id, `启动方式：${plan.mode}（${plan.note}）`, 'system');

    const env = {
      ...process.env,
      ...svc.env,
      SM_MANAGED: '1',
      SM_SERVICE_ID: id,
      SM_SERVICE_NAME: svc.name,
    };
    // 端口注入优先级：本次覆盖 > 服务配置。
    // 注意 dotenv 默认不覆盖已存在的环境变量，所以这里注入的 PORT 会盖过项目 .env 里的值，
    // 这正是「项目 .env 写的端口和前端代理对不上」时最省事的修法。
    const effectivePort = Number(portOverride) > 0 ? Number(portOverride) : (svc.port || null);
    if (effectivePort) env.PORT = String(effectivePort);

    let child;
    try {
      child = spawn(plan.exe, plan.args, {
        cwd: svc.cwd,
        env,
        shell: plan.shell,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        // POSIX 下新开进程组，停止时可按组整体终止
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      this.logs.append(id, `启动失败：${err.message}`, 'stderr');
      this._set(id, { status: STATUS.CRASHED, lastError: `启动失败：${err.message}`, pid: null });
      throw Object.assign(new Error(`启动失败：${err.message}`), { code: 'SPAWN_FAILED' });
    }

    this.children.set(id, child);
    // 「代次」：进程被操作系统回收与其 exit 事件送达之间存在时间差，
    // 若期间已经启动了下一代替换进程，这个迟到的 exit 绝不能再去改写新进程的状态与 PID，
    // 否则新进程会彻底失去托管（状态变 crashed、pid 变 null，但进程还在跑并占着端口）。
    const gen = (this.runtime.get(id)?.gen || 0) + 1;
    this._set(id, {
      status: STATUS.STARTING,
      gen,
      pid: child.pid,
      effectivePort,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      signal: null,
      lastError: null,
      autoRestartScheduled: false,
      // 新一轮生命周期开始，清掉上一轮的「主动停止」意图
      pendingStop: false,
      plan: { mode: plan.mode, display: plan.display, note: plan.note || '', exe: plan.exe, args: plan.args },
    });
    this.store.update(id, { lastPid: child.pid, lastStartedAt: new Date().toISOString() });
    this.logs.append(id, `已启动，PID=${child.pid}`, 'system');

    const startTs = Date.now();
    const promote = setTimeout(() => {
      const cur = this.runtime.get(id);
      if (cur && cur.status === STATUS.STARTING && isAlive(child.pid)) {
        this._set(id, { status: STATUS.RUNNING });
        this.logs.append(id, `服务进入运行状态（PID=${child.pid}）`, 'system');
      }
    }, 1200);
    if (promote.unref) promote.unref();

    child.on('error', (err) => {
      if ((this.runtime.get(id)?.gen || 0) !== gen) return; // 陈旧事件，忽略
      this.logs.append(id, `子进程错误：${err.message}`, 'stderr');
      this._set(id, { status: STATUS.CRASHED, lastError: err.message, pid: null });
      this.children.delete(id);
    });

    child.on('exit', (code, signal) => {
      const cur = this.runtime.get(id) || {};
      // 迟到的上一代 exit：既不能改状态，也不能删掉当前这一代的 child 句柄
      if (cur.gen !== gen) return;
      this.children.delete(id);
      // 进程可能已被操作系统回收，但 exit 事件稍后才送达。
      // 因此不能只看「当前状态是否为 stopping」，还要看本轮的主动停止意图是否已被消费，
      // 否则显式 stop() 之后到达的 exit 会把状态错误地回写成 crashed。
      const userStopped = cur.status === STATUS.STOPPING || cur.pendingStop === true;
      const lifetime = Date.now() - startTs;
      const failed = !userStopped && (code !== 0 && code !== null);
      const status = userStopped ? STATUS.STOPPED : (failed ? STATUS.CRASHED : STATUS.EXITED);

      // 失败退出时尝试从日志里认出「端口被占用」这类最常见、也最容易被误判为
      // 「服务没起来」的原因，把端口号记进运行时状态，由 API 层补上占用者信息。
      let crashPort = null;
      if (failed) {
        try {
          // 先强制把日志文件里尚未被 tailer 轮询到的内容读出来：
          // 快速崩溃时 exit 事件往往早于 250ms 的日志轮询，否则读到的尾部还是空的
          this.logs.poll(id);
          crashPort = detectPortInUse(this.logs.read(id, 80).lines);
        } catch { /* 日志读取失败不影响状态机 */ }
      }

      this.logs.append(
        id,
        userStopped
          ? `服务已停止（exit=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`
          : `服务退出：code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}，存活 ${(lifetime / 1000).toFixed(1)}s`,
        'system',
      );
      this._set(id, {
        status,
        pid: null,
        stoppedAt: new Date().toISOString(),
        exitCode: code,
        signal: signal || null,
        lastError: failed
          ? (crashPort ? `端口 ${crashPort} 已被占用，进程无法监听（EADDRINUSE）` : `进程异常退出（code=${code}）`)
          : null,
        crashPort,
        autoRestartScheduled: false,
        pendingStop: false,
      });
      this.store.update(id, { lastPid: null });
      if (!userStopped && svc.autoRestart && lifetime > 500) this._scheduleAutoRestart(id);
    });

    return this.stateOf(id);
  }

  _scheduleAutoRestart(id) {
    const now = Date.now();
    const hist = (this.restartHistory.get(id) || []).filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
    if (hist.length >= AUTO_RESTART_MAX) {
      this.logs.append(id, `自动重启次数已达上限（${AUTO_RESTART_MAX} 次/分钟），停止重试`, 'stderr');
      this._set(id, { autoRestartScheduled: false });
      return;
    }
    const delay = Math.min(1000 * 2 ** hist.length, 15000);
    hist.push(now);
    this.restartHistory.set(id, hist);
    this._set(id, { autoRestartScheduled: true });
    this.logs.append(id, `将在 ${(delay / 1000).toFixed(0)}s 后自动重启（第 ${hist.length} 次）`, 'system');
    const t = setTimeout(async () => {
      try {
        // 自动重启沿用本次运行实际使用的端口，避免又撞回被占用的那个
        await this.start(id, { portOverride: this.runtime.get(id)?.effectivePort ?? null });
        const cur = this.runtime.get(id) || {};
        this._set(id, { restarts: (cur.restarts || 0) + 1, autoRestartScheduled: false });
      } catch (err) {
        this.logs.append(id, `自动重启失败：${err.message}`, 'stderr');
        this._set(id, { autoRestartScheduled: false });
      }
    }, delay);
    if (t.unref) t.unref();
  }

  /** 停止服务；force=true 直接强杀 */
  async stop(id, { force = false, timeoutMs = STOP_GRACE_MS } = {}) {
    const svc = this.store.get(id);
    if (!svc) throw Object.assign(new Error('服务不存在'), { code: 'NOT_FOUND' });
    const st = this.stateOf(id);
    const pid = st.pid;
    if (!pid) {
      this._set(id, { status: STATUS.STOPPED, pid: null });
      return { stopped: true, alreadyStopped: true };
    }
    this._set(id, { status: STATUS.STOPPING, lastError: null, pendingStop: true });
    this.logs.append(id, `正在停止 PID=${pid}${force ? '（强制）' : ''}…`, 'system');
    const ok = await this.killTree(pid, { force, timeoutMs });
    if (!ok) {
      this.logs.append(id, `停止失败：进程树可能未被完全终止（PID=${pid}）`, 'stderr');
      this._set(id, { status: STATUS.CRASHED, pid, lastError: '停止超时，进程可能仍在运行' });
      throw Object.assign(new Error('停止超时，进程可能仍在运行'), { code: 'STOP_TIMEOUT' });
    }
    this.children.delete(id);
    this.store.update(id, { lastPid: null });
    // 注意：这里不覆盖 exitCode/signal，也不清除 pendingStop ——
    // 让稍后到达的 exit 事件负责消费停止意图并记录真实退出码。
    this._set(id, {
      status: STATUS.STOPPED,
      pid: null,
      stoppedAt: new Date().toISOString(),
    });
    this.logs.append(id, '已停止', 'system');
    return { stopped: true };
  }

  async restart(id, opts = {}) {
    await this.stop(id).catch((err) => {
      if (err.code !== 'NOT_FOUND') throw err;
    });
    // 留一点时间让上一代进程的监听套接字彻底释放，避免新进程撞上 EADDRINUSE
    await sleep(500);
    return this.start(id, opts);
  }

  /** 终止「外部运行中」的残留进程 */
  async killOrphan(id) {
    const st = this.stateOf(id);
    if (!st.pid) {
      this._set(id, { status: STATUS.STOPPED, pid: null });
      return { killed: false };
    }
    const ok = await this.killTree(st.pid, { force: true, timeoutMs: 4000 });
    this.store.update(id, { lastPid: null });
    // 残留进程不属于本轮托管（没有 child 句柄，不会有 exit 事件），因此不涉及 pendingStop
    this._set(id, { status: STATUS.STOPPED, pid: null, stoppedAt: new Date().toISOString(), lastError: null });
    this.logs.append(id, `残留进程 PID=${st.pid} 已${ok ? '终止' : '尝试终止（结果未知）'}`, 'system');
    return { killed: ok };
  }

  /**
   * 终止整棵进程树。
   *
   * Windows：taskkill /T 由系统维护的父子关系做整树终止；控制台类进程没有窗口消息，
   *   所以「优雅」一次通常无效，会在短暂等待后升级为 /F。若 taskkill 本身不可用
   *   （受限环境），最后用 Node 原生 process.kill 兜底终止根进程。
   * POSIX：对进程组发 SIGTERM，超时后 SIGKILL，保证 npm/pnpm 之类的包装层不留孤儿。
   */
  async killTree(pid, { force = false, timeoutMs = STOP_GRACE_MS } = {}) {
    if (!isAlive(pid)) return true;

    if (process.platform === 'win32') {
      if (!force) {
        await this._runTaskkill(pid, false);
        if (await this._waitGone(pid, Math.min(timeoutMs, 2000))) return true;
      }
      await this._runTaskkill(pid, true);
      if (await this._waitGone(pid, 1800)) return true;
      // taskkill 不可用时的兜底（例如权限受限的运行环境）
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* ignore */ }
      return this._waitGone(pid, 1000);
    }

    const send = (sig) => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        try {
          process.kill(pid, sig);
          return true;
        } catch {
          return false;
        }
      }
    };
    if (!force) send('SIGTERM');
    if (await this._waitGone(pid, force ? 0 : timeoutMs)) return true;
    send('SIGKILL');
    return this._waitGone(pid, 1500);
  }

  _runTaskkill(pid, force) {
    return new Promise((resolve) => {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      let tk;
      try {
        tk = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(true); } };
      tk.on('error', () => { if (!settled) { settled = true; resolve(false); } });
      tk.on('exit', done);
      setTimeout(() => { try { tk.kill('SIGKILL'); } catch { /* ignore */ } done(); }, 5000);
    });
  }

  async _waitGone(pid, ms) {
    const deadline = Date.now() + ms;
    // 给进程一个立即消失的机会，避免最后一次多余的等待
    if (!isAlive(pid)) return true;
    while (Date.now() < deadline) {
      await sleep(120);
      if (!isAlive(pid)) return true;
    }
    return !isAlive(pid);
  }

  stopAll() {
    const ids = [...this.runtime.keys()];
    return Promise.allSettled(ids.map(async (id) => {
      const st = this.stateOf(id);
      if (st.pid) await this.killTree(st.pid, { force: true, timeoutMs: 3000 });
    }));
  }

  dispose() {
    if (this._reconcileTimer) clearInterval(this._reconcileTimer);
    this._reconcileTimer = null;
  }
}

export { resolveBinToJs, findNpmCli, tokenize };

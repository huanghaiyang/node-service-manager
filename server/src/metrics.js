import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureStdout } from './util.js';

/**
 * 跨平台进程指标采集。
 *
 * 采集策略（按能力自动降级，并如实上报当前作用域）：
 *   wmi   Windows 且 WMI/CIM 可读 → 一次枚举全表，支持完整进程树聚合
 *   proc  Linux → 直接读 /proc，支持完整进程树聚合
 *   ps    macOS → ps 快照，支持完整进程树聚合
 *   basic Windows 但 WMI 被拒 → 仅按 PID 查询主进程，作用域退化为单进程
 *
 * 说明：子进程输出统一走「文件描述符 stdio」而不是管道（见 util.captureStdout），
 * 这既避免了管道背压，也让日志可以落盘留存。
 */

/* ------------------------------- Windows ---------------------------------- */

const PS = process.platform === 'win32'
  ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe')
  : 'powershell.exe';

function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

const WMI_QUERY = [
  '$ErrorActionPreference="Stop";',
  '$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name |',
  '  ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId;',
  '    rss=[long]$_.WorkingSetSize; kt=[long]$_.KernelModeTime; ut=[long]$_.UserModeTime; name=[string]$_.Name } });',
  'if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress -Depth 3 }',
].join(' ');

async function sampleViaWmi() {
  const res = await captureStdout(PS, psArgs(WMI_QUERY), { timeoutMs: 25000 });
  if (!res.ok || !res.text.trim()) return null;
  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) rows = [rows];
  const map = new Map();
  for (const r of rows) {
    const pid = Number(r.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    map.set(pid, {
      pid,
      ppid: Number(r.ppid) || 0,
      name: String(r.name || '').replace(/\.exe$/i, ''),
      rss: Number(r.rss) || 0,
      // KernelModeTime / UserModeTime 单位为 100 纳秒
      cpuSeconds: ((Number(r.kt) || 0) + (Number(r.ut) || 0)) / 1e7,
    });
  }
  return map;
}

function basicQuery(pids) {
  const list = pids.join(',');
  return [
    `$rows = @(Get-Process -Id ${list} -ErrorAction SilentlyContinue |`,
    '  Select-Object Id,ProcessName,WorkingSet64,CPU);',
    'if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress -Depth 3 }',
  ].join(' ');
}

async function sampleViaBasic(knownPids) {
  if (!knownPids.length) return new Map();
  const res = await captureStdout(PS, psArgs(basicQuery(knownPids)), { timeoutMs: 20000 });
  if (!res.ok || !res.text.trim()) return new Map();
  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch {
    return new Map();
  }
  if (!Array.isArray(rows)) rows = [rows];
  const map = new Map();
  for (const r of rows) {
    const pid = Number(r.Id);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    map.set(pid, {
      pid,
      ppid: 0, // 该降级通道拿不到父子关系
      name: String(r.ProcessName || ''),
      rss: Number(r.WorkingSet64) || 0,
      cpuSeconds: Number(r.CPU) || 0,
    });
  }
  return map;
}

/* -------------------------------- POSIX ----------------------------------- */

const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;

async function sampleViaProc() {
  const map = new Map();
  let names;
  try {
    names = await fsp.readdir('/proc');
  } catch {
    return null;
  }
  for (const entry of names) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const rest = stat.slice(close + 2).split(' ');
      const ppid = Number(rest[1]);
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      const rssPages = Number(rest[23]);
      map.set(pid, {
        pid,
        ppid: Number.isInteger(ppid) ? ppid : 0,
        name,
        rss: Number.isFinite(rssPages) ? rssPages * PAGE_SIZE : 0,
        cpuSeconds: (utime + stime) / CLOCK_TICKS,
      });
    } catch {
      /* 进程可能已退出 */
    }
  }
  return map;
}

function parsePsTime(text) {
  // [[dd-]hh:]mm:ss[.ss]
  let days = 0;
  let rest = text.trim();
  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = Number(d) || 0;
    rest = r;
  }
  const parts = rest.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds + days * 86400;
}

async function sampleViaPs() {
  const res = await captureStdout('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { timeoutMs: 15000 });
  if (!res.ok || !res.text.trim()) return null;
  const map = new Map();
  for (const line of res.text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    map.set(pid, {
      pid,
      ppid: Number(m[2]) || 0,
      name: path.basename(m[5].trim()),
      rss: Number(m[3]) * 1024,
      cpuSeconds: parsePsTime(m[4]),
    });
  }
  return map;
}

/* ------------------------------ 采样器 ------------------------------------ */

const PROVIDER_LABEL = {
  wmi: 'WMI 全表（支持进程树）',
  proc: '/proc（支持进程树）',
  ps: 'ps 快照（支持进程树）',
  basic: 'PowerShell Get-Process（仅主进程）',
  none: '不可用',
};

export class ProcessSampler {
  constructor() {
    this.provider = null;
    this.treeSupported = false;
    this.warning = '';
    this._probing = null;
    /** @type {Map<number, {cpuSeconds:number, rss:number}>} */
    this._prev = new Map();
    this._prevTs = 0;
    this._lastFull = new Map();
    this._hostPrev = null;
    this.cores = os.cpus().length || 1;
    /** 最近一次全表快照，供只读查询复用 */
    this.lastSnapshot = null;
    /** node 进程详情（命令行/启动时间）缓存，按需查询 */
    this._nodeDetail = null;
    /** 降级模式下的 node 进程枚举缓存与 CPU 基线 */
    this._nodeList = null;
    this._nodeBasicPrev = null;
  }

  get providerLabel() {
    return PROVIDER_LABEL[this.provider] || PROVIDER_LABEL.none;
  }

  async detect(force = false) {
    if (this.provider && !force) return this.provider;
    if (this._probing) return this._probing;
    this._probing = (async () => {
      if (process.platform === 'linux') {
        const s = await sampleViaProc();
        this._set(s ? 'proc' : 'none', s);
      } else if (process.platform === 'darwin') {
        const s = await sampleViaPs();
        this._set(s ? 'ps' : 'none', s);
      } else if (process.platform === 'win32') {
        const s = await sampleViaWmi();
        if (s) this._set('wmi', s);
        else {
          const basic = await sampleViaBasic([process.pid]);
          if (basic.size) {
            this.provider = 'basic';
            this.treeSupported = false;
            this.warning = '当前环境无法读取 WMI（进程父子关系不可用），指标仅统计服务主进程；建议在服务配置里使用「直接 node 启动」以获得准确占用。';
          } else {
            this.provider = 'none';
            this.treeSupported = false;
            this.warning = '当前环境无法采集外部进程指标。';
          }
        }
      } else {
        this.provider = 'none';
        this.warning = `暂不支持的平台：${process.platform}`;
      }
      this._probing = null;
      return this.provider;
    })();
    return this._probing;
  }

  _set(provider, snapshot) {
    this.provider = provider;
    this.treeSupported = provider !== 'basic';
    this.warning = '';
    if (snapshot) this._lastFull = snapshot;
  }

  /**
   * 采样一次。
   * @param {number[]} rootPids 当前托管服务的根 PID
   * @returns {Promise<Map<number, object>>}
   */
  async sample(rootPids = []) {
    await this.detect();
    let full = null;
    if (this.provider === 'proc') full = await sampleViaProc();
    else if (this.provider === 'ps') full = await sampleViaPs();
    else if (this.provider === 'wmi') full = await sampleViaWmi();

    if (full) {
      this._lastFull = full;
    } else {
      // 降级：只查根 PID，保留上一次全表结果用于名字展示
      const basic = await sampleViaBasic(rootPids.filter((p) => Number.isInteger(p) && p > 0));
      const merged = new Map();
      for (const [pid, row] of basic) merged.set(pid, row);
      full = merged;
      if (this.provider === 'wmi') this.provider = 'basic';
    }

    const ts = Date.now();
    const dt = this._prevTs ? (ts - this._prevTs) / 1000 : 0;
    const cpuByPid = new Map();
    for (const [pid, row] of full) {
      const prev = this._prev.get(pid);
      if (prev && dt > 0 && row.cpuSeconds >= prev.cpuSeconds) {
        cpuByPid.set(pid, (row.cpuSeconds - prev.cpuSeconds) / dt);
      } else {
        cpuByPid.set(pid, 0);
      }
    }
    this._prev = new Map([...full].map(([pid, row]) => [pid, { cpuSeconds: row.cpuSeconds, rss: row.rss }]));
    this._prevTs = ts;

    // 保留最近一次全表快照，供「进程检测器」等只读查询复用，避免重复采集
    this.lastSnapshot = {
      processes: full,
      cpuByPid,
      ts,
      cores: this.cores,
      provider: this.provider,
      treeSupported: this.treeSupported,
    };

    return { processes: full, cpuByPid, ts, cores: this.cores, provider: this.provider, treeSupported: this.treeSupported };
  }

  /** 汇总某个根进程的整棵进程树 */
  aggregate(snapshot, rootPid) {
    const { processes, cpuByPid, cores, treeSupported } = snapshot;
    const result = {
      pid: rootPid,
      alive: processes.has(rootPid),
      processCount: 0,
      memoryBytes: 0,
      cpuPercent: 0,
      cpuPercentPerCore: 0,
      scope: treeSupported ? 'tree' : 'process',
      processes: [],
    };
    if (!Number.isInteger(rootPid) || rootPid <= 0) return result;

    let members = [];
    if (treeSupported) {
      // 从根出发做一次广度遍历，构建后代集合
      const childrenOf = new Map();
      for (const row of processes.values()) {
        if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
        childrenOf.get(row.ppid).push(row.pid);
      }
      const seen = new Set([rootPid]);
      const queue = [rootPid];
      while (queue.length) {
        const cur = queue.shift();
        for (const child of childrenOf.get(cur) || []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      members = [...seen];
    } else {
      members = processes.has(rootPid) ? [rootPid] : [];
    }

    let cpuSum = 0;
    for (const pid of members) {
      const row = processes.get(pid);
      if (!row) continue;
      const cpu = cpuByPid.get(pid) || 0;
      cpuSum += cpu;
      result.processCount += 1;
      result.memoryBytes += row.rss || 0;
      result.processes.push({
        pid,
        ppid: row.ppid,
        name: row.name,
        rss: row.rss || 0,
        cpuPercent: cpu / cores * 100,
        isRoot: pid === rootPid,
      });
    }
    result.processes.sort((a, b) => b.rss - a.rss);
    result.cpuPercent = cpuSum / cores * 100;   // 占整机算力（任务管理器口径）
    result.cpuPercentPerCore = cpuSum * 100;    // 单核基准（top/pidusage 口径）
    return result;
  }

  /**
   * 枚举本机所有 node 进程，供「进程检测器」使用。
   *
   * 与常规采样共用结果：Linux /proc、macOS ps、Windows WMI 这些能拿到全表的 provider
   * 直接复用最近一次快照；只有在 Windows WMI 不可用的降级场景下，才用
   * `Get-Process -Name node` 单独枚举（拿不到父子关系与命令行，但至少能看到进程）。
   *
   * @param {{ force?: boolean, ttlMs?: number }} [opts]
   */
  async listNodeProcesses({ force = false, ttlMs = 4000 } = {}) {
    if (!force && this._nodeList && Date.now() - this._nodeList.ts < ttlMs) {
      return this._nodeList;
    }

    const snap = this.lastSnapshot;
    if (snap && this.treeSupported && snap.processes.size) {
      this._nodeList = {
        source: 'snapshot',
        ts: snap.ts,
        cores: snap.cores,
        rows: [...snap.processes.values()].filter((r) => NODE_NAME_RE.test(r.name || '')),
        cpuByPid: snap.cpuByPid,
      };
      return this._nodeList;
    }

    if (process.platform === 'win32') {
      const basic = await nodeListViaBasic();
      if (basic) {
        const now = Date.now();
        const prev = this._nodeBasicPrev;
        const cpuByPid = new Map();
        const dt = prev ? (now - prev.ts) / 1000 : 0;
        for (const row of basic) {
          const before = prev?.cpu.get(row.pid);
          cpuByPid.set(
            row.pid,
            before !== undefined && dt > 0 && row.cpuSeconds >= before
              ? (row.cpuSeconds - before) / dt
              : 0,
          );
        }
        this._nodeBasicPrev = { ts: now, cpu: new Map(basic.map((r) => [r.pid, r.cpuSeconds])) };
        this._nodeList = { source: 'basic', ts: now, cores: this.cores, rows: basic, cpuByPid };
        return this._nodeList;
      }
    }

    this._nodeList = { source: 'none', ts: Date.now(), cores: this.cores, rows: [], cpuByPid: new Map() };
    return this._nodeList;
  }

  /**
   * 解析一批 PID 的进程名（用于端口冲突弹窗里「谁占用了这个端口」）。
   * 优先用最近一次快照；快照里没有（例如降级模式下只含托管根进程）就单独查一次。
   * @returns {Promise<Map<number, string>>}
   */
  async resolveProcessNames(pids = []) {
    const want = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    const out = new Map();
    if (!want.length) return out;

    const snap = this.lastSnapshot;
    const missing = [];
    for (const pid of want) {
      const row = snap?.processes.get(pid);
      if (row?.name) out.set(pid, row.name);
      else missing.push(pid);
    }
    if (!missing.length) return out;

    try {
      if (process.platform === 'win32') {
        const list = missing.join(',');
        const script = [
          `$rows = @(Get-Process -Id ${list} -ErrorAction SilentlyContinue |`,
          '  Select-Object Id,ProcessName);',
          'if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress }',
        ].join(' ');
        const res = await captureStdout(PS, psArgs(script), { timeoutMs: 15000 });
        if (res.ok && res.text.trim()) {
          let rows = JSON.parse(res.text);
          if (!Array.isArray(rows)) rows = [rows];
          for (const r of rows) {
            const pid = Number(r.Id);
            if (Number.isInteger(pid)) out.set(pid, String(r.ProcessName || ''));
          }
        }
      } else if (process.platform === 'linux') {
        for (const pid of missing) {
          try {
            out.set(pid, (await fsp.readFile(`/proc/${pid}/comm`, 'utf8')).trim());
          } catch { /* 进程已退出 */ }
        }
      } else if (process.platform === 'darwin') {
        const res = await captureStdout('/bin/ps', ['-axo', 'pid=,comm='], { timeoutMs: 12000 });
        if (res.ok) {
          for (const line of res.text.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(.*)$/);
            if (m && missing.includes(Number(m[1]))) out.set(Number(m[1]), path.basename(m[2].trim()));
          }
        }
      }
    } catch { /* 解析不到就留空，不影响占用判定 */ }
    return out;
  }

  hostMetrics() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    let usagePercent = null;
    if (this._hostPrev) {
      const dIdle = idle - this._hostPrev.idle;
      const dTotal = total - this._hostPrev.total;
      if (dTotal > 0) usagePercent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    }
    this._hostPrev = { idle, total };
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const load = os.loadavg();
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model?.trim() || 'unknown',
      cores: cpus.length,
      cpuUsagePercent: usagePercent,
      loadavg: load.map((n) => Number(n.toFixed(2))),
      totalMemory: totalMem,
      freeMemory: freeMem,
      usedMemory: totalMem - freeMem,
      memoryUsagePercent: totalMem ? (totalMem - freeMem) / totalMem * 100 : 0,
      uptimeSeconds: os.uptime(),
      nodeVersion: process.version,
      metricsProvider: this.provider,
      metricsProviderLabel: this.providerLabel,
      metricsTreeSupported: this.treeSupported,
      metricsWarning: this.warning,
      sampledAt: new Date().toISOString(),
    };
  }

  /**
   * 按需查询 node 进程的「细节」：命令行、启动时间、可执行文件路径。
   *
   * 这些字段比 CPU/内存重得多，所以不放进 3s 常规采样，而是由「进程检测器」
   * 单独触发，并按 TTL 缓存。各平台能力不同，拿不到就返回 null 字段（如实降级）。
   *
   * @param {{ force?: boolean, ttlMs?: number, pids?: number[] }} [opts]
   * @returns {Promise<Map<number, {commandLine:string|null, startedAt:string|null, exePath:string|null}>>}
   */
  async queryNodeProcessDetails({ force = false, ttlMs = 15000, pids = null } = {}) {
    if (!force && this._nodeDetail && Date.now() - this._nodeDetail.ts < ttlMs) {
      return this._nodeDetail.map;
    }
    let map = new Map();
    try {
      if (process.platform === 'win32' && this.provider === 'wmi') {
        map = await nodeDetailViaWmi();
      } else if (process.platform === 'linux') {
        map = await nodeDetailViaProc(pids || [...(this.lastSnapshot?.processes.keys() ?? [])]);
      } else if (process.platform === 'darwin') {
        map = await nodeDetailViaPs();
      }
    } catch {
      map = new Map();
    }
    this._nodeDetail = { ts: Date.now(), map };
    return map;
  }
}

/* -------------------- node 进程细节（命令行等） --------------------------- */

const NODE_NAME_RE = /^node(\.exe)?$/i;

/** 降级枚举：Get-Process 不需要 WMI 权限，任何 Windows 账户都可用 */
async function nodeListViaBasic() {
  const script = [
    '$rows = @(Get-Process -Name node -ErrorAction SilentlyContinue |',
    '  Select-Object Id,ProcessName,WorkingSet64,CPU);',
    'if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress -Depth 3 }',
  ].join(' ');
  const res = await captureStdout(PS, psArgs(script), { timeoutMs: 20000 });
  if (!res.ok || !res.text.trim()) return null;
  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .map((r) => ({
      pid: Number(r.Id),
      ppid: 0,
      name: 'node',
      rss: Number(r.WorkingSet64) || 0,
      cpuSeconds: Number(r.CPU) || 0,
    }))
    .filter((r) => Number.isInteger(r.pid) && r.pid > 0);
}

/** CIM 时间戳 20261016122304.123456+480 → ISO 字符串 */
function cimDateToIso(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function nodeDetailViaWmi() {
  const script = [
    '$rows = @(Get-CimInstance Win32_Process -Filter "Name LIKE \'node%\'" -Property ProcessId,CommandLine,ExecutablePath,CreationDate |',
    '  ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; cmd=[string]$_.CommandLine;',
    '    exe=[string]$_.ExecutablePath; created=[string]$_.CreationDate } });',
    'if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress -Depth 3 }',
  ].join(' ');
  const res = await captureStdout(PS, psArgs(script), { timeoutMs: 25000 });
  const map = new Map();
  if (!res.ok || !res.text.trim()) return map;
  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch {
    return map;
  }
  if (!Array.isArray(rows)) rows = [rows];
  for (const r of rows) {
    const pid = Number(r.pid);
    if (!Number.isInteger(pid)) continue;
    map.set(pid, {
      commandLine: r.cmd ? String(r.cmd) : null,
      exePath: r.exe ? String(r.exe) : null,
      startedAt: cimDateToIso(r.created),
    });
  }
  return map;
}

async function nodeDetailViaProc(pids) {
  const map = new Map();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let commandLine = null;
    let exePath = null;
    let startedAt = null;
    try {
      const raw = (await fsp.readFile(`/proc/${pid}/cmdline`)).toString('utf8');
      commandLine = raw.split('\0').filter(Boolean).join(' ').trim() || null;
    } catch { /* 进程已退出 */ }
    try {
      exePath = await fsp.readlink(`/proc/${pid}/exe`);
    } catch { /* 可能无权读取 */ }
    try {
      const stat = await fsp.stat(`/proc/${pid}`);
      startedAt = stat.mtime.toISOString();
    } catch { /* ignore */ }
    if (commandLine || exePath) map.set(pid, { commandLine, exePath, startedAt });
  }
  return map;
}

async function nodeDetailViaPs() {
  const res = await captureStdout('/bin/ps', ['-axo', 'pid=,lstart=,command='], { timeoutMs: 15000 });
  const map = new Map();
  if (!res.ok || !res.text) return map;
  for (const line of res.text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.{24})\s+(.*)$/);
    if (!m) continue;
    const cmd = m[3];
    const base = cmd.split(/\s+/)[0] || '';
    if (!/(^|[\\/])node(\.exe)?$/.test(base) && !/node/.test(base)) continue;
    const d = new Date(m[2]);
    map.set(Number(m[1]), {
      commandLine: cmd,
      exePath: base,
      startedAt: Number.isNaN(d.getTime()) ? null : d.toISOString(),
    });
  }
  return map;
}


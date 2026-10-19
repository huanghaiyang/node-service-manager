import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { captureStdout } from './util.js';

/**
 * 被托管服务「实际在监听哪些端口」的探测。
 *
 * 为什么不用 WMI / Get-NetTCPConnection：它们和进程指标一样会受运行环境限制，
 * 因此在 Windows 上改用 netstat -ano（只依赖系统自带工具，普通用户即可读）；
 * Linux 直接读 /proc（精确到 socket inode，无需任何外部命令）；
 * macOS 用自带的 lsof。
 *
 * 探测到的端口是「活数据」——服务没起来、端口还没 bind 时就应该是空的，
 * 这比只显示 package.json 里声明的端口更可信。
 */

const PROVIDER_LABEL = {
  netstat: 'netstat -ano',
  proc: '/proc/net/tcp（socket inode 精确匹配）',
  lsof: 'lsof -iTCP -sTCP:LISTEN',
  none: '不可用',
};

/** /proc 里的 IPv4 是小端 8 位十六进制，例如 0100007F → 127.0.0.1 */
function hexToIpv4(hex) {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const bytes = [];
  for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes.join('.');
}

/** 本地地址形如 0.0.0.0:7100 / [::]:7100 / 127.0.0.1:5178 / *:80 */
function parseLocalAddress(text) {
  const idx = text.lastIndexOf(':');
  if (idx < 0) return null;
  const port = Number(text.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let address = text.slice(0, idx);
  // [::]:7100 → ::； 0.0.0.0 保留原样便于展示
  address = address.replace(/^\[|\]$/g, '');
  return { address: address || '*', port };
}

/** 只关心「通配地址」优先级，用于排序展示：具体地址优先于 0.0.0.0/[::] */
function addressRank(address) {
  if (address === '::' || address === '0.0.0.0' || address === '*') return 2;
  if (address.startsWith('127.') || address === '::1') return 1;
  return 0;
}

export class PortScanner {
  constructor() {
    this.provider = null;
    this.warning = '';
    /** @type {Map<number, Array<{port:number, proto:string, address:string}>>} */
    this.byPid = new Map();
    this.sampledAt = 0;
    this._probing = null;
  }

  get providerLabel() {
    return PROVIDER_LABEL[this.provider] || PROVIDER_LABEL.none;
  }

  async detect(force = false) {
    if (this.provider && !force) return this.provider;
    if (this._probing) return this._probing;
    this._probing = (async () => {
      let snapshot = null;
      if (process.platform === 'win32') snapshot = await this._viaNetstat();
      else if (process.platform === 'linux') snapshot = await this._viaProc();
      else if (process.platform === 'darwin') snapshot = await this._viaLsof();

      if (snapshot) {
        this.provider = process.platform === 'win32' ? 'netstat'
          : process.platform === 'linux' ? 'proc' : 'lsof';
        this.warning = '';
      } else {
        this.provider = 'none';
        this.warning = '当前环境无法探测服务监听端口，界面只显示配置里声明的端口。';
      }
      this._probing = null;
      return this.provider;
    })();
    return this._probing;
  }

  /**
   * 全量采样一次监听端口表。
   * @returns {Promise<Map<number, Array<object>>|null>}
   */
  async refresh() {
    await this.detect();
    let snapshot = null;
    if (this.provider === 'netstat') snapshot = await this._viaNetstat();
    else if (this.provider === 'proc') snapshot = await this._viaProc();
    else if (this.provider === 'lsof') snapshot = await this._viaLsof();

    if (!snapshot) {
      if (this.provider !== 'none') {
        this.provider = 'none';
        this.warning = '当前环境无法探测服务监听端口，界面只显示配置里声明的端口。';
      }
      this.byPid = new Map();
      this.sampledAt = Date.now();
      return this.byPid;
    }
    this.byPid = snapshot;
    this.sampledAt = Date.now();
    return this.byPid;
  }

  /** 汇总一组 PID 的监听端口（去重、稳定排序） */
  pick(pids) {
    const seen = new Set();
    const out = [];
    for (const pid of pids || []) {
      for (const entry of this.byPid.get(pid) || []) {
        const key = `${entry.proto}/${entry.port}`;
        if (seen.has(key)) {
          // 同端口的通配地址与具体地址都出现过时，保留更具体的那条
          const existing = out.find((e) => `${e.proto}/${e.port}` === key);
          if (existing && addressRank(entry.address) < addressRank(existing.address)) {
            existing.address = entry.address;
          }
          continue;
        }
        seen.add(key);
        out.push({ ...entry });
      }
    }
    // 具体地址优先，其次端口升序
    out.sort((a, b) => addressRank(a.address) - addressRank(b.address) || a.port - b.port);
    return out;
  }

  /**
   * 反查：谁在监听这个端口。
   * 数据来自最近一次全表探测（netstat / /proc / lsof 都能拿到归属 PID）。
   * @returns {Array<{pid:number, port:number, proto:string, address:string}>}
   */
  whoListensOn(port) {
    const target = Number(port);
    if (!Number.isInteger(target) || target <= 0) return [];
    const out = [];
    for (const [pid, entries] of this.byPid) {
      for (const e of entries) {
        if (e.port === target && e.proto === 'tcp') out.push({ pid, ...e });
      }
    }
    out.sort((a, b) => addressRank(a.address) - addressRank(b.address));
    return out;
  }

  /** 该端口上是否已有监听者（TCP） */
  isOccupied(port) {
    return this.whoListensOn(port).length > 0;
  }

  /* ---------------------------- 可用端口 ---------------------------------- */

  /** 用绑定测试判断端口是否可用（端口探测不可用时的兜底手段） */
  static probeFree(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const srv = net.createServer();
      let settled = false;
      const done = (free) => {
        if (settled) return;
        settled = true;
        try { srv.close(); } catch { /* ignore */ }
        resolve(free);
      };
      srv.once('error', () => done(false));
      srv.once('listening', () => done(true));
      try {
        srv.listen(port, host);
      } catch {
        done(false);
      }
      setTimeout(() => done(false), 1200);
    });
  }

  /**
   * 找一个没人用的端口：优先在推荐区间里随机取，逐个做绑定测试。
   * 随机起点可以让连续多次请求拿到不同结果，避免所有人挤在同一个「下一个可用端口」上。
   * @returns {Promise<number|null>}
   */
  static async findFreePort({ min = 10000, max = 60000, host = '127.0.0.1', attempts = 30 } = {}) {
    const span = Math.max(1, max - min);
    for (let i = 0; i < attempts; i += 1) {
      const candidate = min + Math.floor(Math.random() * span);
      // 组合判断：既绑定测试，也避开别人已经监听但我们还没探测到的窗口
      if (await PortScanner.probeFree(candidate, host)) return candidate;
    }
    // 极端情况下的兜底：让操作系统直接分配一个空闲端口
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(null));
      srv.listen(0, host, () => {
        const port = srv.address()?.port ?? null;
        try { srv.close(() => resolve(port)); } catch { resolve(port); }
      });
    });
  }

  /* ---------------------------- 端口归属 ---------------------------------- */

  /**
   * 综合判断某个端口是否被占用，并给出占用者信息。
   * 端口表不可用时退化为纯绑定测试（此时拿不到占用者 PID）。
   */
  async inspectPort(port, { refreshIfStaleMs = 2500 } = {}) {
    const target = Number(port);
    if (!Number.isInteger(target) || target <= 0 || target > 65535) {
      return { checked: false, reason: 'invalid-port', port: target || null };
    }
    if (Date.now() - this.sampledAt > refreshIfStaleMs) {
      await this.refresh().catch(() => {});
    }
    let listeners = this.whoListensOn(target);
    if (!listeners.length) {
      // 端口表说没人，再用绑定测试确认（能发现刚起来、还没进快照的进程）
      const free = await PortScanner.probeFree(target);
      if (free) {
        return { checked: true, port: target, occupied: false, via: 'bind-probe', occupants: [] };
      }
      // 绑定失败但快照里查不到占用者：多半是快照刚好过期，强制重扫一次再判定，
      // 否则冲突弹窗只能显示「无法定位占用者」，排查价值大打折扣。
      await this.refresh().catch(() => {});
      listeners = this.whoListensOn(target);
      return {
        checked: true,
        port: target,
        occupied: true,
        via: listeners.length ? 'port-scan-rescan' : 'bind-probe',
        occupants: listeners,
      };
    }
    return { checked: true, port: target, occupied: true, via: 'port-scan', occupants: listeners };
  }

  /* ------------------------------ Windows -------------------------------- */

  async _viaNetstat() {
    const res = await captureStdout('netstat', ['-ano'], { timeoutMs: 15000 });
    if (!res.ok || !res.text) return null;
    const map = new Map();
    const add = (pid, entry) => {
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid).push(entry);
    };
    for (const raw of res.text.split('\n')) {
      const line = raw.trim();
      // 行格式与系统语言无关：TCP <local> <foreign> LISTENING <pid>
      const tcp = line.match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (tcp) {
        const local = parseLocalAddress(tcp[1]);
        if (local) add(Number(tcp[2]), { ...local, proto: 'tcp' });
        continue;
      }
      // UDP <local> <foreign> <pid>
      const udp = line.match(/^UDP\s+(\S+)\s+\S+\s+(\d+)$/i);
      if (udp) {
        const local = parseLocalAddress(udp[1]);
        if (local) add(Number(udp[2]), { ...local, proto: 'udp' });
      }
    }
    return map;
  }

  /* ------------------------------- Linux --------------------------------- */

  /**
   * /proc/net/tcp{,6} 每一行的字段（按空白切分）：
   *   0=sl 1=local_address 2=rem_address 3=st 4=tx:rx 5=tr:when 6=retrnsmt 7=uid 8=timeout 9=inode
   * state=0A 表示 LISTEN；local_address 形如 0100007F:1F90（小端十六进制 IP:端口）
   */
  async _readProcNet(file, proto, family) {
    const map = new Map(); // inode -> entry
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return map;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A') continue;
      const [addrHex, portHex] = f[1].split(':');
      const port = parseInt(portHex, 16);
      if (!Number.isInteger(port) || port <= 0) continue;

      let address;
      if (family === 4) {
        address = hexToIpv4(addrHex);
      } else {
        address = /^0{32}$/i.test(addrHex) ? '::' : 'ipv6';
      }
      if (!address) continue;
      map.set(f[9], { port, proto, address });
    }
    return map;
  }

  async _viaProc() {
    const [tcp4, tcp6] = await Promise.all([
      this._readProcNet('/proc/net/tcp', 'tcp', 4),
      this._readProcNet('/proc/net/tcp6', 'tcp', 6),
    ]);
    const inodeToEntry = new Map([...tcp6, ...tcp4]);
    if (!inodeToEntry.size) return new Map();

    let pids;
    try {
      pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
    } catch {
      return null;
    }

    const map = new Map();
    for (const pidStr of pids) {
      const pid = Number(pidStr);
      let fds;
      try {
        fds = await fsp.readdir(`/proc/${pid}/fd`);
      } catch {
        continue; // 进程已退出或无权读取
      }
      const found = [];
      for (const fd of fds) {
        let link;
        try {
          link = await fsp.readlink(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (!m) continue;
        const entry = inodeToEntry.get(m[1]);
        if (entry) found.push(entry);
      }
      if (found.length) map.set(pid, found);
    }
    return map;
  }

  /* ------------------------------- macOS --------------------------------- */

  async _viaLsof() {
    // -F pcn：按字段输出 pid / command / name，便于稳定解析
    const res = await captureStdout('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeoutMs: 20000 });
    if (!res.ok || !res.text) {
      const alt = await captureStdout('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeoutMs: 20000 });
      if (!alt.ok || !alt.text) return null;
      return parseLsof(alt.text);
    }
    return parseLsof(res.text);
  }
}

function parseLsof(text) {
  const map = new Map();
  let pid = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith('n') && pid) {
      // n*:7100 / n127.0.0.1:7100 / n[::1]:7100
      const local = parseLocalAddress(line.slice(1));
      if (local) {
        if (!map.has(pid)) map.set(pid, []);
        map.get(pid).push({ ...local, proto: 'tcp' });
      }
    }
  }
  return map;
}

/**
 * 由监听端口推导浏览器可打开的入口地址。
 *
 * 绑定地址不能直接塞进 URL：
 *   - `0.0.0.0` / `::` / `*` 是通配地址，浏览器打不开，要换成回环
 *   - `::1` 换成 `127.0.0.1` 更稳（部分环境的 IPv6 回环不通）
 *   - 只绑定了某个具体网卡地址时，必须用它 —— 换成 127.0.0.1 反而连不上
 */
export function defaultEntryUrl(port, host = '127.0.0.1') {
  if (!port) return '';
  const raw = String(host || '').trim();
  const wildcard = !raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]' || raw === '*';
  const loopback = raw === '::1' || raw === '[::1]';
  const target = wildcard || loopback ? '127.0.0.1' : raw;
  // IPv6 字面量需要方括号
  const printable = target.includes(':') && !target.startsWith('[') ? `[${target}]` : target;
  return `http://${printable}:${port}/`;
}

export { parseLocalAddress };

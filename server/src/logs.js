import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, LOG_BUFFER_LINES, LOG_FILE_MAX_BYTES, ensureDirs } from './config.js';
import { sanitizeLogLine } from './util.js';

/**
 * 服务日志：子进程 stdout/stderr 直接写入文件（文件描述符 stdio），
 * 再由 tailer 增量读取，进入内存环形缓冲并推给前端。
 *
 * 这样做的好处：
 *   1. 不占用管道，避免子进程因管道写满而阻塞；
 *   2. 日志天然落盘，管理端重启后仍可回溯；
 *   3. 实时性靠 250ms 轮询保证，跨平台且不依赖 fs.watch 的差异行为。
 */

const TAIL_INTERVAL_MS = 250;

export class LogStore {
  /**
   * @param {(entry: {serviceId:string, ts:string, stream:string, text:string}) => void} [onEntry]
   */
  constructor(onEntry) {
    this.onEntry = onEntry || (() => {});
    /** @type {Map<string, {buffer: object[], outPath: string, errPath: string, fds: {out:number|null, err:number|null}, offsets: {out:number, err:number}, partial: {out:string, err:string}, timer: NodeJS.Timeout|null, bytes: {out:number, err:number}}>} */
    this.state = new Map();
    ensureDirs();
  }

  paths(id) {
    return {
      outPath: path.join(LOG_DIR, `${id}.out.log`),
      errPath: path.join(LOG_DIR, `${id}.err.log`),
      sysPath: path.join(LOG_DIR, `${id}.system.log`),
    };
  }

  _state(id) {
    let st = this.state.get(id);
    if (!st) {
      const { outPath, errPath, sysPath } = this.paths(id);
      st = {
        id,
        buffer: [],
        outPath,
        errPath,
        sysPath,
        fds: { out: null, err: null },
        offsets: { out: 0, err: 0, sys: 0 },
        partial: { out: '', err: '', sys: '' },
        timer: null,
        bytes: { out: 0, err: 0 },
      };
      this.state.set(id, st);
    }
    return st;
  }

  /** 轮转过大日志（仅服务停止时安全） */
  _rotate(file) {
    try {
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      if (size < LOG_FILE_MAX_BYTES) return;
      const bak = `${file}.1`;
      if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
      fs.renameSync(file, bak);
    } catch { /* ignore */ }
  }

  /** 打开追加写的 fd，交给子进程作为 stdout/stderr */
  openForService(id) {
    const st = this._state(id);
    this.closeFds(id);
    this._rotate(st.outPath);
    this._rotate(st.errPath);
    st.fds.out = fs.openSync(st.outPath, 'a');
    st.fds.err = fs.openSync(st.errPath, 'a');
    st.bytes.out = fs.existsSync(st.outPath) ? fs.statSync(st.outPath).size : 0;
    st.bytes.err = fs.existsSync(st.errPath) ? fs.statSync(st.errPath).size : 0;
    st.offsets.out = st.bytes.out;
    st.offsets.err = st.bytes.err;
    st.partial.out = '';
    st.partial.err = '';
    this.startTail(id);
    return { outFd: st.fds.out, errFd: st.fds.err, outPath: st.outPath, errPath: st.errPath };
  }

  closeFds(id) {
    const st = this.state.get(id);
    if (!st) return;
    for (const key of ['out', 'err']) {
      if (st.fds[key] !== null && st.fds[key] !== undefined) {
        try { fs.closeSync(st.fds[key]); } catch { /* ignore */ }
        st.fds[key] = null;
      }
    }
  }

  startTail(id) {
    const st = this._state(id);
    if (st.timer) return;
    st.timer = setInterval(() => this.poll(id), TAIL_INTERVAL_MS);
    if (st.timer.unref) st.timer.unref();
  }

  stopTail(id) {
    const st = this.state.get(id);
    if (st?.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
  }

  release(id) {
    this.stopTail(id);
    this.closeFds(id);
    this.state.delete(id);
  }

  poll(id) {
    const st = this.state.get(id);
    if (!st) return;
    this._readNew(st, 'out');
    this._readNew(st, 'err');
    this._readNew(st, 'sys');
  }

  _readNew(st, stream) {
    const file = stream === 'out' ? st.outPath : stream === 'err' ? st.errPath : st.sysPath;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (stream !== 'sys') st.bytes[stream] = size;
    if (size <= st.offsets[stream]) return;

    const length = size - st.offsets[stream];
    const buf = Buffer.allocUnsafe(Math.min(length, 512 * 1024));
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      let read;
      do {
        read = fs.readSync(fd, buf, 0, buf.length, st.offsets[stream]);
        if (read > 0) {
          st.offsets[stream] += read;
          this._ingest(st, stream, buf.subarray(0, read).toString('utf8'));
        }
      } while (read === buf.length);
    } catch { /* ignore */ } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  _ingest(st, stream, text) {
    if (stream === 'sys') {
      // 系统行自带时间戳，直接成型，无需按行累积
      for (const line of (st.partial.sys + text).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/^\[([^\]]+)\] \[(\w+)\] (.*)$/);
        if (m) this._push(st, { ts: m[1], stream: m[2], text: m[3] });
        else this._push(st, { ts: null, stream: 'system', text: line });
      }
      st.partial.sys = '';
      return;
    }
    const combined = st.partial[stream] + text;
    const lines = combined.split(/\r?\n/);
    st.partial[stream] = lines.pop() ?? '';
    for (const line of lines) {
      this._pushLine(st, stream, line);
    }
    // 超长单行（无换行）也及时展示，避免看不到进度输出
    if (st.partial[stream].length > 8192) {
      this._pushLine(st, stream, st.partial[stream]);
      st.partial[stream] = '';
    }
  }

  /** 清洗并压入一行日志：去 ANSI 颜色码 / 控制字符，处理 \r 覆盖 */
  _pushLine(st, stream, rawLine) {
    const text = sanitizeLogLine(rawLine);
    // 整行只有一个颜色复位之类的转义序列时，清洗后为空 —— 丢掉，别在界面上留空行
    if (!text && rawLine) return;
    this._push(st, {
      ts: new Date().toISOString(),
      stream: stream === 'out' ? 'stdout' : 'stderr',
      text,
    });
  }

  _push(st, entry) {
    const record = { serviceId: st.id, ...entry };
    st.buffer.push(record);
    if (st.buffer.length > LOG_BUFFER_LINES) st.buffer.splice(0, st.buffer.length - LOG_BUFFER_LINES);
    this.onEntry(record);
  }

  /**
   * 由管理端写入的系统提示行（启动/停止等事件）。
   * 写入独立的 system.log 并同步推进游标，因此 tailer 不会重复输出这一行；
   * system.log 只有管理端写入，不存在与子进程抢写的竞态。
   */
  append(id, text, stream = 'system') {
    const st = this._state(id);
    const ts = new Date().toISOString();
    try {
      fs.appendFileSync(st.sysPath, `[${ts}] [${stream}] ${text}\n`, 'utf8');
      st.offsets.sys = fs.statSync(st.sysPath).size;
    } catch { /* 落盘失败不影响内存缓冲 */ }
    const record = { ts, stream, text };
    this._push(st, record);
    return record;
  }

  read(id, limit = 500) {
    const st = this.state.get(id);
    if (!st) return { lines: [], bytes: { out: 0, err: 0 }, total: 0 };
    const lines = limit > 0 ? st.buffer.slice(-limit) : st.buffer.slice();
    return { lines, bytes: { ...st.bytes }, total: st.buffer.length };
  }

  /**
   * 聚合所有服务的近期日志（底部「活动实时输出」面板的回填来源）。
   *
   * 每个服务的内存缓冲本来就在实时增长，这里不再读磁盘：
   *  - 只取带时间戳的行。磁盘回填的 stdout/stderr 没有 ts（原始输出行不含时间），
   *    混进全局时间线会让顺序完全错乱，因此直接跳过；
   *  - 跨服务按 ts 升序排序后取最后 limit 条，观感与「一条真实的全局控制台」一致。
   *
   * @param {number} limit 最多返回多少行
   * @returns {Array<{serviceId:string, ts:string, stream:string, text:string}>}
   */
  recent(limit = 300) {
    const max = Math.max(0, Number(limit) || 0);
    if (!max) return [];
    const rows = [];
    for (const st of this.state.values()) {
      for (const line of st.buffer) {
        if (!line.ts) continue;
        rows.push({
          serviceId: st.id,
          ts: line.ts,
          stream: line.stream,
          text: line.text,
        });
      }
    }
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return rows.slice(-max);
  }

  clear(id) {
    const st = this._state(id);
    st.buffer.length = 0;
    for (const file of [st.outPath, st.errPath, st.sysPath]) {
      try { fs.writeFileSync(file, '', 'utf8'); } catch { /* ignore */ }
    }
    st.offsets = { out: 0, err: 0, sys: 0 };
    st.bytes = { out: 0, err: 0 };
    st.partial = { out: '', err: '', sys: '' };
    return true;
  }

  /**
   * 从磁盘回填历史行（管理端重启后使用）。
   * 说明：stdout/stderr 逐行不带时间戳，跨文件与系统行的先后顺序无法精确还原，
   * 因此这里按「系统事件 → stdout → stderr」分段返回，只保证各自的相对顺序。
   */
  loadTail(id, limit = 300) {
    const st = this._state(id);
    const out = [];

    const readSystem = () => {
      try {
        if (!fs.existsSync(st.sysPath)) return;
        const lines = fs.readFileSync(st.sysPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
        for (const line of lines.slice(-60)) {
          const m = line.match(/^\[([^\]]+)\] \[(\w+)\] (.*)$/);
          if (m) out.push({ ts: m[1], stream: m[2], text: m[3] });
        }
      } catch { /* ignore */ }
    };

    const readPlain = (file, stream) => {
      try {
        if (!fs.existsSync(file)) return;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.length);
        // 历史日志同样要清洗：文件里是子进程原始输出，可能带 ANSI 颜色码
        for (const line of lines.slice(-limit)) {
          out.push({ ts: null, stream, text: sanitizeLogLine(line) });
        }
      } catch { /* ignore */ }
    };

    readSystem();
    readPlain(st.outPath, 'stdout');
    readPlain(st.errPath, 'stderr');

    const trimmed = out.slice(-limit).map((e) => ({ serviceId: st.id, ...e }));
    st.buffer.push(...trimmed);
    if (st.buffer.length > LOG_BUFFER_LINES) st.buffer.splice(0, st.buffer.length - LOG_BUFFER_LINES);
    return trimmed;
  }

  dispose() {
    for (const id of [...this.state.keys()]) this.release(id);
  }
}

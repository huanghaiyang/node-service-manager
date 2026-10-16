export function formatBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function formatPercent(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function formatUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}天 ${h}小时`;
  if (h) return `${h}小时 ${m}分`;
  if (m) return `${m}分 ${sec}秒`;
  return `${sec}秒`;
}

export function formatClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatTimeOnly(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function shortenPath(p, max = 52) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  const tail = [];
  let len = 0;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (len + parts[i].length + 1 > max - 4) break;
    tail.unshift(parts[i]);
    len += parts[i].length + 1;
  }
  return `…\\${tail.join('\\')}`;
}

export const STATUS_META = {
  running: { label: '运行中', color: 'green' },
  starting: { label: '启动中', color: 'amber' },
  stopping: { label: '停止中', color: 'amber' },
  stopped: { label: '已停止', color: '' },
  exited: { label: '已退出', color: '' },
  crashed: { label: '异常退出', color: 'red' },
  orphaned: { label: '外部运行中', color: 'purple' },
};

export function statusLabel(status) {
  return STATUS_META[status]?.label || status || '未知';
}

/** 浏览器入口的来源说明 */
export const ENTRY_SOURCE_META = {
  override: { label: '手工指定', color: 'purple' },
  detected: { label: '实时探测', color: 'green' },
  declared: { label: '仅配置声明（端口尚未监听）', color: 'amber' },
  none: { label: '未识别', color: '' },
};

export function entrySourceLabel(source) {
  return ENTRY_SOURCE_META[source]?.label || '未知';
}

/** 给端口找一个可读的协议前缀 */
export function portLabel(entry) {
  const proto = entry.proto === 'udp' ? 'UDP' : 'TCP';
  return `${proto} ${entry.port}`;
}

/** 把 "a b \"c d\"" 解析成参数数组（与后端 tokenize 对齐） */
export function parseArgs(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(text || '')) {
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

/** KEY=VALUE 多行文本 ↔ 对象 */
export function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf('=');
    if (idx <= 0) continue;
    env[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
  }
  return env;
}

export function envToText(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

import fs from 'node:fs';
import path from 'node:path';
import { SERVICES_FILE, ensureDirs } from './config.js';
import { uid, nowIso, normalizePath, displayName } from './util.js';

const RUNTIMES = new Set(['npm', 'node', 'custom']);

/** 入口地址：留空表示「按探测到的端口自动推导」；填了则原样使用（缺协议时补 http://） */
function normalizeEntryUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw.slice(0, 500);
  return `http://${raw}`.slice(0, 500);
}

/** 允许持久化的字段白名单 */
const PERSIST_FIELDS = [
  'id', 'name', 'packageJsonPath', 'root', 'runtime', 'script', 'command',
  'args', 'env', 'cwd', 'port', 'autoRestart', 'description', 'nodeVersion',
  // 浏览器入口：留空则按探测到的监听端口自动推导
  'entryUrl',
  'createdAt', 'updatedAt',
  // 运行期痕迹：管理端重启后据此识别残留进程
  'lastPid', 'lastStartedAt',
];

function sanitize(raw, { isNew }) {
  const runtime = RUNTIMES.has(raw.runtime) ? raw.runtime : 'npm';
  const pkgPath = path.resolve(String(raw.packageJsonPath || ''));
  const root = raw.root ? path.resolve(raw.root) : path.dirname(pkgPath);
  return {
    id: isNew ? uid() : String(raw.id),
    name: String(raw.name || displayName('', root)).slice(0, 120),
    packageJsonPath: pkgPath,
    root,
    runtime,
    script: raw.script ? String(raw.script) : '',
    command: raw.command ? String(raw.command) : '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === 'object'
      ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [String(k), String(v)]))
      : {},
    cwd: raw.cwd ? path.resolve(String(raw.cwd)) : root,
    port: raw.port === undefined || raw.port === null || raw.port === '' ? null : Number(raw.port),
    autoRestart: Boolean(raw.autoRestart),
    description: raw.description ? String(raw.description).slice(0, 500) : '',
    nodeVersion: raw.nodeVersion ? String(raw.nodeVersion) : '',
    entryUrl: normalizeEntryUrl(raw.entryUrl),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastPid: Number.isInteger(Number(raw.lastPid)) && Number(raw.lastPid) > 0 ? Number(raw.lastPid) : null,
    lastStartedAt: raw.lastStartedAt || null,
  };
}

export class ServiceStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.services = new Map();
    this._saveTimer = null;
    this._listeners = new Set();
  }

  load() {
    ensureDirs();
    if (!fs.existsSync(SERVICES_FILE)) {
      this._writeNow();
      return this;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed.services || [];
      for (const item of list) {
        try {
          const svc = sanitize(item, { isNew: false });
          if (!svc.id) continue;
          this.services.set(svc.id, svc);
        } catch {
          /* 跳过损坏条目 */
        }
      }
    } catch (err) {
      // 备份损坏文件，避免直接丢弃用户配置
      try {
        fs.copyFileSync(SERVICES_FILE, `${SERVICES_FILE}.corrupt-${Date.now()}`);
      } catch { /* ignore */ }
      console.error('[store] services.json 解析失败，已备份并重新开始:', err.message);
    }
    return this;
  }

  _writeNow() {
    ensureDirs();
    const payload = {
      schema: 1,
      updatedAt: nowIso(),
      services: this.list().map((s) => {
        const out = {};
        for (const k of PERSIST_FIELDS) out[k] = s[k];
        return out;
      }),
    };
    const tmp = `${SERVICES_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, SERVICES_FILE);
  }

  /** 合并写盘，避免高频调用 */
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this._writeNow();
      } catch (err) {
        console.error('[store] 保存失败:', err.message);
      }
    }, 80);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeNow();
  }

  list() {
    return [...this.services.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    return this.services.get(id) || null;
  }

  findBypackageJson(packageJsonPath) {
    const target = normalizePath(packageJsonPath);
    return this.list().find((s) => normalizePath(s.packageJsonPath) === target) || null;
  }

  add(raw) {
    const svc = sanitize(raw, { isNew: true });
    this.services.set(svc.id, svc);
    this.save();
    return svc;
  }

  update(id, patch) {
    const current = this.get(id);
    if (!current) return null;
    const merged = sanitize({ ...current, ...patch, id, createdAt: current.createdAt }, { isNew: false });
    this.services.set(id, merged);
    this.save();
    return merged;
  }

  remove(id) {
    const svc = this.get(id);
    if (!svc) return null;
    this.services.delete(id);
    this.save();
    return svc;
  }
}

/**
 * 全局设置（非「单个服务」的配置）。
 *
 * 与 services.json 分开存：这些是「本机 + 本工具」级别的开关，
 * 不随服务的增删变化，也不该被服务的导出/迁移带走。
 *
 * 落盘同样是「先写临时文件再 rename」，避免断电/强杀时读到半个 JSON。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TMP_FILE = `${SETTINGS_FILE}.tmp`;

const DEFAULTS = {
  /** 工具启动时，自动拉起「上次退出时还在运行」的服务 */
  restoreOnBoot: false,
  /** 顺序恢复时每个服务之间的间隔（毫秒），避免同时抢端口/CPU */
  restoreStaggerMs: 800,
  /** 工具启动时同时显示任务栏托盘（仅 Windows） */
  trayOnStart: false,
};

let cache = null;

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.restoreOnBoot === 'boolean') out.restoreOnBoot = raw.restoreOnBoot;
    const stagger = Number(raw.restoreStaggerMs);
    if (Number.isFinite(stagger) && stagger >= 0 && stagger <= 60000) out.restoreStaggerMs = stagger;
    if (typeof raw.trayOnStart === 'boolean') out.trayOnStart = raw.trayOnStart;
  }
  return out;
}

export function readSettings() {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export async function patchSettings(patch) {
  const cur = readSettings();
  // 逐字段校验：非法值直接忽略（保留原值），而不是悄悄回落到默认值 ——
  // 否则「传错一个数」会把用户之前调好的设置冲掉。
  const next = { ...cur };
  if (patch && typeof patch.restoreOnBoot === 'boolean') next.restoreOnBoot = patch.restoreOnBoot;
  if (patch && patch.restoreStaggerMs !== undefined) {
    const stagger = Number(patch.restoreStaggerMs);
    if (Number.isFinite(stagger) && stagger >= 0 && stagger <= 60000) next.restoreStaggerMs = stagger;
  }
  if (patch && typeof patch.trayOnStart === 'boolean') next.trayOnStart = patch.trayOnStart;
  cache = normalize(next);
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fsp.writeFile(TMP_FILE, JSON.stringify(cache, null, 2), 'utf8');
  await fsp.rename(TMP_FILE, SETTINGS_FILE);
  return cache;
}

export { DEFAULTS as DEFAULT_SETTINGS, SETTINGS_FILE };

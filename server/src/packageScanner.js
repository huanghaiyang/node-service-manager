import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalizePath } from './util.js';

/**
 * package.json 定位 / 解析 / 扫描
 *
 * 设计目标：让使用者既可以直接粘贴 package.json 的绝对路径，也可以从磁盘根
 * 逐级浏览目录去「手动定位」到目标文件，或者在某个目录下做有限深度的批量扫描。
 */

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
  '.output', 'coverage', '.cache', '.npm-cache', '$RECYCLE.BIN', 'System Volume Information',
]);

/** 启动脚本推荐权重：数值越大越优先 */
const SCRIPT_PRIORITY = [
  [/^start$/i, 100],
  [/^dev$/i, 90],
  [/^serve$/i, 85],
  [/^develop(ment)?$/i, 80],
  [/^server$/i, 75],
  [/^start:.*/i, 70],
  [/^dev:.*/i, 65],
  [/^node$/i, 60],
  [/^run$/i, 50],
  [/^watch$/i, 40],
];

/** 明显不是「启动服务」的脚本 */
const NON_SERVER_SCRIPTS = /^(build|test|lint|format|clean|docs?|tsc|typecheck|prettier|eslint|prepare|prepublish.*|postinstall|release|deploy|publish|bench)$/i;

export class PackageJsonError extends Error {
  constructor(message, code = 'INVALID_PACKAGE_JSON') {
    super(message);
    this.name = 'PackageJsonError';
    this.code = code;
  }
}

/**
 * 把用户输入归一化成 package.json 的绝对路径。
 * 支持：文件路径（必须以 package.json 结尾）/ 目录路径 / JSON 内容不相关。
 */
export function resolvePackageJsonPath(input) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new PackageJsonError('请输入 package.json 路径', 'EMPTY_PATH');
  const abs = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new PackageJsonError(`路径不存在：${abs}`, 'PATH_NOT_FOUND');
  }
  if (stat.isDirectory()) {
    const candidate = path.join(abs, 'package.json');
    if (!fs.existsSync(candidate)) {
      throw new PackageJsonError(`该目录下没有 package.json：${candidate}`, 'PACKAGE_NOT_FOUND');
    }
    return candidate;
  }
  if (path.basename(abs).toLowerCase() !== 'package.json') {
    throw new PackageJsonError(`请选择名为 package.json 的文件，当前是：${path.basename(abs)}`, 'NOT_PACKAGE_JSON');
  }
  return abs;
}

export function readPackageJson(packageJsonPath) {
  let text;
  try {
    text = fs.readFileSync(packageJsonPath, 'utf8');
  } catch (err) {
    throw new PackageJsonError(`无法读取文件：${err.message}`, 'READ_FAILED');
  }
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('内容不是 JSON 对象');
    }
    return data;
  } catch (err) {
    throw new PackageJsonError(`package.json 解析失败：${err.message}`, 'PARSE_FAILED');
  }
}

function scoreScript(name) {
  if (NON_SERVER_SCRIPTS.test(name)) return -1;
  for (const [re, score] of SCRIPT_PRIORITY) {
    if (re.test(name)) return score;
  }
  return 1;
}

/** 解析 package.json 的入口文件（bin / main / 约定俗成的 index.js） */
export function detectEntry(root, pkg) {
  const candidates = [];
  const bin = pkg.bin;
  if (typeof bin === 'string') candidates.push(bin);
  else if (bin && typeof bin === 'object') {
    const values = Object.values(bin).filter((v) => typeof v === 'string');
    if (values.length === 1) candidates.push(values[0]);
    else if (pkg.name && bin[pkg.name]) candidates.push(bin[pkg.name]);
  }
  if (typeof pkg.main === 'string') candidates.push(pkg.main);
  candidates.push('index.js', 'server.js', 'app.js', 'src/index.js', 'src/server.js', 'src/main.js');

  for (const c of candidates) {
    const abs = path.resolve(root, c);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) return abs;
      for (const ext of ['.js', '.mjs', '.cjs']) {
        if (fs.existsSync(abs + ext)) return abs + ext;
      }
      const idx = path.join(abs, 'index.js');
      if (fs.existsSync(idx)) return idx;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

function countDependencies(pkg) {
  const d = pkg.dependencies ? Object.keys(pkg.dependencies).length : 0;
  const dd = pkg.devDependencies ? Object.keys(pkg.devDependencies).length : 0;
  const pd = pkg.peerDependencies ? Object.keys(pkg.peerDependencies).length : 0;
  return { dependencies: d, devDependencies: dd, peerDependencies: pd, total: d + dd + pd };
}

/** 完整解析一个 package.json，返回可直接用于前端展示的元信息 */
export function analyzePackage(packageJsonPathInput) {
  const packageJsonPath = resolvePackageJsonPath(packageJsonPathInput);
  const root = path.dirname(packageJsonPath);
  const pkg = readPackageJson(packageJsonPath);

  const rawScripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const scripts = Object.entries(rawScripts)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([name, command]) => ({ name, command, score: scoreScript(name), recommended: false }));

  const ranked = [...scripts].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const recommended = ranked.find((s) => s.score > 0) || ranked[0] || null;
  if (recommended) scripts.find((s) => s.name === recommended.name).recommended = true;

  const entry = detectEntry(root, pkg);
  const hasNodeModules = fs.existsSync(path.join(root, 'node_modules'));

  // 读取 lock 文件 / .nvmrc 等辅助信息
  const lockFile = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']
    .find((f) => fs.existsSync(path.join(root, f))) || null;
  const pm = lockFile === 'pnpm-lock.yaml' ? 'pnpm'
    : lockFile === 'yarn.lock' ? 'yarn'
      : lockFile === 'bun.lockb' ? 'bun' : 'npm';

  return {
    packageJsonPath,
    root,
    name: pkg.name || path.basename(root),
    version: pkg.version || '',
    description: pkg.description || '',
    private: Boolean(pkg.private),
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type || ''),
    type: pkg.type || 'commonjs',
    main: pkg.main || '',
    engines: pkg.engines || {},
    author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || ''),
    scripts,
    recommendedScript: recommended ? recommended.name : '',
    entry,
    hasNodeModules,
    lockFile,
    packageManager: pkg.packageManager ? String(pkg.packageManager) : pm,
    dependencyCount: countDependencies(pkg),
    sizeBytes: (() => {
      try { return fs.statSync(packageJsonPath).size; } catch { return 0; }
    })(),
    mtime: (() => {
      try { return fs.statSync(packageJsonPath).mtime.toISOString(); } catch { return null; }
    })(),
  };
}

/** 列出磁盘可浏览的根（Windows 盘符 / POSIX 根） */
export function listDriveRoots() {
  if (process.platform !== 'win32') return [{ label: '/', path: '/' }];
  const roots = [];
  for (let i = 65; i <= 90; i += 1) {
    const drive = `${String.fromCharCode(i)}:\\`;
    if (fs.existsSync(drive)) roots.push({ label: drive, path: drive });
  }
  return roots;
}

const MAX_ENTRIES = 400;

/** 浏览一个目录：子目录 + package.json 是否命中 */
export async function listDirectory(dirInput) {
  const dir = path.resolve(String(dirInput || '/').trim() || (process.platform === 'win32' ? 'C:\\' : '/'));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new PackageJsonError(`无法读取目录：${dir}（${err.code || err.message}）`, 'DIR_READ_FAILED');
  }

  const dirs = [];
  const packages = [];
  let truncated = false;

  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.') {
      // 隐藏目录默认不显示，但保留 . 系列中的极少数（跳过即可）
      if (ent.name !== '..') continue;
    }
    if (ent.isDirectory()) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      if (dirs.length >= MAX_ENTRIES) { truncated = true; continue; }
      dirs.push({ name: ent.name, path: path.join(dir, ent.name) });
    }
  }

  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const info = analyzePackage(pkgPath);
      packages.push({
        path: pkgPath,
        name: info.name,
        version: info.version,
        description: info.description,
        scriptCount: info.scripts.length,
        recommendedScript: info.recommendedScript,
        hasNodeModules: info.hasNodeModules,
      });
    } catch (err) {
      packages.push({ path: pkgPath, name: path.basename(dir), error: err.message });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return {
    dir,
    parent: normalizePath(parent) === normalizePath(dir) ? null : parent,
    separator: path.sep,
    dirs,
    packages,
    truncated,
    roots: listDriveRoots(),
  };
}

/** 在目录下有限深度地查找 package.json（用于批量发现） */
export async function scanForPackages(dirInput, { depth = 2, maxResults = 100 } = {}) {
  const start = path.resolve(String(dirInput || '.'));
  const results = [];
  let visited = 0;
  const queue = [{ dir: start, level: 0 }];

  while (queue.length && results.length < maxResults) {
    const { dir, level } = queue.shift();
    visited += 1;
    if (visited > 3000) break;

    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const info = analyzePackage(pkgPath);
        results.push({
          packageJsonPath: pkgPath,
          name: info.name,
          version: info.version,
          description: info.description,
          scripts: info.scripts.map((s) => s.name),
          recommendedScript: info.recommendedScript,
          hasNodeModules: info.hasNodeModules,
          alreadyManaged: false,
        });
      } catch (err) {
        results.push({ packageJsonPath: pkgPath, name: path.basename(dir), error: err.message, scripts: [], alreadyManaged: false });
      }
    }

    if (level >= depth) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || IGNORED_DIRS.has(ent.name)) continue;
      queue.push({ dir: path.join(dir, ent.name), level: level + 1 });
    }
  }

  return { dir: start, depth, count: results.length, truncated: results.length >= maxResults, results };
}

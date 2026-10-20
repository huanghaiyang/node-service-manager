/**
 * 开机自启动（本工具自身）。
 *
 * 设计原则：
 *  1. **只用当前用户级别**的手段，绝不需要管理员/root 权限 —— 一个开发期工具
 *     不该要求提权。Windows 用 HKCU 的 Run 键，Linux 用 systemd --user，macOS 用 LaunchAgent。
 *  2. **不隐藏做了什么**：getStatus() 会把注册的位置、启动器文件、实际命令行全部暴露出来，
 *     界面上可以直接看到并复制；disable() 能干净地撤掉。
 *  3. **支持 dryRun**：先看到「将会写什么」再决定，也方便自动化测试不去碰真实注册表。
 *  4. 启动器把 PORT / SM_DATA_DIR 一起固化下来 —— 否则开机拉起的实例会跑在默认端口、
 *     读默认数据目录，和用户手工启动的那个不是同一个。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, DATA_DIR, PORT, HOST } from './config.js';
import { captureStdout } from './util.js';

const APP_ID = 'NodeServiceManager';
const APP_LABEL = 'Node 服务治理工具';
const AUTOSTART_DIR = path.join(DATA_DIR, 'autostart');
const LOG_FILE = path.join(DATA_DIR, 'autostart.log');

const NODE_EXE = process.execPath;
const ENTRY = path.join(ROOT_DIR, 'server', 'src', 'index.js');

const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_CMD = path.join(AUTOSTART_DIR, 'start-service-manager.cmd');
const WIN_VBS = path.join(AUTOSTART_DIR, 'start-service-manager.vbs');

const LINUX_UNIT_NAME = 'node-service-manager.service';
const LINUX_UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const LINUX_UNIT = path.join(LINUX_UNIT_DIR, LINUX_UNIT_NAME);

const MAC_LABEL = 'com.nodeservice-manager';
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);

/**
 * 需要固化进启动器的环境变量。
 *
 * 这里用 `SM_PORT` 而不是 `PORT`：`PORT` 是 Node 应用最通用的约定变量，
 * 若把它写进治理工具自身的进程环境，就容易被误传给被托管服务
 * （曾经的 bug：torrent-vault 的 api 继承了 PORT=5178，去抢本工具的端口）。
 * 虽然 spawn 子进程时已显式剔除 PORT，这里再避一次，双重保险。
 */
function bakedEnv() {
  const env = { SM_PORT: String(PORT) };
  if (process.env.SM_DATA_DIR) env.SM_DATA_DIR = DATA_DIR;
  if (process.env.SM_HOST) env.SM_HOST = HOST;
  if (process.env.SM_SAMPLE_INTERVAL) env.SM_SAMPLE_INTERVAL = process.env.SM_SAMPLE_INTERVAL;
  return env;
}

function displayCommand() {
  const env = bakedEnv();
  const pairs = Object.entries(env);
  if (process.platform === 'win32') {
    return `${pairs.map(([k, v]) => `set ${k}=${v}`).join(' && ')} && "${NODE_EXE}" "${ENTRY}"`;
  }
  return `${pairs.map(([k, v]) => `${k}=${v}`).join(' ')} "${NODE_EXE}" "${ENTRY}"`;
}

/** 把命令的失败信息整理成一句能直接给用户看的话 */
function describeFailure(res, action) {
  const detail = String(res.text || '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-2).join(' ');
  if (res.error) return `${action}失败：${res.error}`;
  if (detail) return `${action}失败：${detail}`;
  return `${action}失败（退出码 ${res.code ?? '未知'}）。常见原因：当前环境不允许写这个位置，可能需要放开权限`;
}

/* ------------------------------- Windows --------------------------------- */

function winCmdContent() {
  const env = bakedEnv();
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    // 日志重定向发生在应用启动之前，所以数据目录得自己先建好
    `if not exist "${DATA_DIR}" mkdir "${DATA_DIR}" >nul 2>&1`,
    `cd /d "${ROOT_DIR}"`,
    ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`),
    `"${NODE_EXE}" "${ENTRY}" >> "${LOG_FILE}" 2>&1`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function winVbsContent() {
  // 0 = 隐藏窗口，False = 不等待。这样登录时不会弹出常驻的黑框。
  return [
    `' 由「${APP_LABEL}」生成：隐藏窗口启动 start-service-manager.cmd`,
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${WIN_CMD}""", 0, False`,
    '',
  ].join('\r\n');
}

function wscriptAvailable() {
  return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'));
}

async function winReadRegistry() {
  const res = await captureStdout('reg', ['query', WIN_RUN_KEY, '/v', APP_ID], { timeoutMs: 8000, mergeStderr: true });
  if (!res.ok) return null; // 值不存在时 reg 返回非 0
  const m = res.text.match(new RegExp(`${APP_ID}\\s+REG_SZ\\s+(.+)`, 'i'));
  return m ? m[1].trim() : null;
}

async function winStatus() {
  const value = await winReadRegistry().catch(() => null);
  const vbs = wscriptAvailable();
  return {
    supported: true,
    mechanism: 'registry-run',
    mechanismLabel: 'HKCU 注册表 Run 键（当前用户，无需管理员）',
    enabled: Boolean(value),
    entry: value || `${WIN_RUN_KEY}\\${APP_ID}`,
    launcher: vbs ? WIN_VBS : WIN_CMD,
    launcherFiles: vbs ? [WIN_CMD, WIN_VBS] : [WIN_CMD],
    logFile: LOG_FILE,
    command: displayCommand(),
    detail: value
      ? `已注册到 ${WIN_RUN_KEY}，登录后由 ${path.basename(vbs ? WIN_VBS : WIN_CMD)} 启动`
      : '未注册。开启后会写入当前用户的 Run 键，登录 Windows 即自动启动',
  };
}

async function winEnable({ dryRun } = {}) {
  const vbs = wscriptAvailable();
  const value = vbs ? `wscript.exe "${WIN_VBS}"` : `"${WIN_CMD}"`;
  const files = [
    { path: WIN_CMD, content: winCmdContent() },
    ...(vbs ? [{ path: WIN_VBS, content: winVbsContent() }] : []),
  ];
  if (dryRun) {
    return { ok: true, dryRun: true, files, registry: { key: WIN_RUN_KEY, name: APP_ID, value } };
  }
  await fsp.mkdir(AUTOSTART_DIR, { recursive: true });
  for (const f of files) await fsp.writeFile(f.path, f.content, 'utf8');
  const res = await captureStdout(
    'reg',
    ['add', WIN_RUN_KEY, '/v', APP_ID, '/t', 'REG_SZ', '/d', value, '/f'],
    { timeoutMs: 8000, mergeStderr: true },
  );
  if (!res.ok) return { ok: false, error: describeFailure(res, '写入注册表') };
  return { ok: true, wrote: { registry: `${WIN_RUN_KEY}\\${APP_ID}`, files: files.map((f) => f.path) } };
}

async function winDisable({ dryRun } = {}) {
  if (dryRun) return { ok: true, dryRun: true, wouldDelete: [WIN_VBS, WIN_CMD, `${WIN_RUN_KEY}\\${APP_ID}`] };
  const res = await captureStdout(
    'reg',
    ['delete', WIN_RUN_KEY, '/v', APP_ID, '/f'],
    { timeoutMs: 8000, mergeStderr: true },
  );
  const stillThere = await winReadRegistry().catch(() => null);
  for (const f of [WIN_VBS, WIN_CMD]) {
    await fsp.rm(f, { force: true }).catch(() => {});
  }
  // 目标状态就是「不存在」，所以本就不存在也算成功（关闭开关应当幂等）
  if (res.ok || !stillThere) {
    return { ok: true, removed: `${WIN_RUN_KEY}\\${APP_ID}`, wasPresent: res.ok };
  }
  return { ok: false, error: describeFailure(res, '删除注册表项') };
}

/* -------------------------------- Linux ---------------------------------- */

function linuxUnitContent() {
  const env = bakedEnv();
  return [
    '[Unit]',
    `Description=${APP_LABEL}`,
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${ROOT_DIR}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`),
    `ExecStart="${NODE_EXE}" "${ENTRY}"`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

async function linuxStatus() {
  const res = await captureStdout('systemctl', ['--user', 'is-enabled', LINUX_UNIT_NAME], { timeoutMs: 8000 });
  const state = (res.text || '').trim().split('\n')[0];
  const hasUnit = fs.existsSync(LINUX_UNIT);
  return {
    supported: true,
    mechanism: 'systemd-user',
    mechanismLabel: 'systemd 用户级单元（无需 root）',
    enabled: hasUnit && state === 'enabled',
    entry: LINUX_UNIT,
    launcher: LINUX_UNIT,
    launcherFiles: [LINUX_UNIT],
    logFile: LOG_FILE,
    command: displayCommand(),
    state: state || 'unknown',
    detail: hasUnit
      ? `单元状态：${state || '未知'}。想在没有登录会话时也生效，需要执行 loginctl enable-linger ${os.userInfo().username}`
      : '尚未安装用户级 systemd 单元',
  };
}

async function linuxEnable({ dryRun } = {}) {
  const files = [{ path: LINUX_UNIT, content: linuxUnitContent() }];
  const commands = [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', LINUX_UNIT_NAME],
  ];
  if (dryRun) return { ok: true, dryRun: true, files, commands: commands.map((c) => c.join(' ')) };
  await fsp.mkdir(LINUX_UNIT_DIR, { recursive: true });
  await fsp.writeFile(LINUX_UNIT, linuxUnitContent(), 'utf8');
  for (const cmd of commands) {
    const res = await captureStdout(cmd[0], cmd.slice(1), { timeoutMs: 15000, mergeStderr: true });
    if (!res.ok) return { ok: false, error: describeFailure(res, `执行 ${cmd.join(' ')}`) };
  }
  return { ok: true, wrote: { files: [LINUX_UNIT] } };
}

async function linuxDisable({ dryRun } = {}) {
  const commands = [
    ['systemctl', '--user', 'disable', '--now', LINUX_UNIT_NAME],
  ];
  if (dryRun) return { ok: true, dryRun: true, wouldDelete: [LINUX_UNIT], commands: commands.map((c) => c.join(' ')) };
  for (const cmd of commands) {
    await captureStdout(cmd[0], cmd.slice(1), { timeoutMs: 15000 }).catch(() => {});
  }
  await fsp.rm(LINUX_UNIT, { force: true }).catch(() => {});
  return { ok: true, removed: LINUX_UNIT };
}

/* --------------------------------- macOS --------------------------------- */

function macPlistContent() {
  const env = bakedEnv();
  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${v}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_EXE}</string>
    <string>${ENTRY}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;
}

async function macStatus() {
  const enabled = fs.existsSync(MAC_PLIST);
  return {
    supported: true,
    mechanism: 'launchd',
    mechanismLabel: 'LaunchAgent（当前用户，登录时加载）',
    enabled,
    entry: MAC_PLIST,
    launcher: MAC_PLIST,
    launcherFiles: [MAC_PLIST],
    logFile: LOG_FILE,
    command: displayCommand(),
    detail: enabled ? '已安装 LaunchAgent，登录后自动启动' : '尚未安装 LaunchAgent',
  };
}

async function macEnable({ dryRun } = {}) {
  const files = [{ path: MAC_PLIST, content: macPlistContent() }];
  const commands = [['launchctl', 'load', '-w', MAC_PLIST]];
  if (dryRun) return { ok: true, dryRun: true, files, commands: commands.map((c) => c.join(' ')) };
  await fsp.mkdir(path.dirname(MAC_PLIST), { recursive: true });
  await fsp.writeFile(MAC_PLIST, macPlistContent(), 'utf8');
  for (const cmd of commands) {
    const res = await captureStdout(cmd[0], cmd.slice(1), { timeoutMs: 15000, mergeStderr: true });
    if (!res.ok) return { ok: false, error: describeFailure(res, `执行 ${cmd.join(' ')}`) };
  }
  return { ok: true, wrote: { files: [MAC_PLIST] } };
}

async function macDisable({ dryRun } = {}) {
  const commands = [['launchctl', 'unload', '-w', MAC_PLIST]];
  if (dryRun) return { ok: true, dryRun: true, wouldDelete: [MAC_PLIST], commands: commands.map((c) => c.join(' ')) };
  for (const cmd of commands) {
    await captureStdout(cmd[0], cmd.slice(1), { timeoutMs: 15000 }).catch(() => {});
  }
  await fsp.rm(MAC_PLIST, { force: true }).catch(() => {});
  return { ok: true, removed: MAC_PLIST };
}

/* ------------------------------- 统一入口 -------------------------------- */

function adapter() {
  if (process.platform === 'win32') {
    return { status: winStatus, enable: winEnable, disable: winDisable };
  }
  if (process.platform === 'linux') {
    return { status: linuxStatus, enable: linuxEnable, disable: linuxDisable };
  }
  if (process.platform === 'darwin') {
    return { status: macStatus, enable: macEnable, disable: macDisable };
  }
  return null;
}

export async function getAutostartStatus() {
  const impl = adapter();
  if (!impl) {
    return {
      supported: false,
      platform: process.platform,
      mechanism: 'unsupported',
      mechanismLabel: '当前平台不支持',
      enabled: false,
      entry: '',
      launcher: null,
      launcherFiles: [],
      logFile: LOG_FILE,
      command: displayCommand(),
      detail: `暂未为 ${process.platform} 提供开机自启动实现`,
    };
  }
  const status = await impl.status();
  return {
    platform: process.platform,
    appName: APP_LABEL,
    nodeExe: NODE_EXE,
    entryScript: ENTRY,
    rootDir: ROOT_DIR,
    dataDir: DATA_DIR,
    ...status,
  };
}

export async function setAutostart(enabled, { dryRun = false } = {}) {
  const impl = adapter();
  if (!impl) return { ok: false, error: `当前平台（${process.platform}）暂不支持开机自启动` };
  const result = enabled ? await impl.enable({ dryRun }) : await impl.disable({ dryRun });
  const status = await getAutostartStatus();
  return { ...result, status };
}

export { LOG_FILE as AUTOSTART_LOG_FILE, AUTOSTART_DIR };

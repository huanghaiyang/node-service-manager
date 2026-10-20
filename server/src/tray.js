/**
 * 任务栏托盘（Windows）。
 *
 * 为什么这么做：这个工具是一个「本机常驻服务 + 浏览器控制台」，
 * 用户并不想为了看一眼状态专门留一个浏览器标签。托盘给一个常驻入口：
 * 状态一行、双击打开控制台、右键启停全部。
 *
 * 实现上没有引入 Electron / node-systray 这类需要原生编译的依赖
 * （项目坚持「零原生依赖」，受限构建环境里也编译不了），
 * 而是**用 PowerShell + WinForms 的 NotifyIcon**：Windows 自带，无需安装任何东西。
 * 图标由 icon.js 用纯 JS 生成 .ico。
 *
 * 代价：仅 Windows 支持；其它平台 status 会明确报 unsupported，而不是假装成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, PORT, ensureDirs } from './config.js';
import { buildIco } from './icon.js';

const PS = process.platform === 'win32'
  ? (process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe')
  : 'powershell.exe';

export const TRAY_DIR = path.join(DATA_DIR, 'tray');
export const TRAY_ICON_PATH = path.join(TRAY_DIR, 'app.ico');
export const TRAY_SCRIPT_PATH = path.join(TRAY_DIR, 'tray.ps1');
export const TRAY_LOG_FILE = path.join(TRAY_DIR, 'tray.log');

let trayChild = null;
let trayPid = null;

export function isTraySupported() {
  return process.platform === 'win32';
}

/**
 * 生成托盘脚本。抽成纯函数便于单测（不真的起 UI）。
 * @param {{ port?: number, iconPath?: string }} opts
 */
export function buildTrayScript({ port = PORT, iconPath = TRAY_ICON_PATH } = {}) {
  return `# 由「Node 服务治理工具」生成，请勿手改（每次启动会重新生成）
# 作用：常驻任务栏托盘，提供状态显示与快捷操作。
param(
  [int]$Port = ${Number(port)},
  [string]$Icon = '${String(iconPath).replace(/'/g, "''")}'
)
$ErrorActionPreference = 'Continue'
$baseUrl = 'http://127.0.0.1:' + $Port

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$iconLoaded = $false
try {
  if ($Icon -and (Test-Path -LiteralPath $Icon)) {
    $notify.Icon = New-Object System.Drawing.Icon -ArgumentList $Icon
    $iconLoaded = $true
  }
} catch { }
if (-not $iconLoaded) { $notify.Icon = [System.Drawing.SystemIcons]::Application }
$notify.Text = 'Node 服务治理工具'
$notify.Visible = $true

$script:failStreak = 0

function Show-Balloon([string]$title, [string]$text, [bool]$warning = $false) {
  $kind = [System.Windows.Forms.ToolTipIcon]::Info
  if ($warning) { $kind = [System.Windows.Forms.ToolTipIcon]::Warning }
  try { $notify.ShowBalloonTip(4000, $title, $text, $kind) } catch { }
}

function Update-Tip {
  try {
    $s = Invoke-RestMethod -Method Get -Uri ($baseUrl + '/api/summary') -TimeoutSec 4
    $script:failStreak = 0
    $running = 0
    $total = 0
    try { $running = [int]$s.running } catch { }
    try { $total = [int]$s.total } catch { }
    $notify.Text = '服务治理 · ' + $running + '/' + $total + ' 运行中'
    $script:menuStatus.Text = '当前：' + $running + '/' + $total + ' 运行中'
  } catch {
    $script:failStreak = $script:failStreak + 1
    $notify.Text = '服务治理 · 未连接'
    $script:menuStatus.Text = '当前：未连接治理工具'
    # 治理工具连续 1 分钟不可达 -> 自动消失，避免留下无主的托盘图标
    if ($script:failStreak -ge 12) {
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
  }
}

function Post-Action([string]$apiPath, [string]$okText) {
  try {
    Invoke-RestMethod -Method Post -Uri ($baseUrl + $apiPath) -ContentType 'application/json' -Body '{}' -TimeoutSec 60 | Out-Null
    Show-Balloon 'Node 服务治理工具' $okText
  } catch {
    Show-Balloon '操作失败' $_.Exception.Message $true
  }
  Update-Tip
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:menuStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$script:menuStatus.Text = '当前：—'
$script:menuStatus.Enabled = $false
$menu.Items.Add($script:menuStatus) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$miOpen.Text = '打开控制台'
$miOpen.add_Click({ try { Start-Process $baseUrl } catch { } })
$menu.Items.Add($miOpen) | Out-Null

$miStart = New-Object System.Windows.Forms.ToolStripMenuItem
$miStart.Text = '启动全部服务'
$miStart.add_Click({ Post-Action '/api/services/start-all' '已发送「启动全部」' })
$menu.Items.Add($miStart) | Out-Null

$miStop = New-Object System.Windows.Forms.ToolStripMenuItem
$miStop.Text = '停止全部服务'
$miStop.add_Click({ Post-Action '/api/services/stop-all' '已发送「停止全部」' })
$menu.Items.Add($miStop) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miRefresh = New-Object System.Windows.Forms.ToolStripMenuItem
$miRefresh.Text = '刷新状态'
$miRefresh.add_Click({ Update-Tip })
$menu.Items.Add($miRefresh) | Out-Null

$miQuit = New-Object System.Windows.Forms.ToolStripMenuItem
$miQuit.Text = '退出托盘'
$miQuit.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($miQuit) | Out-Null

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ try { Start-Process $baseUrl } catch { } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ Update-Tip })
$timer.Start()

Update-Tip
[System.Windows.Forms.Application]::Run()
`;
}

/** 把图标与脚本写到磁盘（每次启动都刷新，便于升级后自动换新） */
export async function ensureTrayAssets(port = PORT) {
  ensureDirs();
  fs.mkdirSync(TRAY_DIR, { recursive: true });
  fs.writeFileSync(TRAY_ICON_PATH, buildIco());
  // 必须带 UTF-8 BOM：Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页读 .ps1，
  // 中文菜单文字会变成乱码，甚至把引号吃掉导致语法错误（实测直接解析失败）。
  fs.writeFileSync(TRAY_SCRIPT_PATH, `\uFEFF${buildTrayScript({ port })}`, 'utf8');
  return { icon: TRAY_ICON_PATH, script: TRAY_SCRIPT_PATH };
}

export function getTrayStatus() {
  const supported = isTraySupported();
  const running = Boolean(trayChild && trayPid);
  return {
    supported,
    platform: process.platform,
    running,
    pid: running ? trayPid : null,
    mechanism: supported ? 'powershell-notifyicon' : 'unsupported',
    icon: TRAY_ICON_PATH,
    script: TRAY_SCRIPT_PATH,
    log: TRAY_LOG_FILE,
    detail: supported
      ? (running ? `托盘已在运行（PID ${trayPid}）` : '未运行')
      : `当前系统（${process.platform}）暂不支持任务栏托盘，仅 Windows 可用`,
  };
}

/**
 * 启动托盘。重复调用是幂等的。
 * @returns {Promise<{ok: boolean, pid?: number, already?: boolean, error?: string}>}
 */
export async function startTray({ port = PORT } = {}) {
  if (!isTraySupported()) return { ok: false, error: getTrayStatus().detail };
  if (trayChild && trayPid) return { ok: true, pid: trayPid, already: true };

  try {
    await ensureTrayAssets(port);
  } catch (err) {
    return { ok: false, error: `写入托盘资源失败：${err.message}` };
  }

  let fd;
  try {
    fd = fs.openSync(TRAY_LOG_FILE, 'a');
  } catch (err) {
    return { ok: false, error: `无法写入托盘日志：${err.message}` };
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS, [
        '-NoProfile', '-NonInteractive', '-STA',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', TRAY_SCRIPT_PATH,
        '-Port', String(port),
        '-Icon', TRAY_ICON_PATH,
      ], {
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ ok: false, error: `启动托盘失败：${err.code || err.message}` });
      return;
    }

    child.on('error', (err) => {
      trayChild = null;
      trayPid = null;
      try { fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ ok: false, error: `启动托盘失败：${err.code || err.message}` });
    });

    child.on('exit', () => {
      if (trayChild === child) {
        trayChild = null;
        trayPid = null;
      }
    });

    trayChild = child;
    trayPid = child.pid;
    try { child.unref(); } catch { /* ignore */ }
    // 留一点时间让 PowerShell 解析参数；早期失败会走 error 分支
    setTimeout(() => resolve({ ok: true, pid: child.pid }), 600);
  });
}

export function stopTray() {
  const child = trayChild;
  const pid = trayPid;
  trayChild = null;
  trayPid = null;
  if (!child && !pid) return { ok: true, already: true };
  try { if (child) child.kill(); } catch { /* ignore */ }
  if (pid) {
    // 兜底：确认真的没了（PowerShell 退出后图标会随之消失）
    try {
      process.kill(pid, 0);
      // 仍在：再补一刀
      try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    } catch { /* 已经退出 */ }
  }
  return { ok: true, pid };
}

/** 进程退出时清理（由 index.js 的 shutdown 调用） */
export function disposeTray() {
  try { stopTray(); } catch { /* ignore */ }
}

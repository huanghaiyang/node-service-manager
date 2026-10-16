# Node 服务治理工具（service-manager）

基于 **Node.js + Vue 3** 的本地服务治理控制台：手动定位到任意 Node 服务的 `package.json`，
把它纳管进来，之后在这个界面里完成 **启动 / 停止 / 重启**、**实时状态监听**、**日志查看**，
并持续采集该服务的 **CPU 与内存占用**。

> 面向本机运维场景：只监听 `127.0.0.1`，不依赖任何数据库、Docker 或外部 Agent。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 手动定位 `package.json` | 三种方式：**目录逐级浏览**（自动高亮含 `package.json` 的目录）、**直接粘贴绝对路径**、**指定目录批量扫描**（按深度发现多个项目） |
| 解析服务元信息 | 名称/版本/描述、全部 npm scripts（自动标注推荐的启动脚本）、入口文件、包管理器与 lock 文件、依赖数量、`node_modules` 是否已安装 |
| 托管启动与停止 | 支持 npm script / 直接 node 启动 / 自定义命令三种模式；停止时整棵进程树一起回收 |
| 运行状态监听 | `stopped / starting / running / stopping / exited / crashed / orphaned` 七态；SSE 实时推送，无需刷新页面 |
| CPU / 内存采集 | 默认 3s 采样，卡片上直接画 CPU 与内存曲线；详情页可看单进程明细（PID / 进程名 / 占用） |
| 监听端口探测 | 实时探测服务**真正在监听**的端口（TCP/UDP、绑定地址），而不是只看配置里声明的数字；停止后自动清空 |
| 浏览器入口 | 卡片与详情页都有「浏览器打开 ↗」，一键直达服务页面；入口地址可由探测到的端口自动推导，也可手工指定（支持 https / 内网域名 / 带路径） |
| 日志 | 子进程 stdout/stderr 落盘留存 + 内存环形缓冲，支持按流筛选、关键字搜索（高亮）、自动滚动、复制、清空；管理端重启后仍可回溯历史日志 |
| 异常处理 | 异常退出自动重启（指数退避，最多 5 次/分钟，可选）；管理端重启后能识别「进程还在但已脱离托管」的残留服务并一键终止 |
| 批量操作 | 全部启动 / 全部停止 |

### 界面截图

| 空状态（引导） | 运行中（实时指标曲线） |
| --- | --- |
| ![空状态](docs/screenshots/01-dashboard-empty.png) | ![运行中](docs/screenshots/02-dashboard-running.png) |

| 定位 package.json（目录浏览） | 启动配置（脚本选择） | 日志查看器 |
| --- | --- | --- |
| ![定位](docs/screenshots/04-locate-package-json.png) | ![配置](docs/screenshots/05-launch-config.png) | ![日志](docs/screenshots/03-service-logs.png) |

| 卡片上的监听端口与浏览器入口 | 详情页：端口明细 + 入口 |
| --- | --- |
| ![端口与入口](docs/screenshots/06-ports-entry.png) | ![入口详情](docs/screenshots/07-entry-detail.png) |

---

## 快速开始

```bash
# 1. 安装依赖（只有 express + vue，无原生模块、无 postinstall 脚本）
npm install

# 2. 构建前端（用 @vue/compiler-sfc 编译 SFC → 浏览器原生 ESM，约 0.3 秒）
npm run build

# 3. 启动治理服务端（同时托管前端静态资源）
npm start
```

打开 <http://127.0.0.1:5178> 即可。

开发模式（改后端自动重启、改前端自动重新编译，刷新浏览器生效）：

```bash
npm run dev
```

### 想先用一个真实服务试试？

仓库自带一个示例服务：

```bash
npm run build && npm start
```

然后在界面点「添加服务」→「直接输入路径」，粘贴
`<仓库路径>/examples/demo-service/package.json` → 解析 → 启动。
示例服务会在 `7100` 端口起一个 HTTP 服务，周期性打日志，并且可通过
`http://127.0.0.1:7100/load/up` 人为制造 CPU 负载，方便观察曲线变化。

---

## 使用说明

### 1. 定位并纳管服务

点击 **添加服务**，在第一步「定位文件」里有三种方式：

- **浏览目录**：从盘符开始逐级进入。当前目录存在 `package.json` 时该行会高亮成绿色，
  点一下即选中；顶部有面包屑与「上级」按钮，右侧显示子目录数量。
- **直接输入路径**：粘贴 `package.json` 的绝对路径；也可以直接粘贴**项目目录**，会自动补 `/package.json`。
- **批量扫描**：填目录 + 深度（1~4 层），自动跳过 `node_modules`、`.git`、`dist` 等目录，
  一次列出所有可纳管的项目。

选中后进入第二步「启动配置」：

| 字段 | 说明 |
| --- | --- |
| 显示名称 | 默认取 `package.json` 的 name |
| 监听端口 | 可选；填了会以 `PORT` 环境变量注入子进程 |
| 启动方式 | `npm script` / `直接 node 启动` / `自定义命令` |
| npm script | 下拉列出全部 scripts，推荐项已标注（优先级：start > dev > serve > …） |
| 附加参数 | 空格分隔，支持引号，会追加到命令尾部 |
| 环境变量 | 每行 `KEY=VALUE` |
| 异常退出自动重启 | 开启后崩溃会指数退避重启，1 分钟内最多 5 次 |
| 纳管后立即启动 | 勾选则保存后直接拉起 |

### 2. 启停与状态

服务卡片上的操作按钮随状态变化：

- 停止 / 异常退出 → 显示 **启动**
- 运行中 → 显示 **停止** / **重启**
- 外部运行中（残留进程）→ 显示 **终止残留进程**

状态含义：

| 状态 | 含义 |
| --- | --- |
| `running` | 运行中（已存活超过 1.2s 的启动保护期） |
| `starting` | 已 spawn，等待进入稳定运行 |
| `stopping` | 正在停止，等待进程树退出 |
| `stopped` | 由本工具正常停止 |
| `exited` | 自行退出且退出码为 0（如正常处理完任务） |
| `crashed` | 退出码非 0，或停止超时 |
| `orphaned` | 管理端重启后发现上次托管的进程仍在运行 —— 一键终止即可 |

### 3. 查看指标

服务卡片上有两条迷你曲线：

- **CPU 占用（占整机）**：任务管理器口径，多核机器上单核跑满约为 `100 / 核数 %`。
  详情页同时给出「单核基准」口径（top / pidusage 口径），单核跑满为 100%。
- **内存占用（工作集）**：包含共享页，与任务管理器的「内存」列接近。

详情抽屉的「指标」页有放大曲线与采样信息；「概览」页有进程明细表（PID / 进程名 / 角色 / 内存 / CPU）。

### 4. 监听端口与浏览器入口

每个服务会**实时探测它真正在监听哪些端口**，而不是只显示配置里写的数字：

- 卡片上的「监听端口」标签显示探测结果（TCP 蓝色 / UDP 紫色），鼠标悬停可看到绑定地址；
- 服务没起来、端口还没 bind 时这里为空，只会用琥珀色标注「声明 :7100（未监听）」；
- 详情抽屉「概览」页给出完整明细：协议、绑定地址、端口，以及每个 TCP 端口的单独「打开 ↗」。

**浏览器入口**的推导顺序：

1. 配置里填了「浏览器入口地址」→ 原样使用（支持省略协议，会自动补 `http://`）；
2. 否则取探测到的 TCP 端口（优先配置声明的那个）→ `http://127.0.0.1:<端口>/`；
3. 服务未运行时退化为配置声明的端口，保证入口始终可点。

点「浏览器打开 ↗」会在新标签页打开入口地址（标准 `<a target="_blank">`，不受弹窗拦截影响）。
如果服务绑定在 `0.0.0.0` 且你从另一台机器访问本控制台，`127.0.0.1` 会指向你自己的机器 ——
这时在「配置」页把入口地址填成实际可达的地址（如 `http://192.168.1.20:7100/`）即可。

端口探测同样按平台能力自动降级：

| 平台 | 实现 | 说明 |
| --- | --- | --- |
| Windows | `netstat -ano` | 系统自带、普通用户可读；不依赖被拒的 WMI/CIM |
| Linux | `/proc/net/tcp{,6}` + `/proc/<pid>/fd` | 用 socket inode 精确匹配到进程，无需任何外部命令 |
| macOS | `lsof -nP -iTCP -sTCP:LISTEN` | 系统自带 |

探测周期默认 5s（比指标采样慢一档，端口变化不频繁），一次刷新覆盖所有服务。

### 5. 查看日志

详情抽屉的「日志」页：

- 按 `全部 / stdout / stderr / 系统` 筛选，带条数统计
- 关键字搜索并高亮
- 自动滚动开关、「到底部」、「重新载入」（从磁盘重读）、「复制」、「清空」
- 底部显示内存缓冲行数与 stdout 落盘路径

日志是**先落盘再展示**的：子进程的 stdout/stderr 直接重定向到
`data/logs/<服务ID>.out.log` 与 `.err.log`（文件描述符 stdio，不走管道），
管理端再以 250ms 轮询增量读取。因此管理端重启后历史日志仍在。

---

## 设计要点

### 启动方式解析：为什么尽量绕开 npm 包装层

`npm run xxx` 会额外拉起 `cmd.exe → npm → node` 三层进程。如果只统计根进程的 CPU/内存，
拿到的其实是 `cmd.exe` 的数字，毫无意义。所以本工具会尽力**把 npm script 还原成直接可执行的形式**：

| mode | 触发条件 | 实际执行 | 意义 |
| --- | --- | --- | --- |
| `node` | 启动方式选「直接 node 启动」 | `node <入口文件>` | 根进程即服务进程 |
| `node-direct` | script 内容是 `node xxx.js` | `node xxx.js` | 去掉 npm 包装层 |
| `node-bin` | script 首个 token 能在 `node_modules/.bin` 找到 | `node <bin 指向的 JS>` | 从 `.cmd`/shim 里解析出真实 JS 入口 |
| `npm-cli` | 以上都不匹配 | `node <npm-cli.js> run <script>` | 保留 npm 完整语义（PATH 注入等） |
| `npm-shell` | 找不到 `npm-cli.js` | shell 执行 `npm run <script>` | 最后兜底 |
| `custom` | 选「自定义命令」 | shell 执行自定义命令 | 支持 `pnpm`/`tsx` 等任意命令 |

界面「概览」页会明确显示实际执行的 mode 与命令行，不猜、不藏。

### 指标采集：按平台能力自动降级

| 平台 | provider | 进程树 | 实现 |
| --- | --- | --- | --- |
| Linux | `proc` | ✅ | 直接读 `/proc/<pid>/stat` + 全表 ppid |
| macOS | `ps` | ✅ | `ps -axo pid=,ppid=,rss=,time=,comm=` |
| Windows（WMI 可读） | `wmi` | ✅ | PowerShell `Get-CimInstance Win32_Process` 一次枚举全表 |
| Windows（WMI 被拒） | `basic` | ❌ 仅主进程 | PowerShell `Get-Process -Id <pids>` |

采集器启动时探测一次能力并缓存，降级时会在界面顶部与卡片上明确提示：

> 当前平台未能读取进程父子关系，指标仅覆盖主进程。使用「直接 node 启动」可获得最准确的数据。

**CPU 百分比**由两次采样的累计 CPU 时间差除以墙钟时间得到（Windows 用
`KernelModeTime + UserModeTime`，单位 100ns；Linux 用 `utime + stime`；macOS 解析 `ps` 的 `time` 列），
因此需要至少两个采样点后才会出现非零值。

### 日志为什么用文件描述符而不是管道

- 子进程写管道时，若管理端读取不及时会**写阻塞**，拖慢甚至卡死被托管服务；
- 受限运行环境（例如某些沙箱）禁止创建命名管道，`stdio: 'pipe'` 会直接 `EPERM`；
- 落盘后天然具备历史留存能力。

代价是实时性依赖 250ms 轮询（对运维查看完全够用）。

### 停止与进程树回收

- **Windows**：`taskkill /PID <pid> /T`（优雅，对无窗口的控制台程序通常无效）→ 短暂等待 →
  `taskkill /PID <pid> /T /F` → 若 `taskkill` 本身不可用，最后用 Node 原生 `process.kill` 兜底。
- **POSIX**：子进程以 `detached: true` 启动独立进程组，停止时对 `-pgid` 发 `SIGTERM`，
  超时后 `SIGKILL`，保证 `npm/pnpm` 之类的包装层不留孤儿。

> 说明：Windows 没有真正的 `SIGTERM`，`process.kill` 等价于 `TerminateProcess`，
> 因此 Windows 上的停止本质是强制终止（与 PM2 行为一致）；POSIX 上才有优雅退出窗口。

---

## 目录结构

```
service-manager/
├── package.json                # 只有 express + vue 两个直接依赖
├── vite.config.js              # 【可选】想用 Vite/HMR 时的配置，默认链路不使用
├── server/src/
│   ├── index.js                # Express 路由 + SSE + 采样循环 + 静态托管
│   ├── config.js               # 路径/端口/采样周期等常量
│   ├── store.js                # 服务清单持久化（data/services.json，原子写）
│   ├── packageScanner.js       # package.json 定位/解析/目录浏览/批量扫描
│   ├── pm.js                   # 进程管理器：启动计划解析、启停、状态机、进程树终止
│   ├── metrics.js              # 跨平台进程指标采集与进程树聚合
│   ├── ports.js                # 监听端口探测（netstat / /proc / lsof）+ 入口地址推导
│   ├── logs.js                 # 日志落盘 + 增量 tail + 环形缓冲
│   └── util.js                 # 进程存活探测、参数转义等
├── web/
│   ├── index.html
│   └── src/
│       ├── main.js  App.vue  store.js  api.js  format.js  styles.css
│       └── components/  ServiceCard / ServiceDetail / LogPanel
│                        AddServiceModal / Sparkline
├── scripts/
│   ├── build-web.mjs           # 纯 JS 前端构建（@vue/compiler-sfc）
│   ├── dev.mjs                 # 同时起服务端与前端构建 watcher
│   └── smoke-test.mjs          # 端到端冒烟测试
├── examples/demo-service/      # 用于验证的示例 Node 服务
├── docs/screenshots/           # 界面截图
└── data/                       # 运行期数据（自动创建，已在 .gitignore 中）
    ├── services.json           # 托管服务清单
    ├── logs/<id>.out.log       # 子进程 stdout
    ├── logs/<id>.err.log       # 子进程 stderr
    └── logs/<id>.system.log    # 启停等系统事件
```

### 前端构建为什么不用 Vite

默认构建链是 `scripts/build-web.mjs`：用 **`@vue/compiler-sfc`（纯 JS）** 把每个 `.vue`
编译成浏览器可直接执行的 ESM，配合 `<script type="importmap">` 把裸模块 `vue`
映射到本地的 `vue.esm-browser.prod.js`，再由 Express 直接托管。

好处：

- **零原生二进制**：不依赖 esbuild/rollup，`npm install` 不会触发任何构建脚本，
  在没有 postinstall 执行权限、或禁止创建管道的受限环境里同样能构建；
- **构建极快**：6 个 SFC + 4 个 JS 约 0.3 秒，改完刷新即可；
- **产物可读**：不做压缩混淆，排查线上问题时能直接看编译后的代码。

代价是没有 HMR 与代码压缩。如果你需要，装上 Vite 后使用仓库里保留的配置即可：

```bash
npm i -D vite @vitejs/plugin-vue
npx vite          # HMR 开发服务器（/api 已代理到 :5178）
npx vite build    # 打包压缩产物到 dist/
```

---

## REST API

服务端默认 `http://127.0.0.1:5178`，全部返回 JSON（`{ ok: true, ... }` / `{ ok: false, code, message }`）。

### 服务管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与运行信息 |
| GET | `/api/system` | 宿主 CPU / 内存 / 采集器能力 |
| GET | `/api/services` | 服务列表（含运行时状态、指标、指标历史、**监听端口**与**浏览器入口**） |
| POST | `/api/services` | 纳管服务（body: `packageJsonPath` 必填，`script`/`runtime`/`args`/`env`/`port`/`entryUrl`/`autoRestart`/`autoStart` 可选） |
| GET | `/api/services/:id` | 单个服务详情 |
| PATCH | `/api/services/:id` | 修改配置（运行中会拒绝，需先停止） |
| DELETE | `/api/services/:id?force=true` | 移除托管（force 会一并终止进程） |
| POST | `/api/services/:id/start` | 启动 |
| POST | `/api/services/:id/stop` | 停止（body: `{ force: true }` 强制） |
| POST | `/api/services/:id/restart` | 重启 |
| POST | `/api/services/:id/kill-orphan` | 终止残留进程 |
| GET | `/api/services/:id/plan` | 预览实际会执行的命令与 mode |
| GET | `/api/services/:id/logs?limit=500` | 读取日志（含磁盘字节数与落盘路径） |
| DELETE | `/api/services/:id/logs` | 清空日志 |
| POST | `/api/services/start-all` | 批量启动 |
| POST | `/api/services/stop-all` | 批量停止 |

### package.json 定位

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/fs/roots` | 可浏览的盘符/根目录 |
| GET | `/api/fs/list?path=<dir>` | 列出子目录；若该目录有 `package.json` 则一并解析返回 |
| POST | `/api/package/analyze` | 解析指定 `package.json`（body: `packageJsonPath`） |
| POST | `/api/scan` | 批量扫描（body: `dir`, `depth`） |

### 实时推送

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/events` | SSE 流。事件：`hello` / `snapshot`（宿主 + 服务 + 指标，默认 3s 一次）/ `log` / `status` / `services-changed` |

示例：

```bash
# 纳管示例服务并立即启动
curl -X POST http://127.0.0.1:5178/api/services \
  -H 'content-type: application/json' \
  -d '{"packageJsonPath":"D:/path/to/package.json","autoStart":true}'

# 查看它到底会执行什么
curl http://127.0.0.1:5178/api/services/<id>/plan

# 跟着看实时推送
curl -N http://127.0.0.1:5178/api/events
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SM_PORT` / `PORT` | `5178` | 治理服务端端口 |
| `SM_HOST` | `127.0.0.1` | 监听地址（默认仅本机可访问） |
| `SM_DATA_DIR` | `<仓库>/data` | 运行期数据目录 |
| `SM_SAMPLE_INTERVAL` | `3000` | 指标采样周期（毫秒） |
| `SM_PORT_SAMPLE_INTERVAL` | `5000` | 监听端口探测周期（毫秒） |
| `SM_LOG_LINES` | `2000` | 每服务内存中保留的日志行数 |
| `SM_STOP_GRACE` | `6000` | 停止时的优雅等待上限（毫秒），超时强杀 |

---

## 测试与验证

仓库自带端到端冒烟测试，覆盖「定位 → 纳管 → 启动 → 日志 → 指标 → 端口探测 → 浏览器入口 → 停止 → 重启 → 清理」全链路：

```bash
npm run build
npm start                 # 另开一个终端
npm run test:smoke
```

当前基线（Windows 11 / Node v22.22.0，16 核）：

```
=== Node 服务治理工具 · 端到端冒烟测试 ===
  [PASS] 健康检查 /api/health  — pid=11744
  [PASS] 解析 package.json  — recommendedScript=start entry=✓
  [PASS] 纳管服务 POST /api/services  — id=9c936aa340838369
  [PASS] 预览启动计划  — mode=node-direct → node index.js
  [PASS] 启动服务  — pid=6352
  [PASS] 状态变为 running  — status=running
  [PASS] 进程存活  — pid=6352
  [PASS] 采集到日志  — 7 行, 磁盘 {"out":118,"err":0}
  [PASS] 日志含服务启动输出  — [demo-service] listening on http://127.0.0.1:7100
  [PASS] 系统日志无重复（回归）  — 无重复
  [PASS] 上报内存占用  — 89.2 MB
  [PASS] 上报 CPU 占用  — 占整机 6.20% / 单核基准 99.2%
  [PASS] 指标采样作用域已知  — scope=process
  [PASS] 指标历史累积（用于曲线）  — 3 个采样点
  [PASS] 探测到监听端口  — [{"address":"0.0.0.0","port":7100,"proto":"tcp"}]
  [PASS] 入口地址按探测端口推导  — http://127.0.0.1:7100/（source=detected, live=true）
  [PASS] 入口地址可访问  — http://127.0.0.1:7100/
  [PASS] 端口探测方式已知  — netstat / netstat -ano
  [PASS] 宿主指标 /api/system  — 16 核 / 内存 21.4GB 已用 / 采集器 basic
  [PASS] 停止服务  — status=stopped
  [PASS] 进程已被终止  — pid=6352
  [PASS] 服务端口已释放  — 端口 7100 已关闭
  [PASS] 停止后端口探测结果清空  — []
  [PASS] 停止后入口退化为配置声明  — http://127.0.0.1:7100/（source=declared）
  [PASS] 入口地址可手工覆盖并自动补协议  — http://app.internal:8080/health（source=override）
  [PASS] 重启服务  — 新 pid=42692（旧 6352）
  [PASS] 重启后状态与 PID 不被上一代 exit 篡改（代次隔离回归）  — 2.5s 后 status=running pid=42692
  [PASS] 强制停止后状态稳定为 stopped（exit 竞态回归）  — 5 轮结果：stopped / stopped / stopped / stopped / stopped
  [PASS] 目录浏览：列出子目录  — 1 个子目录，其中 0 个 package.json
  [PASS] 目录浏览：命中 package.json  — demo-service@1.0.0，推荐 script=start
  [PASS] 目录浏览：返回上级路径  — parent=<仓库路径>/examples
  [PASS] 批量扫描 package.json  — 命中 1 个
  [PASS] 移除托管记录  — 清理完成

=== 结果: 33/33 通过 ===
```

最后两条是开发过程中定位到真实缺陷后补的回归用例，值得单独说明：

- **exit 竞态回归**：进程被操作系统回收与其 `exit` 事件送达之间存在时间差。
  最初只看「当前状态是否为 stopping」来判定，导致显式 `stop()` 之后迟到的 `exit`
  会把状态回写成 `crashed`。现在用每轮的 `pendingStop` 意图标记判定。
- **代次隔离回归**：`restart` 会在 500ms 后拉起新进程，而上一代进程的 `exit`
  可能在这之后才送达；若不隔离，它会**清空新一代进程的 PID**，
  使新进程彻底脱离托管（状态显示 crashed，但进程仍在跑并占着端口）。
  现在每次 spawn 递增一个 `gen`，只有当前代的 `exit`/`error` 才能改写状态。

另外，端口探测与入口地址这 7 条用例是在真实浏览器中点击验证过 UI 之后补进自动化测试的：
卡片与详情抽屉都渲染出 `<a href="http://127.0.0.1:7100/" target="_blank" rel="noopener noreferrer">`，
并且该地址确实能被浏览器打开（示例服务返回 JSON）。


---

## 常见问题

**Q：服务启动了但 CPU/内存一直是 0 或 —。**
先等两个采样周期（默认 6 秒）。CPU 是区间差值，第一个点无法计算。
若状态不是「运行中」，说明进程已经退出，去日志页看 stderr。

**Q：内存数字比服务自己 `process.memoryUsage().rss` 报的大。**
界面用的是操作系统的**工作集**口径（含共享页），与任务管理器一致；
`rss` 是进程私有驻留集。两者都合理，只是口径不同。

**Q：卡片上提示「指标仅覆盖主进程」。**
说明当前 Windows 环境的 WMI/CIM 不可读（受限账户、组策略或沙箱都会导致），
拿不到进程父子关系，无法把 npm 包装层里的真实服务进程算进来。
解决办法有两个：把启动方式改成「直接 node 启动」，或者让治理服务端以可读 WMI 的账户运行。

**Q：点击停止后进程还活着。**
Windows 上 `taskkill /T` 对无窗口的控制台程序通常无效，会自动升级为 `/F` 强杀。
若日志出现「停止超时」，通常是权限不足（例如被托管进程以管理员身份启动）。
此时可以手动结束，或让治理服务端与其同权限运行。

**Q：管理端重启后，服务卡片显示「外部运行中」。**
这是预期行为：治理服务端退出时**不会**连带杀掉被托管的服务（否则重启管理端就等于重启所有业务）。
下次启动时会通过持久化的 PID 识别出这些残留进程，点「终止残留进程」即可回收；
也可以先停止管理端再启动，让它重新接管。

**Q：端口 5178 被占用。**
用 `SM_PORT=xxxx npm start`，或在 `package.json` 的 `start` 脚本里改。

**Q：`npm install` 报 EPERM / 缓存目录无权限。**
某些受限环境不允许写全局 npm 缓存。指定一个可写目录即可：
`npm install --cache=./.npm-cache`。

---

## 已知限制

- 全局单实例：同一时刻只服务一份 `data/` 清单，没有多用户与鉴权，**仅监听 `127.0.0.1`**。
- **一个 `package.json` 只能纳管一次**：同一份 package.json 重复纳管会被拒绝（接口返回 400）。
  如果想用同一个项目起两个实例（例如两个端口），请复制项目目录，或改用「自定义命令」托管另一个副本。
- 进程状态不跨管理端重启继承：重启后靠持久化 PID 判断存活，不恢复日志流之外的运行上下文。
- 指标依赖 PowerShell 子进程（Windows，每次采样一次 `Get-Process`），
  在进程数极多的机器上单次采样约数百毫秒；Linux/macOS 无此开销。
- CPU 是两次采样的差值，因此服务启动后需要等到下一次采样才会出现非零 CPU。
- 端口探测默认 5s 一次，服务刚启动到端口出现在界面上最多有 5s 延迟；
  探测依赖系统工具（Windows `netstat`、macOS `lsof`），若被裁剪或禁用则只显示配置声明的端口。
- 浏览器入口默认指向 `127.0.0.1`：服务若绑定 `0.0.0.0` 且你从其它机器访问本控制台，
  需要手工把入口地址改成实际可达的地址。
- 端口探测只能看到「本工具托管的那棵进程树」的端口；服务若自行 fork 出脱离进程树的新进程，
  其端口不会被计入。
- 「自动重启」按服务独立计数，达到 1 分钟 5 次上限后会停止重试，需要手动介入。
- 批量扫描最多返回 100 条结果、最多遍历 3000 个目录；目录浏览单层最多 400 个条目。

## 许可

仅供内部/本地使用。

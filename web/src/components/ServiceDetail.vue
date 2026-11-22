<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import Sparkline from './Sparkline.vue';
import LogPanel from './LogPanel.vue';
import { api } from '../api.js';
import { actions, loadLogs, refresh, toast } from '../store.js';
import {
  STATUS_META, formatBytes, formatClock, formatPercent, formatUptime,
  envToText, parseArgs, parseEnv, statusLabel, entrySourceLabel, ENTRY_SOURCE_META,
} from '../format.js';

const props = defineProps({
  service: { type: Object, required: true },
  logs: { type: Array, default: () => [] },
});
const emit = defineEmits(['close']);

const tab = ref('overview');
const pkgInfo = ref(null);
const pkgError = ref('');
const busy = ref(false);
const saving = ref(false);

const st = computed(() => props.service.state || {});
const meta = computed(() => STATUS_META[st.value.status] || {});
const isRunning = computed(() => ['running', 'starting', 'stopping'].includes(st.value.status));
const metrics = computed(() => props.service.metrics || null);
const history = computed(() => props.service.history || { ts: [], cpu: [], memory: [] });

const cpuMax = computed(() => Math.min(100, Math.max(4, Math.ceil(Math.max(0, ...history.value.cpu) / 10) * 10)));
const memMax = computed(() => Math.max(1, ...history.value.memory) * 1.15);

const form = reactive({
  name: '', port: '', args: '', env: '', autoRestart: false, script: '', runtime: 'npm', command: '', entryUrl: '', cwd: '',
});
/** 启动计划预览（保存前先看清到底会执行什么命令） */
const planPreview = ref(null);
const previewError = ref('');
const previewing = ref(false);
/** 重新检测 package.json 里的可用 script */
const detectingScripts = ref(false);
/** 下拉里没有的脚本（例如刚手写进去、还没重载）走手动输入 */
const manualScriptMode = ref(false);
const manualScript = ref('');

const ports = computed(() => props.service.ports || []);
const entry = computed(() => props.service.entry || { url: '', source: 'none', live: false });
const entryMeta = computed(() => ENTRY_SOURCE_META[entry.value.source] || ENTRY_SOURCE_META.none);
const portScan = computed(() => props.service.portScan || {});

function syncForm() {
  form.name = props.service.name || '';
  form.port = props.service.port ?? '';
  form.args = (props.service.args || []).join(' ');
  form.env = envToText(props.service.env);
  form.autoRestart = Boolean(props.service.autoRestart);
  form.script = props.service.script || '';
  form.runtime = props.service.runtime || 'npm';
  form.command = props.service.command || '';
  form.entryUrl = props.service.entryUrl || '';
  form.cwd = props.service.cwd || '';
  manualScriptMode.value = false;
  manualScript.value = '';
  planPreview.value = null;
  previewError.value = '';
}

/** 表单 → 接口载荷（保存与预览共用，避免两处漂移） */
function draftPayload() {
  return {
    name: form.name,
    port: form.port === '' ? null : Number(form.port),
    args: parseArgs(form.args),
    env: parseEnv(form.env),
    autoRestart: form.autoRestart,
    script: form.script,
    runtime: form.runtime,
    command: form.command,
    entryUrl: form.entryUrl,
    cwd: form.cwd.trim() || props.service.root,
  };
}

/**
 * 重新检测 package.json 里的可用 script。
 * package.json 可能在纳管之后被改过（新增/改名 script），所以不能只在打开抽屉时读一次。
 */
async function detectScripts({ silent = false } = {}) {
  detectingScripts.value = true;
  try {
    const res = await api.analyze(props.service.packageJsonPath);
    pkgInfo.value = res.packageInfo;
    pkgError.value = '';
    syncScriptMode();
    if (!silent) {
      const count = res.packageInfo?.scripts?.length || 0;
      toast(`已重新检测：${count} 个可用 script`, count ? 'ok' : 'err', count ? 3000 : 6000);
    }
  } catch (err) {
    pkgInfo.value = null;
    pkgError.value = err.message;
    if (!silent) toast(`重新检测失败：${err.message}`, 'err', 6000);
  } finally {
    detectingScripts.value = false;
  }
}

onMounted(async () => {
  syncForm();
  // 打开抽屉即回填磁盘上的历史日志（SSE 只能拿到连接之后的增量）
  await loadLogs(props.service.id, 800);
  await detectScripts({ silent: true });
});

// 快照每 3s 会换成新对象；只在切换服务时回填，避免把用户正在编辑的表单冲掉
watch(() => props.service?.id, async (id) => {
  if (!id) return;
  syncForm();
  await detectScripts({ silent: true });
});

watch(tab, (next) => {
  if (next === 'logs') void loadLogs(props.service.id, 800);
});

async function save() {
  saving.value = true;
  try {
    await api.update(props.service.id, draftPayload());
    toast('配置已保存', 'ok');
    await refresh();
    syncForm();
  } catch (err) {
    toast(err.message, 'err', 6000);
  } finally {
    saving.value = false;
  }
}

/** 运行中更换启动命令：后端按「停 → 存 → 启」执行，避免改完还要手动重启 */
async function saveAndRestart() {
  saving.value = true;
  try {
    const res = await api.changeLaunch(props.service.id, { ...draftPayload(), restart: true });
    if (res.startError) {
      toast(`启动命令已保存，但按新命令启动失败：${res.startError}`, 'err', 9000);
    } else {
      toast('启动命令已更换，服务已按新命令重启', 'ok');
    }
    planPreview.value = res.plan || null;
    await loadLogs(props.service.id);
    await refresh();
    const keepPlan = planPreview.value;
    syncForm();
    planPreview.value = keepPlan;
  } catch (err) {
    toast(err.message, 'err', 7000);
  } finally {
    saving.value = false;
  }
}

/** 预览启动计划：不落盘、不启动，只解析出实际会执行的命令 */
async function preview() {
  previewing.value = true;
  previewError.value = '';
  try {
    const res = await api.planPreview(props.service.id, draftPayload());
    planPreview.value = res.plan;
  } catch (err) {
    planPreview.value = null;
    previewError.value = err.message;
  } finally {
    previewing.value = false;
  }
}

/** 表单里填的 script 是否已存在于 package.json（允许自由输入，但先提示一下） */
const scriptKnown = computed(() => {
  const name = form.script.trim();
  if (!name) return false;
  return (pkgInfo.value?.scripts || []).some((s) => s.name === name);
});

/** package.json 里可选的 script 名称（给下拉用） */
const scriptNames = computed(() => (pkgInfo.value?.scripts || []).map((s) => s.name));

/**
 * 决定 script 用「下拉」还是「手动输入」：
 * - 当前脚本在 package.json 里 → 下拉选中它
 * - 不在（刚改过 package.json、或当前配置本来就是个自定义名字）→ 手动输入并提示
 */
function syncScriptMode() {
  const name = form.script.trim();
  if (!name) {
    manualScriptMode.value = false;
    manualScript.value = '';
    return;
  }
  if (scriptNames.value.includes(name)) {
    manualScriptMode.value = false;
    manualScript.value = '';
  } else {
    manualScriptMode.value = true;
    manualScript.value = name;
  }
}

watch(scriptNames, () => syncScriptMode());

watch(manualScript, (value) => {
  if (manualScriptMode.value) form.script = value.trim();
});

function useManualScript() {
  manualScriptMode.value = true;
  manualScript.value = form.script;
}

function useScriptDropdown() {
  manualScriptMode.value = false;
  const first = scriptNames.value[0];
  if (!form.script.trim() && first) form.script = first;
}

async function guard(fn) {
  busy.value = true;
  try { await fn(); } finally { busy.value = false; }
}

const version = computed(() => pkgInfo.value?.version || '');
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <aside class="drawer">
      <header class="drawer-head">
        <span class="dot" :class="st.status" />
        <div class="grow" style="min-width: 0">
          <h2 class="ellipsis">{{ service.name }}</h2>
          <div class="hint ellipsis mono" :title="service.packageJsonPath">{{ service.packageJsonPath }}</div>
        </div>
        <span class="tag" :class="meta.color">{{ statusLabel(st.status) }}</span>
        <button class="btn ghost icon" title="关闭" @click="emit('close')">✕</button>
      </header>

      <nav class="tabs">
        <button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button>
        <button :class="{ active: tab === 'metrics' }" @click="tab = 'metrics'">指标</button>
        <button :class="{ active: tab === 'logs' }" @click="tab = 'logs'">日志</button>
        <button :class="{ active: tab === 'config' }" @click="tab = 'config'">配置</button>
      </nav>

      <div class="drawer-body">
        <!-- 概览 -->
        <template v-if="tab === 'overview'">
          <div v-if="pkgError" class="banner err" style="margin-bottom: 12px">
            <span>✕</span><span class="grow">package.json 已不可读：{{ pkgError }}</span>
          </div>
          <div v-if="st.lastError" class="banner warn" style="margin-bottom: 12px">
            <span>⚠</span><span class="grow">{{ st.lastError }}</span>
          </div>
          <div v-if="st.extraInstances?.length" class="banner warn" style="margin-bottom: 12px">
            <span>⚠</span>
            <span class="grow">
              该服务已托管运行，另有 {{ st.extraInstances.length }} 个外部实例：
              <template v-for="(inst, i) in st.extraInstances" :key="inst.pid">
                <span class="mono">PID {{ inst.pid }}</span><template v-if="inst.ports?.length">（端口 {{ inst.ports.join(', ') }}）</template><template v-if="i < st.extraInstances.length - 1">、</template>
              </template>
              。同一服务多端口启动时，指标与端口按实例组汇总。
            </span>
          </div>

          <div class="kv" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr))">
            <div class="item"><span class="k">状态</span><span class="v">{{ statusLabel(st.status) }}</span></div>
            <div class="item">
              <span class="k">PID</span>
              <span class="v mono">
                {{ st.pid || '—' }}
                <span v-if="(st.pids?.length || 0) > 1" class="tag amber" style="margin-left: 4px">+{{ st.pids.length - 1 }} 实例</span>
              </span>
            </div>
            <div class="item"><span class="k">运行时长</span><span class="v">{{ ['running','starting'].includes(st.status) ? formatUptime(st.uptimeMs) : '—' }}</span></div>
            <div class="item"><span class="k">端口</span><span class="v mono">{{ service.port || '—' }}</span></div>
            <div class="item"><span class="k">重启次数</span><span class="v">{{ st.restarts || 0 }}</span></div>
            <div class="item"><span class="k">退出码</span><span class="v mono">{{ st.exitCode ?? '—' }}</span></div>
            <div class="item"><span class="k">启动时间</span><span class="v" style="font-size: 12.5px">{{ formatClock(st.startedAt) }}</span></div>
            <div class="item"><span class="k">版本</span><span class="v">{{ version || '—' }}</span></div>
          </div>

          <div class="section-title">监听端口与浏览器入口</div>
          <div class="card" style="padding: 12px 14px">
            <div class="row" style="gap: 10px; align-items: flex-start; flex-wrap: wrap">
              <div class="grow" style="min-width: 220px">
                <div class="hint" style="margin-bottom: 6px">
                  实时探测（{{ portScan.providerLabel || '探测中…' }}<template v-if="portScan.sampledAt">，采样于 {{ formatClock(portScan.sampledAt) }}</template>）
                </div>
                <template v-if="ports.length">
                  <div v-for="p in ports" :key="`${p.proto}-${p.port}-${p.address}`" class="port-row">
                    <span class="tag" :class="p.proto === 'tcp' ? 'blue' : 'purple'">
                      {{ p.proto === 'udp' ? 'UDP' : 'TCP' }}
                    </span>
                    <span class="addr">{{ p.address }}:{{ p.port }}</span>
                    <span class="grow" />
                    <a
                      v-if="p.proto === 'tcp'"
                      class="btn ghost sm"
                      :href="`http://127.0.0.1:${p.port}/`"
                      target="_blank"
                      rel="noopener noreferrer"
                    >打开 ↗</a>
                  </div>
                </template>
                <div v-else class="hint">
                  {{ service.port ? `尚未探测到监听端口（配置声明为 ${service.port}）` : '尚未探测到监听端口' }}
                </div>
              </div>

              <div style="min-width: 210px">
                <div class="hint" style="margin-bottom: 6px">浏览器入口</div>
                <div v-if="entry.url" class="row" style="gap: 8px; flex-wrap: wrap">
                  <a
                    class="btn primary sm"
                    :href="entry.url"
                    target="_blank"
                    rel="noopener noreferrer"
                  >在浏览器打开 ↗</a>
                  <span class="tag" :class="entryMeta.color">{{ entrySourceLabel(entry.source) }}</span>
                </div>
                <div v-else class="hint">未识别入口，可在「配置」页手工填写</div>
                <div v-if="entry.url" class="entry-url mono" style="border-top: none; padding-top: 6px">{{ entry.url }}</div>
              </div>
            </div>
            <div v-if="portScan.warning" class="banner warn" style="margin-top: 10px">
              <span>⚠</span><span class="grow">{{ portScan.warning }}</span>
            </div>
          </div>

          <div class="section-title">启动计划</div>
          <div class="card" style="padding: 12px 14px">
            <div class="row" style="gap: 8px; margin-bottom: 8px">
              <span class="tag blue">{{ st.plan?.mode || service.runtime }}</span>
              <span class="hint">{{ st.plan?.note }}</span>
            </div>
            <div class="mono" style="font-size: 12.5px; word-break: break-all; line-height: 1.7">
              {{ st.plan?.display || (service.runtime === 'npm' ? `npm run ${service.script}` : service.command) }}
            </div>
            <div v-if="st.plan?.exe" class="hint mono" style="margin-top: 8px; word-break: break-all">
              可执行文件：{{ st.plan.exe }}
            </div>
          </div>

          <div class="section-title">进程详情（{{ metrics?.processCount ?? 0 }} 个进程 · {{ metrics?.scope === 'tree' ? '进程树' : '仅主进程' }}）</div>
          <table class="plain">
            <thead>
              <tr><th>PID</th><th>进程名</th><th>角色</th><th>监听端口</th><th class="num">内存</th><th class="num">CPU</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in (metrics?.processes || [])" :key="p.pid">
                <td class="mono">{{ p.pid }}</td>
                <td>{{ p.name }}</td>
                <td>
                  <span v-if="p.isRoot" class="tag green">主进程</span>
                  <span v-else class="tag">子进程</span>
                </td>
                <td>
                  <template v-if="p.ports?.length">
                    <a
                      v-for="x in p.ports"
                      :key="`${x.proto}-${x.port}`"
                      class="tag blue"
                      style="text-decoration: none; margin-right: 4px"
                      :href="`http://127.0.0.1:${x.port}/`"
                      target="_blank"
                      rel="noopener noreferrer"
                      :title="`${x.address}:${x.port}（${x.proto.toUpperCase()}）—— 点击在浏览器打开`"
                    >:{{ x.port }} ↗</a>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
                <td class="num">{{ formatBytes(p.rss) }}</td>
                <td class="num">{{ formatPercent(p.cpuPercent, 2) }}</td>
              </tr>
              <tr v-if="!metrics?.processes?.length">
                <td colspan="6" class="muted" style="text-align: center; padding: 16px">服务未运行</td>
              </tr>
            </tbody>
          </table>
          <div v-if="(metrics?.processes?.length || 0) > 1" class="hint" style="margin-top: 8px">
            该服务由多个进程组成（例如 concurrently / pnpm 并行启动的前后端），
            上面列出了每个子进程各自监听的端口，可直接点击打开。
          </div>

          <div class="section-title">package.json</div>
          <table class="plain">
            <tbody>
              <tr><th style="width: 130px">名称 / 版本</th><td>{{ pkgInfo?.name || service.name }} <span class="muted">{{ pkgInfo?.version }}</span></td></tr>
              <tr><th>入口文件</th><td class="mono" style="word-break: break-all">{{ pkgInfo?.entry || '—' }}</td></tr>
              <tr><th>包管理器</th><td>{{ pkgInfo?.packageManager }} <span class="muted">{{ pkgInfo?.lockFile ? `(lock: ${pkgInfo.lockFile})` : '' }}</span></td></tr>
              <tr><th>依赖数量</th><td>{{ pkgInfo?.dependencyCount?.total ?? '—' }} <span class="muted">deps {{ pkgInfo?.dependencyCount?.dependencies ?? 0 }} / dev {{ pkgInfo?.dependencyCount?.devDependencies ?? 0 }}</span></td></tr>
              <tr><th>node_modules</th><td>{{ pkgInfo?.hasNodeModules ? '已安装' : '未安装（可能需要先 npm install）' }}</td></tr>
              <tr><th>可用 scripts</th><td>
                <span v-for="s in (pkgInfo?.scripts || [])" :key="s.name" class="tag" :class="s.recommended ? 'green' : ''" style="margin: 2px 4px 2px 0">{{ s.name }}</span>
                <span v-if="!pkgInfo?.scripts?.length" class="muted">—</span>
              </td></tr>
            </tbody>
          </table>
        </template>

        <!-- 指标 -->
        <template v-else-if="tab === 'metrics'">
          <div class="kv" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin-bottom: 16px">
            <div class="item"><span class="k">CPU（占整机）</span><span class="v">{{ metrics ? formatPercent(metrics.cpuPercent, 2) : '—' }}</span></div>
            <div class="item"><span class="k">CPU（单核基准）</span><span class="v">{{ metrics ? formatPercent(metrics.cpuPercentPerCore, 1) : '—' }}</span></div>
            <div class="item"><span class="k">内存（工作集）</span><span class="v">{{ metrics ? formatBytes(metrics.memoryBytes) : '—' }}</span></div>
            <div class="item"><span class="k">进程数</span><span class="v">{{ metrics?.processCount ?? '—' }}</span></div>
          </div>

          <div class="section-title">CPU 曲线（最近 {{ history.cpu.length }} 个采样点，3s/点）</div>
          <div style="height: 120px; background: #090c11; border: 1px solid var(--border); border-radius: 8px; padding: 8px">
            <Sparkline :values="history.cpu" color="#4f9cf9" :max="cpuMax" />
          </div>

          <div class="section-title">内存曲线</div>
          <div style="height: 120px; background: #090c11; border: 1px solid var(--border); border-radius: 8px; padding: 8px">
            <Sparkline :values="history.memory" color="#a97bf5" :max="memMax" />
          </div>

          <div class="section-title">采样信息</div>
          <table class="plain">
            <tbody>
              <tr><th style="width: 150px">采样作用域</th><td>{{ metrics?.scope === 'tree' ? '进程树（含子进程）' : '仅主进程' }}</td></tr>
              <tr><th>最近采样</th><td>{{ formatClock(metrics?.sampledAt) }}</td></tr>
              <tr><th>采集器</th><td>{{ service.metrics ? '进程采样' : '—' }}</td></tr>
            </tbody>
          </table>
          <div class="hint" style="margin-top: 10px">
            指标口径：CPU 为「占整机算力」百分比（多核机器上单核跑满约等于 100/核数 %）；内存为该进程（或进程树）的工作集大小，包含共享页。
          </div>
        </template>

        <!-- 日志 -->
        <LogPanel
          v-else-if="tab === 'logs'"
          :service-id="service.id"
          :lines="logs"
          :log-paths="st.logPaths || {}"
        />

        <!-- 配置 -->
        <template v-else>
          <div v-if="isRunning" class="banner info" style="margin-bottom: 14px">
            <span>ℹ</span>
            <span class="grow">
              服务运行中：可以直接修改启动命令，点「保存并重启」即按新命令重启；其余配置也会一并保存。
            </span>
          </div>
          <div v-else-if="st.status === 'orphaned'" class="banner warn" style="margin-bottom: 14px">
            <span>⚠</span>
            <span class="grow">该服务正在外部运行。更换启动命令前，请先「接管」或「终止」外部进程。</span>
          </div>

          <div class="field" style="margin-bottom: 12px">
            <label>显示名称</label>
            <input v-model="form.name" class="input" />
          </div>
          <div class="row" style="gap: 12px; margin-bottom: 12px; align-items: flex-start">
            <div class="field grow">
              <label>启动方式</label>
              <select v-model="form.runtime" class="select">
                <option value="npm">npm script</option>
                <option value="node">直接 node 启动入口文件</option>
                <option value="custom">自定义命令</option>
              </select>
            </div>
            <div class="field grow">
              <label>监听端口（可选，会注入 PORT 环境变量）</label>
              <input v-model="form.port" class="input" placeholder="例如 3000" />
            </div>
          </div>

          <div v-if="form.runtime === 'npm'" class="field" style="margin-bottom: 12px">
            <div class="row" style="gap: 8px; align-items: center">
              <label style="margin: 0">npm script</label>
              <span class="grow" style="flex: 1" />
              <span v-if="pkgInfo" class="hint" style="margin: 0">{{ pkgInfo.scripts?.length || 0 }} 个可用</span>
              <button class="btn ghost sm" :disabled="detectingScripts" @click="detectScripts()">
                <span v-if="detectingScripts" class="spin" /> 重新检测
              </button>
            </div>

            <div class="row" style="gap: 8px; margin-top: 6px">
              <select v-if="!manualScriptMode" v-model="form.script" class="select mono grow">
                <option value="" disabled>选择 package.json 中的 script</option>
                <option v-for="s in (pkgInfo?.scripts || [])" :key="s.name" :value="s.name">
                  {{ s.name }}{{ s.recommended ? '（推荐）' : '' }} — {{ s.command }}
                </option>
                <option v-if="form.script && !scriptKnown" :value="form.script">
                  {{ form.script }}（不在 package.json 中）
                </option>
              </select>
              <input
                v-else
                v-model="manualScript"
                class="input mono grow"
                placeholder="手动输入脚本名，例如 dev"
              />
              <button class="btn ghost sm" v-if="!manualScriptMode" @click="useManualScript()">手动输入</button>
              <button class="btn ghost sm" v-else @click="useScriptDropdown()">改用下拉</button>
            </div>

            <span v-if="form.script && !scriptKnown" class="hint" style="color: #f0b35e">
              package.json 里没有名为「{{ form.script }}」的 script，保存时会校验失败；改过 package.json 的话先点「重新检测」。
            </span>
            <span v-else-if="manualScriptMode" class="hint">手动输入用于 package.json 里没有、但确实需要执行的脚本名；保存时后端仍会校验该 script 是否存在。</span>
            <span v-else class="hint">脚本列表来自 package.json；新增或改名后点「重新检测」刷新。</span>
          </div>
          <div v-else-if="form.runtime === 'custom'" class="field" style="margin-bottom: 12px">
            <label>自定义命令</label>
            <input v-model="form.command" class="input mono" placeholder="例如 pnpm exec tsx src/server.ts" />
          </div>
          <div v-else class="card" style="padding: 10px 12px; margin-bottom: 12px">
            <div class="hint">入口文件</div>
            <div class="mono" style="font-size: 12.5px; word-break: break-all">{{ pkgInfo?.entry || '未能识别入口文件' }}</div>
          </div>

          <div class="field" style="margin-bottom: 12px">
            <label>附加参数（空格分隔，支持引号）</label>
            <input v-model="form.args" class="input mono" placeholder="例如 --env production --port 3000" />
          </div>

          <div class="field" style="margin-bottom: 12px">
            <label>工作目录</label>
            <input v-model="form.cwd" class="input mono" placeholder="默认与服务根目录一致" />
            <span class="hint">命令会在这个目录下执行；留空则使用服务根目录。</span>
          </div>

          <div class="field" style="margin-bottom: 12px">
            <label>浏览器入口地址（可选）</label>
            <input
              v-model="form.entryUrl"
              class="input mono"
              placeholder="留空则按实时探测到的监听端口自动推导"
            />
            <span class="hint">
              留空由系统按探测到的端口推导（如 <span class="mono">http://127.0.0.1:7100/</span>）；
              需要 https、内网域名或带路径时在此填写，例如 <span class="mono">https://app.internal/health</span>。
            </span>
          </div>

          <div class="field" style="margin-bottom: 12px">
            <label>环境变量（每行 KEY=VALUE）</label>
            <textarea v-model="form.env" class="textarea" rows="5" placeholder="NODE_ENV=production&#10;LOG_LEVEL=info" />
          </div>

          <label class="row" style="gap: 8px; margin-bottom: 16px; cursor: pointer">
            <input v-model="form.autoRestart" type="checkbox" />
            <span>异常退出时自动重启（最多 5 次/分钟，指数退避）</span>
          </label>

          <div class="section-title">启动计划预览</div>
          <div class="card" style="padding: 12px 14px; margin-bottom: 14px">
            <div class="row" style="gap: 8px; margin-bottom: 8px">
              <span class="tag blue">{{ (planPreview || st.plan)?.mode || form.runtime }}</span>
              <span class="hint">
                {{ planPreview ? '按当前表单解析（尚未保存）' : (st.plan ? '当前生效的启动计划' : '尚未解析') }}
              </span>
            </div>
            <div class="mono" style="font-size: 12.5px; word-break: break-all; line-height: 1.7">
              {{ planPreview?.display || st.plan?.display || '—' }}
            </div>
            <div v-if="(planPreview || st.plan)?.note" class="hint" style="margin-top: 6px">
              {{ (planPreview || st.plan).note }}
            </div>
            <div v-if="previewError" class="banner err" style="margin-top: 10px">
              <span>✕</span><span class="grow">{{ previewError }}</span>
            </div>
            <div class="row" style="margin-top: 10px">
              <button class="btn ghost sm" :disabled="previewing" @click="preview">
                <span v-if="previewing" class="spin" /> 解析当前表单
              </button>
            </div>
          </div>

          <div class="row">
            <button
              v-if="isRunning"
              class="btn primary"
              :disabled="saving || ['starting', 'stopping'].includes(st.status)"
              @click="saveAndRestart"
            >
              <span v-if="saving" class="spin" /> 保存并重启
            </button>
            <button v-else class="btn primary" :disabled="saving" @click="save">
              <span v-if="saving" class="spin" /> 保存配置
            </button>
            <button class="btn" :disabled="saving" @click="syncForm">重置</button>
          </div>
        </template>
      </div>

      <footer class="drawer-foot">
        <template v-if="st.status === 'orphaned'">
          <button class="btn primary" :disabled="busy" title="纳入托管：指标/端口/停止随即生效" @click="guard(() => actions.adopt(service))">接管</button>
          <button class="btn danger" :disabled="busy" @click="guard(() => actions.killOrphan(service))">终止</button>
        </template>
        <template v-else-if="['running', 'starting'].includes(st.status)">
          <button class="btn danger" :disabled="busy" @click="guard(() => actions.stop(service))">停止</button>
          <button class="btn" :disabled="busy" @click="guard(() => actions.restart(service))">重启</button>
        </template>
        <template v-else>
          <button class="btn success" :disabled="busy" @click="guard(() => actions.start(service))">启动</button>
        </template>
        <span class="grow" />
        <span class="hint">工作目录：<span class="mono">{{ service.cwd }}</span></span>
      </footer>
    </aside>
  </div>
</template>

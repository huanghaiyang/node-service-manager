<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { refresh, toast } from '../store.js';
import { parseArgs, parseEnv } from '../format.js';

const emit = defineEmits(['close', 'created']);

const step = ref('locate');
const mode = ref('browse');

/* ---------- 浏览定位 ---------- */
const roots = ref([]);
const separator = ref('\\');
const listing = ref(null);
const listingError = ref('');
const loadingDir = ref(false);

/* ---------- 直接输入 ---------- */
const manualPath = ref('');
const manualError = ref('');

/* ---------- 批量扫描 ---------- */
const scanDir = ref('');
const scanDepth = ref(2);
const scanning = ref(false);
const scanResults = ref([]);
const scanError = ref('');

/* ---------- 配置 ---------- */
const packageInfo = ref(null);
const form = ref({
  name: '', runtime: 'npm', script: '', command: '', args: '', port: '',
  env: '', entryUrl: '', autoRestart: false, autoStart: false,
});
const submitting = ref(false);

const crumbs = computed(() => buildCrumbs(listing.value?.dir || '', separator.value));

function buildCrumbs(dir, sep) {
  const isWin = /^[A-Za-z]:/.test(dir);
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  const out = [];
  if (!isWin && dir.startsWith('/')) out.push({ label: '/', path: '/' });
  let acc = '';
  parts.forEach((p, i) => {
    if (isWin) acc = i === 0 ? `${p}\\` : `${acc.replace(/\\$/, '')}\\${p}`;
    else acc = `${acc}/${p}`;
    out.push({ label: p, path: acc });
  });
  void sep;
  return out;
}

async function browse(path) {
  loadingDir.value = true;
  listingError.value = '';
  try {
    listing.value = await api.listDir(path);
    if (listing.value.roots?.length) roots.value = listing.value.roots;
    separator.value = listing.value.separator || separator.value;
  } catch (err) {
    listingError.value = err.message;
  } finally {
    loadingDir.value = false;
  }
}

async function loadRoots() {
  try {
    const data = await api.roots();
    roots.value = data.roots || [];
    separator.value = data.separator || separator.value;
    const preferred = data.roots?.find((r) => /^d:/i.test(r.path)) || data.roots?.[0];
    if (preferred) await browse(preferred.path);
  } catch (err) {
    listingError.value = err.message;
  }
}

onMounted(loadRoots);

watch(mode, (m) => {
  if (m === 'browse' && !listing.value) loadRoots();
  if (m === 'scan' && !scanDir.value && listing.value?.dir) scanDir.value = listing.value.dir;
});

/* ---------- 选中 package.json ---------- */

async function choose(packageJsonPath) {
  manualError.value = '';
  try {
    const res = await api.analyze(packageJsonPath);
    packageInfo.value = res.packageInfo;
    const info = res.packageInfo;
    form.value = {
      name: info.name,
      runtime: info.recommendedScript ? 'npm' : (info.entry ? 'node' : 'npm'),
      script: info.recommendedScript || '',
      command: '',
      args: '',
      port: '',
      env: '',
      entryUrl: '',
      autoRestart: false,
      autoStart: false,
    };
    step.value = 'configure';
    if (res.managedBy) {
      toast(`注意：该 package.json 已由「${res.managedBy.name}」托管`, 'err', 6000);
    }
  } catch (err) {
    manualError.value = err.message;
    toast(err.message, 'err', 6000);
  }
}

/* ---------- 扫描 ---------- */

async function doScan() {
  if (!scanDir.value.trim()) {
    scanError.value = '请填写要扫描的目录';
    return;
  }
  scanning.value = true;
  scanError.value = '';
  try {
    const res = await api.scan(scanDir.value.trim(), scanDepth.value);
    scanResults.value = res.results || [];
    if (!scanResults.value.length) scanError.value = '该目录下（指定深度内）没有找到 package.json';
  } catch (err) {
    scanError.value = err.message;
  } finally {
    scanning.value = false;
  }
}

/* ---------- 提交 ---------- */

async function submit() {
  if (form.value.runtime === 'npm' && !form.value.script) {
    toast('请选择一个 npm script', 'err');
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      packageJsonPath: packageInfo.value.packageJsonPath,
      name: form.value.name,
      runtime: form.value.runtime,
      script: form.value.script,
      command: form.value.command,
      args: parseArgs(form.value.args),
      env: parseEnv(form.value.env),
      port: form.value.port === '' ? null : Number(form.value.port),
      entryUrl: form.value.entryUrl,
      autoRestart: form.value.autoRestart,
      autoStart: form.value.autoStart,
    };
    const res = await api.create(payload);
    toast(`已纳管 ${res.service.name}`, 'ok');
    await refresh();
    emit('created', res.service);
    emit('close');
  } catch (err) {
    toast(err.message, 'err', 7000);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="overlay modal-wrap" @click.self="emit('close')">
    <div class="modal">
      <header class="modal-head">
        <h2>{{ step === 'locate' ? '定位 package.json' : '配置托管服务' }}</h2>
        <div class="steps" style="margin-left: 10px">
          <span class="step" :class="step === 'locate' ? 'active' : 'done'">① 定位文件</span>
          <span class="sep">→</span>
          <span class="step" :class="step === 'configure' ? 'active' : ''">② 启动配置</span>
        </div>
        <span class="grow" style="flex: 1" />
        <button class="btn ghost icon" @click="emit('close')">✕</button>
      </header>

      <!-- 第一步：定位 -->
      <div v-if="step === 'locate'" class="modal-body">
        <div class="row" style="gap: 6px; margin-bottom: 14px">
          <button class="btn sm" :class="mode === 'browse' ? 'primary' : ''" @click="mode = 'browse'">浏览目录</button>
          <button class="btn sm" :class="mode === 'path' ? 'primary' : ''" @click="mode = 'path'">直接输入路径</button>
          <button class="btn sm" :class="mode === 'scan' ? 'primary' : ''" @click="mode = 'scan'">批量扫描</button>
        </div>

        <!-- 浏览 -->
        <div v-if="mode === 'browse'" class="browser">
          <div class="row" style="gap: 8px">
            <select
              class="select"
              style="width: 130px"
              :value="roots.find((r) => listing?.dir?.toUpperCase().startsWith(r.path.toUpperCase()))?.path || ''"
              @change="browse($event.target.value)"
            >
              <option v-for="r in roots" :key="r.path" :value="r.path">{{ r.label }}</option>
            </select>
            <button class="btn sm" :disabled="!listing?.parent" @click="browse(listing.parent)">↑ 上级</button>
            <button class="btn ghost sm" @click="browse(listing?.dir)">刷新</button>
            <span class="grow" style="flex: 1" />
            <span class="hint">{{ listing?.dirs?.length || 0 }} 个子目录</span>
          </div>

          <div class="crumbs">
            <template v-for="(c, i) in crumbs" :key="c.path">
              <span v-if="i" class="sep">›</span>
              <button @click="browse(c.path)">{{ c.label }}</button>
            </template>
          </div>

          <div v-if="listingError" class="banner err"><span>✕</span><span class="grow">{{ listingError }}</span></div>

          <div class="dirlist">
            <div
              v-for="p in (listing?.packages || [])"
              :key="p.path"
              class="dirrow hit"
              @click="choose(p.path)"
            >
              <span class="ico">✅</span>
              <div class="grow">
                <div style="font-weight: 600">
                  package.json — {{ p.name }} <span class="muted">{{ p.version }}</span>
                </div>
                <div class="hint ellipsis">
                  {{ p.scriptCount }} 个 script{{ p.recommendedScript ? `，推荐启动：${p.recommendedScript}` : '' }}
                  {{ p.hasNodeModules ? '· node_modules 已安装' : '· 未安装依赖' }}
                </div>
              </div>
              <span class="btn primary sm">选择此文件</span>
            </div>

            <div
              v-for="d in (listing?.dirs || [])"
              :key="d.path"
              class="dirrow"
              @click="browse(d.path)"
            >
              <span class="ico">📁</span>
              <span class="grow ellipsis">{{ d.name }}</span>
              <span class="muted">›</span>
            </div>

            <div v-if="loadingDir" class="dirrow"><span class="spin" /><span class="muted">读取中…</span></div>
            <div v-else-if="!(listing?.dirs?.length || listing?.packages?.length)" class="dirrow">
              <span class="muted">该目录下没有子目录，也没有 package.json</span>
            </div>
          </div>
          <div class="hint">
            单击目录进入下一级；当目录中存在 package.json 时，会以绿色高亮并可直接选择。
          </div>
        </div>

        <!-- 直接输入 -->
        <div v-else-if="mode === 'path'" class="field">
          <label>package.json 绝对路径</label>
          <input
            v-model="manualPath"
            class="input mono"
            placeholder="例如 D:\projects\my-service\package.json"
            @keyup.enter="choose(manualPath)"
          />
          <div class="hint">也支持直接粘贴所在目录（会自动补 /package.json）。</div>
          <div v-if="manualError" class="banner err"><span>✕</span><span class="grow">{{ manualError }}</span></div>
          <div class="row" style="margin-top: 6px">
            <button class="btn primary" @click="choose(manualPath)">解析该文件</button>
          </div>
        </div>

        <!-- 批量扫描 -->
        <div v-else class="field">
          <label>扫描目录</label>
          <div class="row">
            <input v-model="scanDir" class="input mono grow" placeholder="例如 D:\projects" />
            <select v-model.number="scanDepth" class="select" style="width: 134px">
              <option :value="1">深度 1 层</option>
              <option :value="2">深度 2 层</option>
              <option :value="3">深度 3 层</option>
              <option :value="4">深度 4 层</option>
            </select>
            <button class="btn primary" :disabled="scanning" @click="doScan">
              <span v-if="scanning" class="spin" /> 扫描
            </button>
          </div>
          <div class="hint">自动跳过 node_modules、.git、dist 等目录，用于批量发现可托管的 Node 服务。</div>
          <div v-if="scanError" class="banner warn" style="margin-top: 8px"><span>!</span><span class="grow">{{ scanError }}</span></div>

          <div v-if="scanResults.length" class="dirlist" style="margin-top: 10px; max-height: 300px">
            <div v-for="r in scanResults" :key="r.packageJsonPath" class="dirrow" @click="choose(r.packageJsonPath)">
              <span class="ico">{{ r.error ? '⚠' : '📦' }}</span>
              <div class="grow" style="min-width: 0">
                <div>
                  <b>{{ r.name }}</b> <span class="muted">{{ r.version }}</span>
                  <span v-if="r.alreadyManaged" class="tag amber" style="margin-left: 6px">已托管</span>
                </div>
                <div class="hint ellipsis mono">{{ r.packageJsonPath }}</div>
              </div>
              <span class="btn sm">纳管</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 第二步：配置 -->
      <div v-else class="modal-body">
        <div class="card" style="padding: 12px 14px; margin-bottom: 16px">
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <b>{{ packageInfo.name }}</b>
            <span class="tag">{{ packageInfo.version }}</span>
            <span class="tag blue">{{ packageInfo.packageManager }}</span>
            <span class="tag" :class="packageInfo.hasNodeModules ? 'green' : 'amber'">
              {{ packageInfo.hasNodeModules ? '依赖已安装' : '依赖未安装' }}
            </span>
          </div>
          <div class="hint mono ellipsis" style="margin-top: 5px">{{ packageInfo.packageJsonPath }}</div>
        </div>

        <div class="row" style="gap: 12px; align-items: flex-start; margin-bottom: 14px">
          <div class="field grow">
            <label>显示名称</label>
            <input v-model="form.name" class="input" />
          </div>
          <div class="field" style="width: 190px">
            <label>监听端口（可选）</label>
            <input v-model="form.port" class="input" placeholder="注入 PORT" />
          </div>
        </div>

        <div class="field" style="margin-bottom: 8px">
          <label>启动方式</label>
          <div class="row" style="gap: 6px; flex-wrap: wrap">
            <button class="btn sm" :class="form.runtime === 'npm' ? 'primary' : ''" @click="form.runtime = 'npm'">npm script</button>
            <button
              class="btn sm"
              :class="form.runtime === 'node' ? 'primary' : ''"
              :disabled="!packageInfo.entry"
              :title="packageInfo.entry ? '' : '未识别到入口文件'"
              @click="form.runtime = 'node'"
            >直接 node 启动</button>
            <button class="btn sm" :class="form.runtime === 'custom' ? 'primary' : ''" @click="form.runtime = 'custom'">自定义命令</button>
          </div>
        </div>

        <div v-if="form.runtime === 'npm'" class="field" style="margin-bottom: 14px">
          <label>选择 npm script（推荐项已标注）</label>
          <div style="display: flex; flex-direction: column; gap: 6px; max-height: 210px; overflow: auto">
            <div
              v-for="s in packageInfo.scripts"
              :key="s.name"
              class="script-option"
              :class="{ active: form.script === s.name }"
              @click="form.script = s.name"
            >
              <span>{{ form.script === s.name ? '◉' : '○' }}</span>
              <div class="grow" style="min-width: 0">
                <div><b>{{ s.name }}</b> <span v-if="s.recommended" class="tag green">推荐</span></div>
                <div class="cmd ellipsis">{{ s.command }}</div>
              </div>
            </div>
            <div v-if="!packageInfo.scripts.length" class="banner warn">
              <span>!</span><span class="grow">该 package.json 没有可用 script，请改用「直接 node 启动」。</span>
            </div>
          </div>
        </div>

        <div v-else-if="form.runtime === 'node'" class="card" style="padding: 10px 12px; margin-bottom: 14px">
          <div class="hint">将以 <span class="mono">node &lt;入口文件&gt;</span> 直接启动，根进程即服务进程，指标最准确。</div>
          <div class="mono" style="font-size: 12.5px; margin-top: 6px; word-break: break-all">{{ packageInfo.entry }}</div>
        </div>

        <div v-else class="field" style="margin-bottom: 14px">
          <label>自定义命令</label>
          <input v-model="form.command" class="input mono" placeholder="例如 pnpm exec tsx src/server.ts" />
        </div>

        <div class="field" style="margin-bottom: 14px">
          <label>附加参数（空格分隔）</label>
          <input v-model="form.args" class="input mono" placeholder="例如 --env production" />
        </div>

        <div class="field" style="margin-bottom: 14px">
          <label>浏览器入口地址（可选）</label>
          <input v-model="form.entryUrl" class="input mono" placeholder="留空则按运行后探测到的监听端口自动推导" />
          <span class="hint">纳管后卡片上会出现「浏览器打开」按钮，一键直达服务页面。</span>
        </div>

        <div class="field" style="margin-bottom: 14px">
          <label>环境变量（每行 KEY=VALUE）</label>
          <textarea v-model="form.env" class="textarea" rows="4" :placeholder="`NODE_ENV=production`" />
        </div>

        <div class="row" style="gap: 20px">
          <label class="row" style="gap: 7px; cursor: pointer">
            <input v-model="form.autoRestart" type="checkbox" /> 异常退出自动重启
          </label>
          <label class="row" style="gap: 7px; cursor: pointer">
            <input v-model="form.autoStart" type="checkbox" /> 纳管后立即启动
          </label>
        </div>
      </div>

      <footer class="modal-foot">
        <button v-if="step === 'configure'" class="btn" @click="step = 'locate'">← 重新定位</button>
        <span class="grow" style="flex: 1" />
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button v-if="step === 'configure'" class="btn primary" :disabled="submitting" @click="submit">
          <span v-if="submitting" class="spin" /> 纳管服务
        </button>
      </footer>
    </div>
  </div>
</template>

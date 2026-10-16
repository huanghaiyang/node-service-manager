<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  state, loadNodeProcesses, persistProcessPanel, toast,
} from '../store.js';
import { formatBytes, formatPercent, formatClock } from '../format.js';

const emit = defineEmits(['open-service', 'close']);

const panel = computed(() => state.processPanel);
const data = computed(() => panel.value.data);
const detailAvailable = computed(() => Boolean(data.value?.detailAvailable));
const keyword = ref('');
const onlyManaged = ref(false);

let timer = null;

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  if (!panel.value.open || !panel.value.autoRefresh) return;
  timer = setInterval(() => { loadNodeProcesses({ silent: true }); }, 5000);
}

onMounted(async () => {
  await loadNodeProcesses({ refresh: true });
  schedule();
});

onUnmounted(() => { if (timer) clearInterval(timer); });

function toggleAuto() {
  panel.value.autoRefresh = !panel.value.autoRefresh;
  persistProcessPanel();
  schedule();
}

async function refresh() {
  await loadNodeProcesses({ refresh: true });
  toast('已刷新进程列表', 'ok');
}

const filtered = computed(() => {
  const list = data.value?.processes || [];
  const kw = keyword.value.trim().toLowerCase();
  return list.filter((p) => {
    if (onlyManaged.value && !p.managed) return false;
    if (!kw) return true;
    return String(p.pid).includes(kw)
      || (p.commandLine || '').toLowerCase().includes(kw)
      || (p.serviceName || '').toLowerCase().includes(kw)
      || (p.ports || []).some((x) => String(x.port).includes(kw));
  });
});

const sourceLabel = computed(() => ({
  snapshot: '复用进程快照（完整枚举）',
  basic: 'Get-Process 降级枚举（无进程树/命令行）',
  none: '不可用',
}[data.value?.enumerateSource] || '—'));
</script>

<template>
  <aside class="process-panel">
    <header class="panel-head">
      <div class="grow" style="min-width: 0">
        <div class="row" style="gap: 8px">
          <b>Node 进程检测器</b>
          <span class="tag blue">{{ data?.total ?? 0 }} 个</span>
          <span v-if="data?.managedCount" class="tag green">{{ data.managedCount }} 已托管</span>
        </div>
        <div class="hint" style="margin-top: 3px">
          {{ sourceLabel }}
          <template v-if="data?.sampledAt"> · 采样于 {{ formatClock(data.sampledAt) }}</template>
        </div>
      </div>
      <button class="btn ghost icon" title="关闭" @click="emit('close')">✕</button>
    </header>

    <div class="panel-tools">
      <input v-model="keyword" class="input" style="flex: 1; min-width: 0" placeholder="搜索 PID / 端口 / 命令…" />
      <button class="btn sm" :class="onlyManaged ? 'primary' : ''" @click="onlyManaged = !onlyManaged">
        仅已托管
      </button>
    </div>
    <div class="panel-tools" style="padding-top: 0">
      <label class="row hint" style="gap: 6px; cursor: pointer">
        <input type="checkbox" :checked="panel.autoRefresh" @change="toggleAuto" /> 自动刷新（5s）
      </label>
      <span class="grow" style="flex: 1" />
      <button class="btn ghost sm" :disabled="panel.loading" @click="refresh">
        <span v-if="panel.loading" class="spin" /> 刷新
      </button>
    </div>

    <div v-if="panel.error" class="banner err" style="margin: 0 12px 8px">
      <span>✕</span><span class="grow">{{ panel.error }}</span>
    </div>

    <div v-if="!detailAvailable" class="banner info" style="margin: 0 12px 8px; font-size: 12px">
      <span>ℹ</span>
      <span class="grow">当前环境读不到命令行（Windows 需要可用的 WMI），只能显示进程、端口与占用。</span>
    </div>

    <div class="panel-body">
      <div v-if="panel.loading && !data" class="hint" style="padding: 20px; text-align: center">正在枚举…</div>

      <div v-else-if="!filtered.length" class="hint" style="padding: 24px; text-align: center">
        {{ (data?.total ?? 0) ? '没有匹配的进程' : '未发现 node 进程' }}
      </div>

      <div
        v-for="p in filtered"
        :key="p.pid"
        class="proc-row"
        :class="{ managed: p.managed }"
        @click="p.managed && emit('open-service', p.serviceId)"
      >
        <div class="proc-top">
          <span class="dot" :class="p.managed ? 'running' : 'stopped'" />
          <span class="mono pid">PID {{ p.pid }}</span>
          <span v-if="p.managed" class="tag green">{{ p.serviceName }}</span>
          <span v-else class="tag">未托管</span>
          <span v-if="p.managed && p.matchedBy === 'commandline'" class="tag amber" title="按命令行/工作目录匹配到托管服务">
            间接匹配
          </span>
          <span class="grow" style="flex: 1" />
          <span class="hint">{{ formatPercent(p.cpuPercent, 2) }}</span>
        </div>

        <div class="proc-meta">
          <span>{{ formatBytes(p.memoryBytes) }}</span>
          <span class="muted">父进程 {{ p.ppid || '—' }}</span>
          <template v-for="x in (p.ports || [])" :key="`${x.proto}-${x.port}`">
            <span class="tag blue" :title="`${x.address}:${x.port}（${x.proto.toUpperCase()}）`">
              :{{ x.port }}
            </span>
          </template>
        </div>

        <div v-if="p.commandLine" class="proc-cmd mono" :title="p.commandLine">{{ p.commandLine }}</div>
        <div v-else class="proc-cmd muted">（命令行不可用）</div>
      </div>
    </div>
  </aside>
</template>

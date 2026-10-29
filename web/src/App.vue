<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ServiceCard from './components/ServiceCard.vue';
import ServiceDetail from './components/ServiceDetail.vue';
import AddServiceModal from './components/AddServiceModal.vue';
import ProcessPanel from './components/ProcessPanel.vue';
import ActivityPanel from './components/ActivityPanel.vue';
import PortConflictModal from './components/PortConflictModal.vue';
import BatchConflictModal from './components/BatchConflictModal.vue';
import SettingsModal from './components/SettingsModal.vue';
import {
  state, runningCount, totals, connect, disconnect, refresh, actions, toast,
  initProcessPanel, persistProcessPanel, loadNodeProcesses,
  initActivityPanel, loadActivity,
} from './store.js';
import { api } from './api.js';
import { formatBytes, formatPercent } from './format.js';

const showAdd = ref(false);
const showSettings = ref(false);
const detailId = ref(null);
const keyword = ref('');
const busy = ref(false);
const hostWarningOpen = ref(false);

const detailService = computed(() => state.services.find((s) => s.id === detailId.value) || null);
const detailLogs = computed(() => (detailId.value ? state.logs[detailId.value] || [] : []));
const panelOpen = computed(() => state.processPanel.open);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return state.services;
  return state.services.filter((s) => (
    s.name.toLowerCase().includes(kw)
    || s.packageJsonPath.toLowerCase().includes(kw)
    || String(s.port || '').includes(kw)
  ));
});

const host = computed(() => state.host || {});

/** 底部活动面板占据的高度：展开时按用户拖拽的高度，收起时只留一条标题栏 */
const activityPad = computed(() => (state.activityPanel.open ? state.activityPanel.height : 40));

onMounted(() => {
  initProcessPanel();
  initActivityPanel();
  connect();
  refresh();
  loadActivity();
  if (state.processPanel.open) loadNodeProcesses({ refresh: true });
});
onUnmounted(disconnect);

function togglePanel() {
  state.processPanel.open = !state.processPanel.open;
  persistProcessPanel();
  if (state.processPanel.open && !state.processPanel.data) loadNodeProcesses({ refresh: true });
}

async function guard(fn) {
  busy.value = true;
  try { await fn(); } finally { busy.value = false; }
}

async function refreshAll() {
  await guard(async () => {
    // 手动刷新时顺带对账一次「被外部启动/外部停止」的服务
    const scan = await api.scanExternal().catch(() => null);
    await refresh();
    toast(scan?.changed ? `已刷新（发现 ${scan.changed} 个外部运行的服务）` : '已刷新', 'ok');
  });
}

/**
 * 从「批量启动冲突」里挑一个服务就地换端口：
 * 复用单服务的冲突弹窗，用户选好端口后直接启动它。
 */
function openPortConflictFromBatch({ serviceId, conflict }) {
  const svc = state.services.find((s) => s.id === serviceId);
  if (!svc) return;
  state.portConflict = {
    service: svc,
    info: {
      checked: true,
      occupied: true,
      port: conflict.port,
      occupants: conflict.occupants || [],
      suggestion: conflict.suggestion || null,
    },
  };
  state.batchConflicts = [];
}

function openDetail(svc) {
  detailId.value = svc.id;
}

function openServiceById(id) {
  if (id && state.services.some((s) => s.id === id)) detailId.value = id;
}

async function afterCreated(svc) {
  if (svc) detailId.value = svc.id;
}
</script>

<template>
  <div class="app" :style="{ paddingBottom: `${activityPad}px` }">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="brand">
        <span class="logo">⚙</span>
        <div>
          Node 服务治理工具
          <small>package.json 定位 · 启停托管 · 状态监听 · CPU/内存采集</small>
        </div>
      </div>

      <div class="host-stats">
        <div class="host-stat" style="min-width: 110px">
          <span class="k">CPU（整机）</span>
          <span class="v">{{ host.cpuUsagePercent != null ? formatPercent(host.cpuUsagePercent, 1) : '—' }}</span>
          <span class="bar"><i
            :style="{ width: `${Math.min(100, host.cpuUsagePercent || 0)}%`, background: 'var(--accent)' }"
          /></span>
        </div>
        <div class="host-stat" style="min-width: 130px">
          <span class="k">内存 {{ formatBytes(host.usedMemory) }} / {{ formatBytes(host.totalMemory) }}</span>
          <span class="v">{{ formatPercent(host.memoryUsagePercent || 0, 1) }}</span>
          <span class="bar"><i
            :style="{ width: `${Math.min(100, host.memoryUsagePercent || 0)}%`, background: 'var(--purple)' }"
          /></span>
        </div>
        <div class="host-stat">
          <span class="k">托管服务</span>
          <span class="v">{{ runningCount }} / {{ state.services.length }} 运行中</span>
        </div>
        <div class="host-stat">
          <span class="k">采集占用</span>
          <span class="v">{{ formatPercent(totals.cpu, 1) }} · {{ formatBytes(totals.mem) }}</span>
        </div>
        <div class="host-stat" style="min-width: 0; position: relative">
          <span class="k">连接</span>
          <span class="v row" style="gap: 6px">
            <span class="dot" :class="state.connected ? 'running' : 'crashed'" />
            {{ state.connected ? '实时' : '已断开' }}
            <button
              v-if="host.metricsWarning"
              class="btn ghost icon sm"
              title="指标采集说明"
              @click="hostWarningOpen = !hostWarningOpen"
            >ⓘ</button>
          </span>
          <div
            v-if="hostWarningOpen && host.metricsWarning"
            class="card"
            style="position: absolute; right: 0; top: 46px; width: 330px; padding: 11px 13px; z-index: 30; font-size: 12.5px; line-height: 1.6"
          >
            <b>指标采集</b>
            <div class="hint" style="margin-top: 4px">{{ host.metricsProviderLabel }}</div>
            <div style="margin-top: 7px; color: var(--amber)">{{ host.metricsWarning }}</div>
          </div>
        </div>
      </div>
    </header>

    <div class="app-body">
      <main class="content">
      <div v-if="state.bootError" class="banner err" style="margin-bottom: 14px">
        <span>✕</span>
        <span class="grow">无法连接治理服务端：{{ state.bootError }}（请确认后端已启动）</span>
      </div>

      <div class="toolbar">
        <button class="btn primary" @click="showAdd = true">＋ 添加服务</button>
        <button class="btn" :disabled="busy || !state.services.length" @click="guard(actions.startAll)">全部启动</button>
        <button class="btn" :disabled="busy || !state.services.length" @click="guard(actions.stopAll)">全部停止</button>
        <button class="btn ghost" :disabled="busy" @click="refreshAll">刷新</button>
        <button
          class="btn"
          :class="panelOpen ? 'primary' : ''"
          title="检测本机所有 node 进程，并标出属于已托管服务的那些"
          @click="togglePanel"
        >
          🖥 进程检测器
          <span class="tag blue">{{ state.nodeSummary.total }}</span>
          <span v-if="state.nodeSummary.managed" class="tag green">{{ state.nodeSummary.managed }} 已托管</span>
        </button>
        <button
          class="btn ghost"
          title="开机自启动 / 启动时恢复服务"
          @click="showSettings = true"
        >⚙ 设置</button>
        <input v-model="keyword" class="input" style="width: 210px" placeholder="搜索名称 / 路径 / 端口…" />
        <span class="spacer" />
        <span class="hint">
          {{ state.services.length }} 个服务 · {{ totals.procs }} 个进程 ·
          采样器 {{ host.metricsProviderLabel || '—' }}
        </span>
      </div>

      <div v-if="state.loading" class="empty">正在加载…</div>

      <div v-else-if="!state.services.length" class="empty">
        <h2>还没有托管任何服务</h2>
        <p>点击「添加服务」，通过目录浏览或直接粘贴路径定位到目标项目的 <span class="mono">package.json</span>，<br />
          解析后即可托管其启动与停止，并实时查看运行状态与 CPU / 内存占用。</p>
        <button class="btn primary" style="margin-top: 14px" @click="showAdd = true">＋ 立即添加</button>
      </div>

      <div v-else-if="!filtered.length" class="empty">
        <h2>没有匹配的服务</h2>
        <p>试试其它关键字，或点击「刷新」。</p>
      </div>

      <div v-else class="grid">
        <ServiceCard
          v-for="svc in filtered"
          :key="svc.id"
          :service="svc"
          :busy="busy"
          @open="openDetail"
        />
      </div>
      </main>

      <ProcessPanel
        v-if="panelOpen"
        @close="togglePanel"
        @open-service="openServiceById"
      />
    </div>

    <ServiceDetail
      v-if="detailService"
      :service="detailService"
      :logs="detailLogs"
      @close="detailId = null"
    />

    <AddServiceModal v-if="showAdd" @close="showAdd = false" @created="afterCreated" />

    <SettingsModal v-if="showSettings" @close="showSettings = false" />

    <PortConflictModal
      v-if="state.portConflict"
      :context="state.portConflict"
      @close="state.portConflict = null"
    />

    <BatchConflictModal
      v-if="state.batchConflicts?.length"
      @close="state.batchConflicts = []"
      @fix="openPortConflictFromBatch"
    />

    <ActivityPanel />

    <div class="toast-host">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.message }}</div>
    </div>
  </div>
</template>

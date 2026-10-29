<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  state, loadActivity, clearActivity, persistActivityPanel, toast,
} from '../store.js';
import { formatTimeOnly, highlightParts } from '../format.js';

/**
 * 页面底部的「活动实时输出」面板。
 *
 * 数据来源有两条：
 *  1. 打开页面时用 GET /api/activity 回填一次近期日志；
 *  2. 之后靠 SSE 的 `log` 事件实时追加（在 store.js 里统一汇聚）。
 * 因此这里只负责展示与筛选，不直接访问接口（重新载入除外）。
 */

const viewport = ref(null);
const autoScroll = ref(true);
const streamFilter = ref('all');
const serviceFilter = ref('all');
const keyword = ref('');
const resizing = ref(false);

const panel = computed(() => state.activityPanel);
const lines = computed(() => state.activity);

const streamOptions = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '系统' },
  { key: 'stdout', label: '输出' },
  { key: 'stderr', label: '错误' },
];

const STREAM_LABELS = { system: '系统', stdout: '输出', stderr: '错误' };

const counts = computed(() => {
  const c = { all: lines.value.length, system: 0, stdout: 0, stderr: 0 };
  for (const line of lines.value) {
    if (c[line.stream] != null) c[line.stream] += 1;
  }
  return c;
});

const serviceOptions = computed(() => {
  const ids = new Set();
  for (const line of lines.value) if (line.serviceId) ids.add(line.serviceId);
  for (const svc of state.services) ids.add(svc.id);
  return [...ids]
    .map((id) => ({ id, name: serviceName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
});

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return lines.value.filter((line) => {
    if (streamFilter.value !== 'all' && line.stream !== streamFilter.value) return false;
    if (serviceFilter.value !== 'all' && line.serviceId !== serviceFilter.value) return false;
    if (kw && !String(line.text).toLowerCase().includes(kw)) return false;
    return true;
  });
});

const lastLine = computed(() => lines.value[lines.value.length - 1] || null);

const dockStyle = computed(() => (panel.value.open ? { height: `${panel.value.height}px` } : {}));

function serviceName(id) {
  if (!id) return '管理端';
  return state.services.find((svc) => svc.id === id)?.name || id;
}

function streamLabel(stream) {
  return STREAM_LABELS[stream] || stream;
}

function latestPreview() {
  const line = lastLine.value;
  if (!line) return '';
  return `${formatTimeOnly(line.ts)} · ${serviceName(line.serviceId)} · ${line.text}`;
}

function scrollToBottom() {
  const el = viewport.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll() {
  const el = viewport.value;
  if (!el) return;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(
  () => [filtered.value.length, panel.value.open, streamFilter.value, serviceFilter.value, keyword.value],
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    scrollToBottom();
  },
);

function toggle() {
  panel.value.open = !panel.value.open;
  if (panel.value.open) {
    state.activityUnread = 0;
    if (!lines.value.length) loadActivity();
    nextTick(scrollToBottom);
  }
  persistActivityPanel();
}

function togglePause() {
  panel.value.paused = !panel.value.paused;
  // 暂停期间新行不入缓冲，恢复时用服务端快照把缺口补上
  if (!panel.value.paused) loadActivity();
}

async function reload() {
  await loadActivity();
  toast('已载入最近活动输出', 'ok');
}

function doClear() {
  clearActivity();
  toast('已清空活动面板（不影响各服务的日志文件）', 'ok');
}

async function doCopy() {
  const text = filtered.value
    .map((line) => `[${formatTimeOnly(line.ts)}] [${serviceName(line.serviceId)}] [${streamLabel(line.stream)}] ${line.text}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${filtered.value.length} 行`, 'ok');
  } catch {
    toast('浏览器拒绝了剪贴板访问', 'err');
  }
}

/* ------------------------------ 拖拽调整高度 ------------------------------ */

let drag = null;

function maxHeight() {
  return Math.max(160, window.innerHeight - 140);
}

/** 窗口变小时把面板压回可视范围，避免盖住整页内容 */
function onWindowResize() {
  if (!panel.value.open || panel.value.height <= maxHeight()) return;
  panel.value.height = maxHeight();
  persistActivityPanel();
}

function startResize(event) {
  if (!panel.value.open) return;
  drag = { y: event.clientY, height: panel.value.height };
  resizing.value = true;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'ns-resize';
  window.addEventListener('pointermove', onResize);
  window.addEventListener('pointerup', stopResize);
  event.preventDefault();
}

function onResize(event) {
  if (!drag) return;
  const next = Math.round(drag.height + drag.y - event.clientY);
  panel.value.height = Math.min(maxHeight(), Math.max(160, next));
}

function stopResize() {
  drag = null;
  resizing.value = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  window.removeEventListener('pointermove', onResize);
  window.removeEventListener('pointerup', stopResize);
  persistActivityPanel();
}

onMounted(() => {
  if (panel.value.height > maxHeight()) panel.value.height = maxHeight();
  window.addEventListener('resize', onWindowResize);
  nextTick(scrollToBottom);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('pointermove', onResize);
  window.removeEventListener('pointerup', stopResize);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});
</script>

<template>
  <section class="activity-dock" :style="dockStyle">
    <div
      v-if="panel.open"
      class="activity-resizer"
      :class="{ active: resizing }"
      title="拖拽调整面板高度"
      @pointerdown="startResize"
    />

    <header class="activity-bar" @click="toggle">
      <span class="chev">{{ panel.open ? '▾' : '▴' }}</span>
      <b>活动实时输出</b>
      <span class="live" :class="{ paused: panel.paused, off: !state.connected }">
        <span class="dot" :class="panel.paused ? 'stopped' : state.connected ? 'running' : 'crashed'" />
        {{ panel.paused ? '已暂停' : state.connected ? 'LIVE' : '未连接' }}
      </span>
      <span class="tag blue">{{ lines.length }} 行</span>
      <span v-if="counts.stderr" class="tag red">{{ counts.stderr }} 错误</span>
      <span v-if="!panel.open && state.activityUnread" class="tag amber">+{{ state.activityUnread }} 新</span>
      <span v-if="!panel.open && lastLine" class="activity-preview ellipsis">{{ latestPreview() }}</span>
      <span class="grow" />
      <button
        class="btn ghost sm"
        :title="panel.open ? '收起面板' : '展开面板'"
        @click.stop="toggle"
      >{{ panel.open ? '收起' : '展开' }}</button>
    </header>

    <div v-if="panel.open" class="activity-main">
      <div class="activity-tools">
        <button
          v-for="opt in streamOptions"
          :key="opt.key"
          class="btn sm"
          :class="streamFilter === opt.key ? 'primary' : 'ghost'"
          @click="streamFilter = opt.key"
        >
          {{ opt.label }}
          <span class="muted">{{ counts[opt.key] ?? 0 }}</span>
        </button>
        <input v-model="keyword" class="input" style="width: 190px" placeholder="搜索活动输出…" />
        <select v-model="serviceFilter" class="select" style="width: 170px">
          <option value="all">全部来源</option>
          <option v-for="svc in serviceOptions" :key="svc.id" :value="svc.id">{{ svc.name }}</option>
        </select>
        <span class="grow" />
        <label class="row hint" style="gap: 5px; cursor: pointer">
          <input v-model="autoScroll" type="checkbox" /> 自动滚动
        </label>
        <button class="btn ghost sm" @click="scrollToBottom">到底部</button>
        <button class="btn ghost sm" @click="doCopy">复制</button>
        <button class="btn ghost sm" @click="reload">重新载入</button>
        <button class="btn ghost sm" @click="togglePause">{{ panel.paused ? '继续' : '暂停' }}</button>
        <button class="btn danger sm" @click="doClear">清空</button>
      </div>

      <div ref="viewport" class="activity-view" @scroll="onScroll">
        <div v-if="!filtered.length" class="activity-empty">
          {{ lines.length
            ? '当前筛选条件下没有活动输出'
            : '暂无活动输出 —— 启动任意服务后，启停事件与运行日志会实时汇总到这里' }}
        </div>
        <div
          v-for="(line, i) in filtered"
          :key="`${line.key}#${i}`"
          class="log-line"
          :class="line.stream"
        >
          <span class="ts">{{ formatTimeOnly(line.ts) }}</span>
          <span class="svc ellipsis" :title="serviceName(line.serviceId)">{{ serviceName(line.serviceId) }}</span>
          <span class="stream">{{ streamLabel(line.stream) }}</span>
          <span class="text">
            <template v-for="(part, j) in highlightParts(line.text, keyword)" :key="j">
              <mark v-if="part.hit">{{ part.t }}</mark>
              <template v-else>{{ part.t }}</template>
            </template>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

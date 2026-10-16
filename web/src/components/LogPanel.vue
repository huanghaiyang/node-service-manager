<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { api } from '../api.js';
import { clearLogs, loadLogs, toast } from '../store.js';
import { formatTimeOnly } from '../format.js';

const props = defineProps({
  serviceId: { type: String, required: true },
  lines: { type: Array, default: () => [] },
  logPaths: { type: Object, default: () => ({}) },
});

const viewport = ref(null);
const autoScroll = ref(true);
const streamFilter = ref('all');
const keyword = ref('');

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return props.lines.filter((l) => {
    if (streamFilter.value !== 'all' && l.stream !== streamFilter.value) return false;
    if (kw && !String(l.text).toLowerCase().includes(kw)) return false;
    return true;
  });
});

const counts = computed(() => {
  const c = { all: props.lines.length, stdout: 0, stderr: 0, system: 0 };
  for (const l of props.lines) c[l.stream] = (c[l.stream] || 0) + 1;
  return c;
});

function scrollToBottom() {
  const el = viewport.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => [props.lines.length, streamFilter.value],
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    scrollToBottom();
  },
);

watch(autoScroll, (on) => { if (on) scrollToBottom(); });

function onScroll() {
  const el = viewport.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  autoScroll.value = atBottom;
}

function highlight(text) {
  const raw = String(text ?? '');
  const kw = keyword.value.trim();
  // 无关键字时也必须返回同样形状的片段对象，否则模板取不到 .t 会渲染成空白
  if (!kw) return [{ t: raw, hit: false }];
  const parts = [];
  const lower = raw.toLowerCase();
  const target = kw.toLowerCase();
  let i = 0;
  let idx = lower.indexOf(target, i);
  while (idx !== -1) {
    if (idx > i) parts.push({ t: raw.slice(i, idx), hit: false });
    parts.push({ t: raw.slice(idx, idx + kw.length), hit: true });
    i = idx + kw.length;
    idx = lower.indexOf(target, i);
  }
  if (i < raw.length) parts.push({ t: raw.slice(i), hit: false });
  return parts;
}

async function doClear() {
  try {
    await api.clearLogs(props.serviceId);
    clearLogs(props.serviceId);
    toast('日志已清空', 'ok');
  } catch (err) {
    toast(`清空失败：${err.message}`, 'err');
  }
}

async function doReload() {
  await loadLogs(props.serviceId, 800);
  toast('已重新载入磁盘日志', 'ok');
}

async function doCopy() {
  const text = filtered.value.map((l) => `[${l.stream}] ${l.text}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${filtered.value.length} 行`, 'ok');
  } catch {
    toast('浏览器拒绝了剪贴板访问', 'err');
  }
}
</script>

<template>
  <div class="logs">
    <div class="logs-toolbar">
      <div class="row" style="gap: 4px">
        <button
          v-for="opt in [{ k: 'all', t: '全部' }, { k: 'stdout', t: 'stdout' }, { k: 'stderr', t: 'stderr' }, { k: 'system', t: '系统' }]"
          :key="opt.k"
          class="btn sm"
          :class="streamFilter === opt.k ? 'primary' : 'ghost'"
          @click="streamFilter = opt.k"
        >
          {{ opt.t }}
          <span class="muted">{{ counts[opt.k] ?? 0 }}</span>
        </button>
      </div>
      <input v-model="keyword" class="input" style="width: 190px" placeholder="搜索日志…" />
      <span class="spacer" style="flex: 1" />
      <label class="row hint" style="gap: 5px; cursor: pointer">
        <input v-model="autoScroll" type="checkbox" /> 自动滚动
      </label>
      <button class="btn ghost sm" @click="scrollToBottom">到底部</button>
      <button class="btn ghost sm" @click="doReload">重新载入</button>
      <button class="btn ghost sm" @click="doCopy">复制</button>
      <button class="btn danger sm" @click="doClear">清空</button>
    </div>

    <div ref="viewport" class="log-view" @scroll="onScroll">
      <div v-if="!filtered.length" class="muted" style="padding: 22px; text-align: center">
        {{ lines.length ? '当前筛选条件下没有日志' : '暂无日志输出' }}
      </div>
      <div
        v-for="(line, i) in filtered"
        :key="i"
        class="log-line"
        :class="line.stream"
      >
        <span class="ts">{{ formatTimeOnly(line.ts) }}</span>
        <span class="stream">{{ line.stream }}</span>
        <span class="text">
          <template v-for="(part, j) in highlight(String(line.text))" :key="j">
            <mark v-if="part.hit">{{ part.t }}</mark>
            <template v-else>{{ part.t }}</template>
          </template>
        </span>
      </div>
    </div>

    <div class="hint row" style="gap: 14px; flex-wrap: wrap">
      <span>共 {{ lines.length }} 行（内存缓冲上限 800 行）</span>
      <span v-if="logPaths.outPath" class="ellipsis" :title="logPaths.outPath">
        stdout → <span class="mono">{{ logPaths.outPath }}</span>
      </span>
    </div>
  </div>
</template>

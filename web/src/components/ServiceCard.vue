<script setup>
import { computed } from 'vue';
import Sparkline from './Sparkline.vue';
import { actions, openPortConflictForHint } from '../store.js';
import {
  formatBytes, formatPercent, formatUptime, shortenPath, STATUS_META, ENTRY_SOURCE_META,
} from '../format.js';

const props = defineProps({
  service: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['open']);

const st = computed(() => props.service.state || {});
const status = computed(() => st.value.status || 'stopped');
const meta = computed(() => STATUS_META[status.value] || { label: status.value, color: '' });
const isRunning = computed(() => ['running', 'starting'].includes(status.value));
const isBusy = computed(() => ['starting', 'stopping'].includes(status.value));
const isOrphan = computed(() => status.value === 'orphaned');

const cpuHistory = computed(() => props.service.history?.cpu || []);
const memHistory = computed(() => props.service.history?.memory || []);

const cpuMax = computed(() => {
  const peak = Math.max(4, ...cpuHistory.value);
  return Math.min(100, Math.ceil(peak / 10) * 10);
});

const memMax = computed(() => {
  const peak = Math.max(...memHistory.value, 1);
  return peak * 1.15;
});

const metrics = computed(() => props.service.metrics || null);
// 实时探测到的监听端口（服务没起来时为空数组）
const ports = computed(() => props.service.ports || []);
const entry = computed(() => props.service.entry || { url: '', source: 'none', live: false });
const entryMeta = computed(() => ENTRY_SOURCE_META[entry.value.source] || ENTRY_SOURCE_META.none);
const hasEntry = computed(() => Boolean(entry.value.url));
</script>

<template>
  <article class="card svc" :class="status">
    <header class="svc-head">
      <span class="dot" :class="status" />
      <div class="grow" style="min-width: 0">
        <div class="svc-title">
          <h3 class="ellipsis">{{ service.name }}</h3>
          <span v-if="service.version" class="tag">{{ service.version }}</span>
          <span class="tag" :class="meta.color">{{ meta.label }}</span>
          <span v-if="st.adopted" class="tag amber" title="该进程由外部启动，已被本工具接管">已接管</span>
          <span v-if="st.restarts" class="tag amber">重启 {{ st.restarts }}</span>
        </div>
        <div class="svc-path ellipsis mono" :title="service.packageJsonPath">
          {{ shortenPath(service.packageJsonPath, 58) }}
        </div>
      </div>
    </header>

    <div class="kv">
      <div class="item">
        <span class="k">PID</span>
        <span class="v mono">{{ st.pid || '—' }}</span>
      </div>
      <div class="item">
        <span class="k">运行时长</span>
        <span class="v">{{ isRunning ? formatUptime(st.uptimeMs) : '—' }}</span>
      </div>
      <div class="item">
        <span class="k">启动方式</span>
        <span class="v" style="font-size: 12.5px">{{ st.plan?.mode || service.runtime }}</span>
      </div>
      <div class="item">
        <span class="k">进程数</span>
        <span class="v">{{ metrics?.processCount ?? '—' }}</span>
      </div>
    </div>

    <div class="metric-line">
      <div class="top">
        <span class="muted">CPU 占用（占整机）</span>
        <b>{{ metrics ? formatPercent(metrics.cpuPercent, 2) : '—' }}</b>
      </div>
      <div class="spark">
        <Sparkline :values="cpuHistory" color="#4f9cf9" :max="cpuMax" />
      </div>
    </div>

    <div class="metric-line">
      <div class="top">
        <span class="muted">内存占用（工作集）</span>
        <b>{{ metrics ? formatBytes(metrics.memoryBytes) : '—' }}</b>
      </div>
      <div class="spark">
        <Sparkline :values="memHistory" color="#a97bf5" :max="memMax" />
      </div>
    </div>

    <div class="entry-block">
      <div class="entry-ports">
        <span class="k">监听端口</span>
        <template v-if="ports.length">
          <span
            v-for="p in ports"
            :key="`${p.proto}-${p.port}-${p.address}`"
            class="tag"
            :class="p.proto === 'tcp' ? 'blue' : 'purple'"
            :title="`${p.address}:${p.port}（${p.proto.toUpperCase()}）`"
          >{{ p.proto === 'udp' ? 'UDP' : '' }}{{ p.port }}</span>
        </template>
        <span v-else-if="service.port" class="tag amber" title="配置里声明的端口，当前未监听到">
          声明 :{{ service.port }}（未监听）
        </span>
        <span v-else class="hint">—</span>
      </div>

      <div class="entry-open">
        <a
          v-if="hasEntry"
          class="btn primary sm"
          :href="entry.url"
          target="_blank"
          rel="noopener noreferrer"
          :title="`在浏览器中打开 ${entry.url}`"
        >浏览器打开 ↗</a>
        <span v-else class="hint">未识别入口</span>
        <span v-if="hasEntry" class="tag" :class="entryMeta.color">{{ entryMeta.label }}</span>
      </div>
      <div v-if="hasEntry" class="entry-url ellipsis mono" :title="entry.url">{{ entry.url }}</div>
    </div>

    <!-- 崩溃诊断：后端从日志里认出 EADDRINUSE，并查明了占用者，直接给一键换端口 -->
    <div v-if="service.portConflictHint" class="banner err">
      <span>⚠</span>
      <span class="grow">
        {{ service.portConflictHint.message }}
        <template v-if="service.portConflictHint.occupants?.[0]?.managedServiceName === service.name">
          —— 疑似该服务上一次的残留进程
        </template>
      </span>
      <button class="btn danger sm" :disabled="busy" @click="openPortConflictForHint(service)">换端口启动</button>
    </div>
    <div v-else-if="isOrphan" class="banner warn">
      <span>⚠</span>
      <span class="grow">
        该服务正被<b>外部运行</b>（不是本工具启动的）。
        <template v-if="st.external">
          PID <span class="mono">{{ st.external.pid }}</span> · 依据：{{ st.external.detail }}
          <span v-if="st.external.confidence === 'medium'" class="muted">（推断）</span>
        </template>
      </span>
    </div>
    <div v-else-if="st.externalHint" class="banner warn">
      <span>?</span>
      <span class="grow">
        {{ st.externalHint.detail }}（PID <span class="mono">{{ st.externalHint.pid }}</span>），
        但无法确认就是该服务 —— 若确认，可接管它。
      </span>
      <button class="btn sm" :disabled="busy" title="把该 PID 纳入托管，指标/端口/停止随即生效" @click="actions.adopt(service)">接管</button>
    </div>
    <div v-else-if="st.lastError" class="banner warn">
      <span>⚠</span><span class="grow">{{ st.lastError }}</span>
    </div>

    <div v-if="metrics?.scope === 'process' && isRunning" class="banner info" style="font-size: 12px">
      <span>ℹ</span>
      <span class="grow">当前平台未能读取进程父子关系，指标仅覆盖主进程。使用「直接 node 启动」可获得最准确的数据。</span>
    </div>

    <footer class="svc-actions">
      <template v-if="isOrphan">
        <button class="btn primary sm" :disabled="busy" title="纳入托管：指标/端口/停止随即生效" @click="actions.adopt(service)">接管</button>
        <button class="btn danger sm" :disabled="busy" @click="actions.killOrphan(service)">终止</button>
      </template>
      <template v-else-if="isRunning">
        <button class="btn danger sm" :disabled="busy || isBusy" @click="actions.stop(service)">停止</button>
        <button class="btn sm" :disabled="busy || isBusy" @click="actions.restart(service)">重启</button>
      </template>
      <template v-else>
        <button class="btn success sm" :disabled="busy" @click="actions.start(service)">启动</button>
      </template>
      <span class="spacer" />
      <button class="btn ghost sm" @click="emit('open', service)">详情 / 日志</button>
      <button
        class="btn ghost sm"
        :disabled="busy"
        title="移除托管（会同时终止进程）"
        @click="actions.remove(service)"
      >移除</button>
    </footer>
  </article>
</template>

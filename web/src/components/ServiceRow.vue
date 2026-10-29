<script setup>
import { computed } from 'vue';
import { actions } from '../store.js';
import {
  formatBytes, formatPercent, formatUptime, shortenPath, STATUS_META,
} from '../format.js';

/**
 * 托管服务的紧凑列表行。
 * 与卡片视图共用同一份服务数据，但只保留最关键的列，
 * 便于服务数量多时在一屏内快速浏览与操作。
 */
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

const metrics = computed(() => props.service.metrics || null);
const ports = computed(() => props.service.ports || []);
</script>

<template>
  <div class="svc-row" :class="status">
    <span class="dot" :class="status" :title="meta.label" />

    <div class="svc-row-name">
      <span class="name ellipsis" :title="service.name">{{ service.name }}</span>
      <span v-if="service.version" class="tag">{{ service.version }}</span>
      <span class="tag" :class="meta.color">{{ meta.label }}</span>
      <span v-if="service.portConflictHint" class="tag red" :title="service.portConflictHint.message">端口冲突</span>
      <span v-else-if="st.adopted" class="tag amber" title="该进程由外部启动，已被本工具接管">已接管</span>
      <span v-else-if="st.restarts" class="tag amber">重启 {{ st.restarts }}</span>
    </div>

    <span class="svc-row-path ellipsis mono" :title="service.packageJsonPath">
      {{ shortenPath(service.packageJsonPath, 46) }}
    </span>

    <span class="num mono">{{ st.pid || '—' }}</span>
    <span class="num">{{ isRunning ? formatUptime(st.uptimeMs) : '—' }}</span>
    <span class="num mono" title="CPU 占用（占整机）">{{ metrics ? formatPercent(metrics.cpuPercent, 1) : '—' }}</span>
    <span class="num mono" title="内存占用（工作集）">{{ metrics ? formatBytes(metrics.memoryBytes) : '—' }}</span>

    <div class="svc-row-ports">
      <template v-if="ports.length">
        <span
          v-for="p in ports.slice(0, 3)"
          :key="`${p.proto}-${p.port}-${p.address}`"
          class="tag"
          :class="p.proto === 'tcp' ? 'blue' : 'purple'"
          :title="`${p.address}:${p.port}（${p.proto.toUpperCase()}）`"
        >{{ p.proto === 'udp' ? 'UDP' : '' }}{{ p.port }}</span>
        <span v-if="ports.length > 3" class="tag" :title="`共 ${ports.length} 个监听端口`">+{{ ports.length - 3 }}</span>
      </template>
      <span v-else-if="service.port" class="tag amber" title="配置里声明的端口，当前未监听到">:{{ service.port }}</span>
      <span v-else class="hint">—</span>
    </div>

    <div class="svc-row-actions">
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
      <button class="btn ghost sm" @click="emit('open', service)">详情</button>
      <button class="btn ghost sm" :disabled="busy" title="移除托管（会同时终止进程）" @click="actions.remove(service)">移除</button>
    </div>
  </div>
</template>

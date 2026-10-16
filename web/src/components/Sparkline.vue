<script setup>
import { computed } from 'vue';

const props = defineProps({
  values: { type: Array, default: () => [] },
  color: { type: String, default: '#4f9cf9' },
  /** 固定上限；不传则按数据自适应 */
  max: { type: Number, default: null },
  /** viewBox 宽度，仅影响坐标精度 */
  width: { type: Number, default: 200 },
});

const VB_W = computed(() => props.width);
const VB_H = 100;

const geometry = computed(() => {
  const raw = (props.values || []).map((n) => (Number.isFinite(n) ? n : 0));
  if (!raw.length) return { line: '', area: '', dot: null, empty: true };
  const peak = props.max ?? Math.max(...raw, 0.000001);
  const scale = peak > 0 ? peak * (props.max ? 1 : 1.12) : 1;
  const n = raw.length;
  const step = n > 1 ? VB_W.value / (n - 1) : 0;
  const pts = raw.map((v, i) => {
    const x = n > 1 ? i * step : VB_W.value;
    const ratio = Math.min(1, Math.max(0, v / scale));
    return [x, VB_H - ratio * (VB_H - 6) - 3];
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${VB_W.value},${VB_H} L0,${VB_H} Z`;
  const last = pts[pts.length - 1];
  return { line, area, dot: { x: last[0], y: last[1] }, empty: false };
});

const gradientId = `sg-${Math.random().toString(36).slice(2, 9)}`;
</script>

<template>
  <svg
    class="sparkline"
    :viewBox="`0 0 ${VB_W} ${VB_H}`"
    preserveAspectRatio="none"
    role="img"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.34" />
        <stop offset="100%" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <template v-if="!geometry.empty">
      <path :d="geometry.area" :fill="`url(#${gradientId})`" />
      <path
        :d="geometry.line"
        fill="none"
        :stroke="color"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
      <circle
        v-if="values.length > 1"
        :cx="geometry.dot.x"
        :cy="geometry.dot.y"
        r="1.8"
        :fill="color"
        vector-effect="non-scaling-stroke"
      />
    </template>
    <line
      v-else
      x1="0" :y1="VB_H - 3" :x2="VB_W" :y2="VB_H - 3"
      :stroke="color" stroke-opacity="0.28" stroke-width="1"
      stroke-dasharray="3 4" vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<style scoped>
.sparkline { display: block; width: 100%; height: 100%; overflow: visible; }
</style>

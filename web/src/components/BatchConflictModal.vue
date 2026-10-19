<script setup>
import { computed } from 'vue';
import { state } from '../store.js';

const emit = defineEmits(['close', 'fix']);

const conflicts = computed(() => state.batchConflicts || []);

/** 冲突里是否有一个明确的「单个服务」可以就地换端口（批次内互撞这种情况没有） */
function singleService(conflict) {
  return conflict?.services?.length === 1 ? conflict.services[0] : null;
}

function fix(conflict) {
  const one = singleService(conflict);
  if (!one) return;
  emit('fix', { serviceId: one.id, conflict });
}
</script>

<template>
  <div class="overlay modal-wrap" @click.self="emit('close')">
    <div class="modal" style="width: min(780px, 100%)">
      <header class="modal-head">
        <span style="font-size: 18px">⚠</span>
        <h2>批量启动被拦下 {{ conflicts.length }} 项</h2>
        <span class="grow" style="flex: 1" />
        <button class="btn ghost icon" @click="emit('close')">✕</button>
      </header>

      <div class="modal-body">
        <div class="banner info" style="margin-bottom: 14px">
          <span>ℹ</span>
          <span class="grow">
            这些服务在启动前就被拦住了，<b>不会先崩一次再报错</b>。其余服务已正常启动。
          </span>
        </div>

        <div
          v-for="(c, i) in conflicts"
          :key="`${c.port}-${i}`"
          class="card"
          style="padding: 12px 14px; margin-bottom: 10px"
        >
          <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap">
            <span class="tag purple mono">:{{ c.port }}</span>
            <span class="tag" :class="c.reason === 'occupied' ? 'amber' : 'blue'">
              {{ c.reason === 'occupied' ? '端口已被占用' : '批次内端口重复' }}
            </span>
            <span class="grow" style="flex: 1" />
            <button
              v-if="singleService(c)"
              class="btn sm primary"
              title="为该服务另选端口后启动"
              @click="fix(c)"
            >换端口启动</button>
          </div>

          <div class="hint" style="margin-top: 7px">{{ c.detail }}</div>

          <div class="row" style="gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center">
            <span class="hint">涉及服务：</span>
            <span v-for="s in c.services" :key="s.id" class="tag">{{ s.name }}</span>
          </div>

          <div
            v-if="c.occupants?.length"
            class="mono-block"
            style="margin-top: 9px; font-size: 11.5px"
          >
            <div v-for="o in c.occupants" :key="`${o.pid}-${o.address}`">
              <span class="k">占用者</span>
              <span class="v">
                PID {{ o.pid }} · {{ o.managedServiceName ? `托管服务「${o.managedServiceName}」` : (o.name || '未知进程') }}
                · {{ o.address }}:{{ o.port }}
              </span>
            </div>
            <div v-if="c.suggestion">
              <span class="k">可用端口</span>
              <span class="v mono">{{ c.suggestion }}</span>
            </div>
          </div>

          <div
            v-if="!singleService(c)"
            class="hint"
            style="margin-top: 8px; color: var(--amber)"
          >
            这几个服务声明了同一个端口，需要先给它们分别配置不同端口，再批量启动。
          </div>
        </div>
      </div>

      <footer class="modal-foot">
        <span class="hint">提示：单独点某个服务的「启动」也会先做同样的预检</span>
        <span class="grow" style="flex: 1" />
        <button class="btn" @click="emit('close')">知道了</button>
      </footer>
    </div>
  </div>
</template>

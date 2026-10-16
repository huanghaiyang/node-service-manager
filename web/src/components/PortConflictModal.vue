<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { launchService, state } from '../store.js';

const props = defineProps({
  /** { service, info } —— info 来自 /preflight */
  context: { type: Object, required: true },
});

const emit = defineEmits(['close']);

const busy = ref(false);
const picked = ref(null);
const manual = ref('');
const persist = ref(false);
const manualError = ref('');
const refreshing = ref(false);

const service = computed(() => props.context.service);
const info = computed(() => props.context.info);
const occupants = computed(() => info.value?.occupants || []);

function pick(port) {
  picked.value = port;
  manual.value = '';
  manualError.value = '';
}

onMounted(() => {
  // 默认选中系统随机分配的可用端口，用户直接回车即可
  if (Number.isInteger(info.value?.suggestion)) picked.value = info.value.suggestion;
});

async function reroll() {
  refreshing.value = true;
  try {
    const next = await api.preflight(service.value.id);
    if (next?.suggestion) pick(next.suggestion);
    state.portConflict = { service: service.value, info: next };
  } finally {
    refreshing.value = false;
  }
}

function applyManual() {
  const port = Number(String(manual.value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    manualError.value = '请填写 1–65535 之间的端口号';
    return;
  }
  manualError.value = '';
  picked.value = port;
}

async function confirm() {
  const port = Number(manual.value.trim()) || picked.value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    manualError.value = '请先选择或填写一个端口';
    return;
  }
  busy.value = true;
  try {
    await launchService(service.value, { port, persistPort: persist.value });
    emit('close');
  } finally {
    busy.value = false;
  }
}

async function forceStart() {
  busy.value = true;
  try {
    await launchService(service.value, { port: info.value?.port ?? null });
    emit('close');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overlay modal-wrap" @click.self="emit('close')">
    <div class="modal" style="width: min(760px, 94vw)">
      <header class="modal-head">
        <span style="font-size: 18px">⚠</span>
        <h2>端口 {{ info.port }} 已被占用</h2>
        <span class="grow" style="flex: 1" />
        <button class="btn ghost icon" @click="emit('close')">✕</button>
      </header>

      <div class="modal-body">
        <p class="dim" style="margin: 0 0 12px">
          服务 <b>{{ service.name }}</b> 准备使用的端口当前不可用。可以改用下面推荐的随机端口，
          也可以手动指定一个。
        </p>

        <div class="section-title" style="margin-top: 0">占用者</div>
        <div v-if="occupants.length" class="card" style="padding: 10px 12px">
          <div v-for="o in occupants" :key="`${o.pid}-${o.address}`" class="occupant-row">
            <span class="tag purple">PID {{ o.pid }}</span>
            <span class="mono">{{ o.name || '未知进程' }}</span>
            <span class="muted mono">{{ o.address }}:{{ o.port }}</span>
            <span v-if="o.memoryBytes" class="muted">{{ (o.memoryBytes / 1048576).toFixed(1) }} MB</span>
            <span v-if="o.managedServiceName" class="tag amber">正是托管服务「{{ o.managedServiceName }}」</span>
          </div>
          <div v-if="occupants[0]?.commandLine" class="hint mono" style="margin-top: 8px; word-break: break-all">
            {{ occupants[0].commandLine }}
          </div>
        </div>
        <div v-else class="banner warn">
          <span>!</span>
          <span class="grow">端口无法绑定，但没能定位到占用它的进程（可能是权限不足或端口处于保留状态）。</span>
        </div>

        <div class="section-title">使用新端口启动</div>
        <div class="row" style="gap: 10px; flex-wrap: wrap; align-items: flex-end">
          <div class="field" style="min-width: 190px">
            <label>系统随机分配的可用端口</label>
            <div class="row" style="gap: 8px">
              <span class="port-pick" :class="{ active: picked === info.suggestion }">{{ info.suggestion || '—' }}</span>
              <button class="btn sm" :disabled="refreshing" @click="reroll">
                <span v-if="refreshing" class="spin" /> 换一个
              </button>
            </div>
          </div>
          <div class="field grow" style="min-width: 190px">
            <label>或手动指定端口</label>
            <div class="row" style="gap: 8px">
              <input
                v-model="manual"
                class="input mono"
                placeholder="例如 8788"
                @keyup.enter="confirm"
                @input="manualError = ''"
              />
              <button class="btn sm" @click="applyManual">使用</button>
            </div>
          </div>
        </div>
        <div v-if="manualError" class="banner err" style="margin-top: 8px">
          <span>✕</span><span class="grow">{{ manualError }}</span>
        </div>

        <label class="row" style="gap: 8px; margin-top: 14px; cursor: pointer">
          <input v-model="persist" type="checkbox" />
          <span>同时保存为该服务的端口（下次启动默认使用）</span>
        </label>

        <div class="banner info" style="margin-top: 12px">
          <span>ℹ</span>
          <span class="grow">
            端口会以 <span class="mono">PORT</span> 环境变量注入子进程。
            由于 dotenv 默认不覆盖已存在的环境变量，这里的值会优先于项目 <span class="mono">.env</span> 中的
            <span class="mono">PORT</span>。
          </span>
        </div>
      </div>

      <footer class="modal-foot">
        <button class="btn ghost" :disabled="busy" @click="forceStart">
          仍然用 {{ info.port }} 启动
        </button>
        <span class="grow" style="flex: 1" />
        <button class="btn" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy" @click="confirm">
          <span v-if="busy" class="spin" /> 用新端口启动
        </button>
      </footer>
    </div>
  </div>
</template>

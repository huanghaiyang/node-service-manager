<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { refresh, toast } from '../store.js';

const emit = defineEmits(['close']);

const loading = ref(true);
const busy = ref(false);
const restoring = ref(false);
const error = ref('');

const auto = ref(null);       // 自启动状态（后端返回）
const settings = ref({ restoreOnBoot: false, restoreStaggerMs: 800 });
const trayState = ref(null);

const enabled = computed(() => Boolean(auto.value?.enabled));
const supported = computed(() => auto.value?.supported !== false);
const mechanism = computed(() => auto.value?.mechanismLabel || '—');
const trayOn = computed(() => Boolean(trayState.value?.running));
const traySupported = computed(() => trayState.value?.supported !== false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [res, trayRes] = await Promise.all([
      api.getSettings(),
      api.getTray().catch(() => null),
    ]);
    settings.value = res.settings;
    auto.value = res.autostart;
    trayState.value = trayRes?.tray || null;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function toggleTray() {
  const next = !trayOn.value;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.setTray(next);
    trayState.value = res.tray;
    settings.value = res.settings;
    toast(next ? '已显示任务栏托盘' : '已隐藏任务栏托盘', 'ok');
  } catch (err) {
    error.value = err.message;
    toast(err.message, 'err', 8000);
  } finally {
    busy.value = false;
  }
}

async function toggleAutostart() {
  busy.value = true;
  error.value = '';
  try {
    const res = await api.setAutostart(!enabled.value);
    auto.value = res.status;
    toast(enabled.value ? '已开启开机自启动' : '已关闭开机自启动', 'ok');
  } catch (err) {
    error.value = err.message;
    toast(err.message, 'err', 8000);
  } finally {
    busy.value = false;
  }
}

async function toggleRestore() {
  const next = !settings.value.restoreOnBoot;
  busy.value = true;
  try {
    const res = await api.patchSettings({ restoreOnBoot: next });
    settings.value = res.settings;
    toast(next ? '已开启：启动时恢复上次运行的服务' : '已关闭启动时恢复', 'ok');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function restoreNow() {
  restoring.value = true;
  try {
    const res = await api.restoreServices();
    const started = (res.results || []).filter((r) => r.started).length;
    const skipped = (res.results || []).filter((r) => r.skipped).length;
    const failed = (res.results || []).filter((r) => r.error).length;
    toast(
      res.results?.length
        ? `恢复完成：启动 ${started} · 跳过 ${skipped} · 失败 ${failed}`
        : '没有「期望运行」的服务需要恢复',
      failed ? 'err' : 'ok',
      failed ? 8000 : 4000,
    );
    await refresh();
  } catch (err) {
    error.value = err.message;
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="overlay modal-wrap" @click.self="emit('close')">
    <div class="modal" style="width: min(760px, 94vw)">
      <header class="modal-head">
        <h2>设置</h2>
        <span class="grow" style="flex: 1" />
        <button class="btn ghost icon" @click="emit('close')">✕</button>
      </header>

      <div class="modal-body">
        <div v-if="loading" class="hint" style="padding: 24px; text-align: center">读取中…</div>

        <template v-else>
          <div v-if="error" class="banner err" style="margin-bottom: 14px">
            <span>✕</span><span class="grow">{{ error }}</span>
          </div>

          <!-- 开机自启动 -->
          <div class="section-title" style="margin-top: 0">开机自启动（本工具）</div>
          <div class="card" style="padding: 14px 16px">
            <div class="row" style="gap: 10px; align-items: center">
              <div class="grow" style="min-width: 0">
                <div class="row" style="gap: 8px">
                  <b>登录后自动启动治理工具</b>
                  <span class="tag" :class="enabled ? 'green' : ''">{{ enabled ? '已开启' : '未开启' }}</span>
                  <span v-if="!supported" class="tag amber">当前平台不支持</span>
                </div>
                <div class="hint" style="margin-top: 5px">{{ mechanism }}</div>
              </div>
              <button
                class="btn"
                :class="enabled ? 'danger' : 'primary'"
                :disabled="busy || !supported"
                @click="toggleAutostart"
              >
                <span v-if="busy" class="spin" /> {{ enabled ? '关闭自启动' : '开启自启动' }}
              </button>
            </div>

            <div class="hint" style="margin-top: 10px; line-height: 1.7">{{ auto.detail }}</div>

            <div v-if="enabled || auto.entry" class="mono-block" style="margin-top: 12px">
              <div><span class="k">注册位置</span> <span class="v">{{ auto.entry }}</span></div>
              <div v-if="auto.launcherFiles?.length">
                <span class="k">启动器</span>
                <span class="v">{{ auto.launcherFiles.join('　') }}</span>
              </div>
              <div v-if="auto.logFile"><span class="k">日志</span> <span class="v">{{ auto.logFile }}</span></div>
              <div><span class="k">实际命令</span> <span class="v">{{ auto.command }}</span></div>
            </div>

            <div class="banner info" style="margin-top: 12px; font-size: 12px">
              <span>ℹ</span>
              <span class="grow">
                只写入<b>当前用户</b>级别的位置，不需要管理员/root 权限；关闭时会连同启动器文件一起清理。
                端口 <span class="mono">{{ auto.command?.match(/PORT=(\d+)/)?.[1] || '—' }}</span>
                与数据目录会一并固化，开机拉起的是<b>同一个实例</b>。
              </span>
            </div>
          </div>

          <!-- 启动时恢复服务 -->
          <div class="section-title">启动时恢复服务</div>
          <div class="card" style="padding: 14px 16px">
            <div class="row" style="gap: 10px; align-items: center">
              <div class="grow" style="min-width: 0">
                <div class="row" style="gap: 8px">
                  <b>把「上次还在运行」的服务一并拉起来</b>
                  <span class="tag" :class="settings.restoreOnBoot ? 'green' : ''">
                    {{ settings.restoreOnBoot ? '已开启' : '未开启' }}
                  </span>
                </div>
                <div class="hint" style="margin-top: 5px">
                  依据每个服务的「期望运行」状态：显式停止会置为否，崩溃保留为是（下次会再试一次）。
                  已经在跑的服务会被跳过，不会产生重复实例。
                </div>
              </div>
              <button class="btn" :class="settings.restoreOnBoot ? '' : 'primary'" :disabled="busy" @click="toggleRestore">
                {{ settings.restoreOnBoot ? '关闭' : '开启' }}
              </button>
            </div>

            <div class="row" style="gap: 10px; margin-top: 12px; align-items: center">
              <button class="btn sm" :disabled="restoring" @click="restoreNow">
                <span v-if="restoring" class="spin" /> 立即恢复一次
              </button>
              <span class="hint">顺序启动，每个间隔 {{ settings.restoreStaggerMs }}ms，避免同时抢端口</span>
            </div>

            <div v-if="enabled && !settings.restoreOnBoot" class="banner warn" style="margin-top: 12px; font-size: 12px">
              <span>⚠</span>
              <span class="grow">
                已开启自启动但未开启服务恢复：开机后工具会起来，但托管的服务仍然不会自动运行。
                两者通常要一起开。
              </span>
            </div>
          </div>

          <!-- 任务栏托盘 -->
          <div class="section-title">任务栏托盘</div>
          <div class="card" style="padding: 14px 16px">
            <div class="row" style="gap: 10px; align-items: center">
              <div class="grow" style="min-width: 0">
                <div class="row" style="gap: 8px">
                  <b>在任务栏通知区域显示图标</b>
                  <span class="tag" :class="trayOn ? 'green' : ''">{{ trayOn ? '已显示' : '未显示' }}</span>
                  <span v-if="!traySupported" class="tag amber">当前平台不支持</span>
                </div>
                <div class="hint" style="margin-top: 5px">
                  双击图标打开控制台；右键可「启动全部 / 停止全部 / 刷新状态」。开启后会随工具一起启动。
                </div>
              </div>
              <button
                class="btn"
                :class="trayOn ? '' : 'primary'"
                :disabled="busy || !traySupported"
                @click="toggleTray"
              >
                <span v-if="busy" class="spin" /> {{ trayOn ? '隐藏托盘' : '显示托盘' }}
              </button>
            </div>

            <div v-if="trayState?.detail" class="hint" style="margin-top: 8px">{{ trayState.detail }}</div>

            <div v-if="trayState" class="mono-block" style="margin-top: 12px">
              <div><span class="k">图标</span> <span class="v">{{ trayState.icon }}</span></div>
              <div><span class="k">脚本</span> <span class="v">{{ trayState.script }}</span></div>
              <div v-if="trayState.pid"><span class="k">进程</span> <span class="v mono">PID {{ trayState.pid }}</span></div>
            </div>

            <div class="banner info" style="margin-top: 12px; font-size: 12px">
              <span>ℹ</span>
              <span class="grow">
                托盘用系统自带的 WinForms NotifyIcon 实现，<b>不引入 Electron / 原生依赖</b>；
                图标由工具自己生成 <span class="mono">.ico</span>。仅 Windows 可用。
              </span>
            </div>
          </div>
        </template>
      </div>

      <footer class="modal-foot">
        <span class="hint">端口 {{ auto?.command?.match(/PORT=(\d+)/)?.[1] || '—' }} · 数据目录 {{ auto?.dataDir || '—' }}</span>
        <span class="grow" style="flex: 1" />
        <button class="btn" @click="emit('close')">关闭</button>
      </footer>
    </div>
  </div>
</template>

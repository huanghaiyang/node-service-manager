import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 项目根目录（service-manager/） */
export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** 运行期数据目录，可用 SM_DATA_DIR 覆盖 */
export const DATA_DIR = process.env.SM_DATA_DIR
  ? path.resolve(process.env.SM_DATA_DIR)
  : path.join(ROOT_DIR, 'data');

export const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

/** 服务端监听端口 */
export const PORT = Number(process.env.PORT || process.env.SM_PORT || 5178);
export const HOST = process.env.SM_HOST || '127.0.0.1';

/** 指标采样周期（毫秒） */
export const SAMPLE_INTERVAL_MS = Number(process.env.SM_SAMPLE_INTERVAL || 3000);

/** 监听端口探测周期（毫秒）。端口变化不频繁，比指标采样慢一档即可 */
export const PORT_SAMPLE_INTERVAL_MS = Number(process.env.SM_PORT_SAMPLE_INTERVAL || 5000);

/** 每个服务内存中保留的日志行数 */
export const LOG_BUFFER_LINES = Number(process.env.SM_LOG_LINES || 2000);

/** 单文件日志轮转阈值（字节） */
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** 关闭服务时等待优雅退出的时间，超时后强杀 */
export const STOP_GRACE_MS = Number(process.env.SM_STOP_GRACE || 6000);

/** 崩溃自动重启：1 分钟内最多几次 */
export const AUTO_RESTART_WINDOW_MS = 60 * 1000;
export const AUTO_RESTART_MAX = 5;

export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

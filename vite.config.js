/**
 * 【可选】Vite 开发服务器配置 —— 默认构建链路不使用它。
 *
 * 默认构建走 `npm run build`（scripts/build-web.mjs），用 @vue/compiler-sfc 编译 SFC
 * 并输出浏览器原生 ESM + importmap，全程零原生二进制，任何环境都能构建、无需 postinstall。
 *
 * 如果你想要 HMR / 打包压缩，额外装一次依赖即可启用本配置：
 *   npm i -D vite @vitejs/plugin-vue
 *   npx vite            # 开发服务器（/api 已代理到治理服务端）
 *   npx vite build      # 打包输出到 dist/（会覆盖上面的原生 ESM 产物）
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const distDir = fileURLToPath(new URL('./dist', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.SM_PORT || 5178}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: distDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
});

#!/usr/bin/env node
/**
 * 纯 JavaScript 前端构建（不依赖 esbuild / rollup 等原生二进制）。
 *
 * 为什么不用 Vite：本项目面向本机运维场景，构建链越少越不容易在受限环境里翻车。
 * 这里用 @vue/compiler-sfc（纯 JS，随 vue 一起安装）把 .vue 编译成浏览器可执行的
 * ESM，浏览器原生 import + importmap 负责模块解析，产物无需打包即可运行。
 *
 * 产物结构：
 *   dist/index.html
 *   dist/assets/app.css
 *   dist/vendor/vue.esm-browser.prod.js
 *   dist/src/**            （编译后的应用代码，保留目录结构）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'web', 'src');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'dist');
const WATCH = process.argv.includes('--watch');
const DEV_MODE = WATCH || process.argv.includes('--dev');

const API_BASE = process.env.VITE_API_BASE || '';

function shortHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

async function listFiles(dir, filter = () => true) {
  const out = [];
  const walk = async (cur) => {
    const entries = await fsp.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (filter(abs)) out.push(abs);
    }
  };
  await walk(dir);
  return out;
}

/** 把源码里跨文件的 .vue 导入改写成编译后的 .js，并替换 Vite 专有的 import.meta.env */
function transformModuleCode(code, relPath) {
  let out = code;
  out = out.replace(/(from\s*['"])([^'"]+)\.vue(['"])/g, '$1$2.js$3');
  out = out.replace(/(import\s*\(\s*['"])([^'"]+)\.vue(['"]\s*\))/g, '$1$2.js$3');
  // 样式已统一汇总到 assets/app.css，浏览器无法把 .css 当 ES 模块加载，这里剔除
  out = out.replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '');
  out = out.replace(/import\.meta\.env\.VITE_API_BASE/g, JSON.stringify(API_BASE));
  out = out.replace(/import\.meta\.env\.\w+/g, 'undefined');
  void relPath;
  return out;
}

/** 给编译产物挂上 __scopeId，使 <style scoped> 的 data-v-xxx 属性生效 */
function attachScopeId(code, scopeId) {
  const idx = code.lastIndexOf('export default');
  if (idx < 0) return code;
  const head = code.slice(0, idx);
  const expr = code.slice(idx + 'export default'.length).replace(/;\s*$/, '').trim();
  return `${head}const __sfc__ = ${expr};\n`
    + `__sfc__.__scopeId = ${JSON.stringify(scopeId)};\n`
    + 'export default __sfc__;\n';
}

async function compileSfc(absPath) {
  const source = await fsp.readFile(absPath, 'utf8');
  const rel = path.relative(SRC, absPath).replace(/\\/g, '/');
  const id = shortHash(rel);
  const { descriptor, errors } = parse(source, { filename: absPath });
  if (errors?.length) {
    throw new Error(`${rel}: ${errors.map((e) => e.message).join('; ')}`);
  }

  let result;
  if (descriptor.scriptSetup || descriptor.script) {
    const compiled = compileScript(descriptor, {
      id,
      inlineTemplate: Boolean(descriptor.template),
      templateOptions: {
        compilerOptions: { scopeId: `data-v-${id}` },
      },
    });
    result = compiled.content;
    if (descriptor.template && !descriptor.scriptSetup) {
      // 仅有普通 <script> 的组件：手动补 render
      const { compileTemplate } = await import('@vue/compiler-sfc');
      const tpl = compileTemplate({
        source: descriptor.template.content,
        filename: absPath,
        id,
        compilerOptions: { scopeId: `data-v-${id}`, bindingMetadata: compiled.bindings },
      });
      result += `\n${tpl.code.replace(/export function render/, 'function render')}\n`;
      result = result.replace(/export default/, 'const __sfc__ =');
      result += `\n__sfc__.render = render;\nexport default __sfc__;\n`;
    }
  } else if (descriptor.template) {
    const { compileTemplate } = await import('@vue/compiler-sfc');
    const tpl = compileTemplate({
      source: descriptor.template.content,
      filename: absPath,
      id,
      compilerOptions: { scopeId: `data-v-${id}` },
    });
    result = `${tpl.code.replace(/export function render/, 'function render')}\n`
      + `const __sfc__ = {};\n__sfc__.render = render;\n`
      + `__sfc__.__scopeId = ${JSON.stringify(`data-v-${id}`)};\n`
      + 'export default __sfc__;\n';
  } else {
    result = 'export default {};\n';
  }

  // 注入 scopeId，保证 scoped 样式生效
  if (descriptor.styles.some((s) => s.scoped)) {
    result = attachScopeId(result, `data-v-${id}`);
  }

  const styles = [];
  for (const style of descriptor.styles) {
    const compiled = compileStyle({
      source: style.content,
      filename: absPath,
      id: `data-v-${id}`,
      scoped: Boolean(style.scoped),
    });
    if (compiled.errors?.length) {
      throw new Error(`${rel} <style>: ${compiled.errors.map((e) => e.message).join('; ')}`);
    }
    styles.push(compiled.code);
  }

  return { code: transformModuleCode(result, rel), styles };
}

/**
 * 拷贝 web/public 下的静态资源到 dist 根目录（原样保留相对路径）。
 * 目前主要是 favicon.svg；以后加 robots.txt / 图片也能直接放这里。
 */
async function copyPublic() {
  const FROM = path.join(WEB, 'public');
  if (!fs.existsSync(FROM)) return 0;
  const files = await listFiles(FROM);
  for (const abs of files) {
    const rel = path.relative(FROM, abs);
    const target = path.join(OUT, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(abs, target);
  }
  return files.length;
}

/**
 * 生成 favicon.ico。
 *
 * 与任务栏托盘复用同一份图标代码（server/src/icon.js 用纯 JS 拼 ICO 字节），
 * 这样两处图形永远一致，也不用往仓库里塞二进制。
 */
async function writeFaviconIco() {
  const { buildIco } = await import(new URL('../server/src/icon.js', import.meta.url).href);
  const target = path.join(OUT, 'favicon.ico');
  await fsp.writeFile(target, buildIco({ sizes: [16, 32, 48] }));
  return target;
}

async function build() {
  const t0 = Date.now();
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(path.join(OUT, 'assets'), { recursive: true });
  await fsp.mkdir(path.join(OUT, 'vendor'), { recursive: true });

  const sources = await listFiles(SRC);
  const styleChunks = [];
  let jsCount = 0;
  let vueCount = 0;

  for (const abs of sources) {
    const rel = path.relative(SRC, abs).replace(/\\/g, '/');

    if (abs.endsWith('.vue')) {
      const { code, styles } = await compileSfc(abs);
      // 编译产物去掉 .vue 后缀（import 侧同样被改写为 .js）
      const target = path.join(OUT, 'src', rel.replace(/\.vue$/, '.js'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, code, 'utf8');
      styleChunks.push(...styles);
      vueCount += 1;
    } else if (abs.endsWith('.js')) {
      const target = path.join(OUT, 'src', rel);
      const code = await fsp.readFile(abs, 'utf8');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, transformModuleCode(code, rel), 'utf8');
      jsCount += 1;
    } else if (abs.endsWith('.css')) {
      const css = await fsp.readFile(abs, 'utf8');
      styleChunks.push(css);
    }
  }

  // 样式汇总
  await fsp.writeFile(path.join(OUT, 'assets', 'app.css'), styleChunks.join('\n\n'), 'utf8');

  // Vue 运行时（浏览器 ESM 版，含模板编译器，稳妥优先）
  const vueDist = path.join(ROOT, 'node_modules', 'vue', 'dist', 'vue.esm-browser.prod.js');
  const vueTarget = path.join(OUT, 'vendor', 'vue.esm-browser.prod.js');
  await fsp.copyFile(vueDist, vueTarget);

  // 静态资源（favicon 等）
  const publicCount = await copyPublic();
  const icoPath = await writeFaviconIco();

  // index.html：head 中注入 importmap（把裸模块 'vue' 映射到本地运行时）与样式
  let html = await fsp.readFile(path.join(WEB, 'index.html'), 'utf8');
  const head = [
    '    <link rel="stylesheet" href="/assets/app.css" />',
    '    <!-- 浏览器原生模块解析：把裸模块说明符映射到本地 Vue 运行时，无需打包器 -->',
    '    <script type="importmap">',
    '      { "imports": { "vue": "/vendor/vue.esm-browser.prod.js" } }',
    '    </script>',
    '  </head>',
  ].join('\n');  if (!/<\/head>/.test(html)) throw new Error('web/index.html 缺少 </head>');
  html = html.replace(/<\/head>/, head);
  await fsp.writeFile(path.join(OUT, 'index.html'), html, 'utf8');

  const size = (p) => {
    try { return fs.statSync(p).size; } catch { return 0; }
  };
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`[build-web] 完成：${vueCount} 个 .vue + ${jsCount} 个 .js，用时 ${Date.now() - t0}ms`);
  console.log(`[build-web]   dist/index.html      ${kb(size(path.join(OUT, 'index.html')))}`);
  console.log(`[build-web]   dist/assets/app.css  ${kb(size(path.join(OUT, 'assets', 'app.css')))}`);
  console.log(`[build-web]   dist/vendor/vue...   ${kb(size(vueTarget))}`);
  if (publicCount) {
    console.log(`[build-web]   dist/favicon.svg    ${kb(size(path.join(OUT, 'favicon.svg')))}  （public 资源 ${publicCount} 个）`);
  }
  console.log(`[build-web]   dist/favicon.ico    ${kb(size(icoPath))}  （与托盘图标同一份图形）`);
}

async function main() {
  await build();
  if (!WATCH) return;

  console.log('[build-web] 监听 web/ 变更中（Ctrl+C 退出）…');
  let timer = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      build().catch((err) => console.error('[build-web] 构建失败:', err.message));
    }, 150);
  };
  try {
    fs.watch(WEB, { recursive: true }, (event, filename) => {
      if (filename && /node_modules|[\\/]\./.test(filename)) return;
      trigger();
    });
  } catch (err) {
    console.warn('[build-web] 无法启用递归监听，退化为轮询:', err.message);
    setInterval(trigger, 1500);
  }
  void DEV_MODE;
}

main().catch((err) => {
  console.error('[build-web] 构建失败:', err.stack || err.message);
  process.exit(1);
});

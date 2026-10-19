import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load, TMP_DATA, rmrf } from './helpers.mjs';

const { stripAnsi, sanitizeLogLine, cleanupTmpDir, formatBytes, sleep } = await load('util.js');
const fs = await import('node:fs');
const path = await import('node:path');

describe('stripAnsi / sanitizeLogLine', () => {
  test('去掉 SGR 颜色码（用户实际遇到的乱码）', () => {
    const raw = '\u001b[2m16:03:52\u001b[22m \u001b[36m\u001b[1m[vite]\u001b[22m\u001b[39m \u001b[32mhmr update\u001b[39m';
    assert.equal(sanitizeLogLine(raw), '16:03:52 [vite] hmr update');
  });

  test('去掉光标控制（清行 / 回到行首）', () => {
    assert.equal(sanitizeLogLine('before\u001b[2K\u001b[1Gafter'), 'beforeafter');
  });

  test('\\r 进度条只保留最后一段（对齐终端语义）', () => {
    assert.equal(sanitizeLogLine('构建中 10%\r构建中 55%\r构建中 100%'), '构建中 100%');
  });

  test('保留中文与制表符，去掉其它控制字符', () => {
    assert.equal(sanitizeLogLine('红色\u0007\t普通\u0000文字'), '红色\t普通文字');
  });

  test('OSC 序列（设置窗口标题）也能去掉', () => {
    assert.equal(sanitizeLogLine('\u001b]0;title\u0007hello'), 'hello');
  });

  test('普通文本原样返回', () => {
    assert.equal(sanitizeLogLine('[api] listening on 8787'), '[api] listening on 8787');
  });

  test('stripAnsi 不改变不含转义序列的文本', () => {
    assert.equal(stripAnsi('plain 文本'), 'plain 文本');
  });
});

describe('cleanupTmpDir', () => {
  test('删掉 cap- 前缀的残留文件，保留其它文件', () => {
    const dir = path.join(TMP_DATA, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const cap = path.join(dir, 'cap-1-2-3.txt');
    const other = path.join(dir, 'keep.txt');
    fs.writeFileSync(cap, 'x');
    fs.writeFileSync(other, 'y');

    const removed = cleanupTmpDir({ minAgeMs: 0 });
    assert.ok(removed >= 1, '应至少删掉一个 cap 文件');
    assert.equal(fs.existsSync(cap), false);
    assert.equal(fs.existsSync(other), true, '非 cap- 文件不能被误删');
    fs.rmSync(other, { force: true });
  });

  test('机龄过滤：新文件在 minAgeMs 内不会被删', () => {
    const dir = path.join(TMP_DATA, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const fresh = path.join(dir, `cap-${Date.now()}-fresh.txt`);
    fs.writeFileSync(fresh, 'x');
    cleanupTmpDir({ minAgeMs: 60_000 });
    assert.equal(fs.existsSync(fresh), true, '刚写入的文件不应被删');
    cleanupTmpDir({ minAgeMs: 0 });
    assert.equal(fs.existsSync(fresh), false);
  });

  test('目录不存在时安全返回 0', () => {
    rmrf(path.join(TMP_DATA, 'tmp'));
    assert.equal(cleanupTmpDir({ minAgeMs: 0 }), 0);
  });
});

describe('sleep / formatBytes', () => {
  test('sleep 至少等待指定时长', async () => {
    const t0 = Date.now();
    await sleep(30);
    assert.ok(Date.now() - t0 >= 25);
  });

  test('formatBytes 单位换算', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024 * 2), '2.0 MB');
    assert.equal(formatBytes(-1), '-');
    assert.equal(formatBytes(null), '-');
  });
});

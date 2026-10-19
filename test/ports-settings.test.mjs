import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const ports = await load('ports.js');
const settings = await load('settings.js');

describe('parseLocalAddress（netstat 地址解析）', () => {
  const parse = ports.parseLocalAddress;

  test('IPv4 具体地址', () => {
    assert.deepEqual(parse('127.0.0.1:8787'), { address: '127.0.0.1', port: 8787 });
  });

  test('通配地址 0.0.0.0', () => {
    assert.deepEqual(parse('0.0.0.0:7100'), { address: '0.0.0.0', port: 7100 });
  });

  test('IPv6 通配 [::]', () => {
    assert.deepEqual(parse('[::]:5178'), { address: '::', port: 5178 });
  });

  test('IPv6 具体地址', () => {
    assert.deepEqual(parse('[::1]:8080'), { address: '::1', port: 8080 });
  });

  test('无法解析时返回 null', () => {
    assert.equal(parse('not-an-address'), null);
    assert.equal(parse(''), null);
  });
});

describe('defaultEntryUrl', () => {
  test('默认使用 127.0.0.1', () => {
    assert.equal(ports.defaultEntryUrl(7100), 'http://127.0.0.1:7100/');
  });
  test('通配绑定地址替换为回环（浏览器打不开 0.0.0.0）', () => {
    assert.equal(ports.defaultEntryUrl(7100, '0.0.0.0'), 'http://127.0.0.1:7100/');
    assert.equal(ports.defaultEntryUrl(7100, '::'), 'http://127.0.0.1:7100/');
  });
  test('具体地址按原样使用', () => {
    assert.equal(ports.defaultEntryUrl(7100, '192.168.1.5'), 'http://192.168.1.5:7100/');
  });
});

describe('settings（全局设置）', () => {
  test('默认值：不自动恢复服务', async () => {
    const s = settings.readSettings();
    assert.equal(typeof s.restoreOnBoot, 'boolean');
    assert.equal(s.restoreOnBoot, false);
    assert.ok(s.restoreStaggerMs >= 0);
  });

  test('可开启并持久化', async () => {
    const next = await settings.patchSettings({ restoreOnBoot: true });
    assert.equal(next.restoreOnBoot, true);
    assert.equal(settings.readSettings().restoreOnBoot, true);
  });

  test('非法间隔被忽略，保留原值（而不是回落默认值）', async () => {
    await settings.patchSettings({ restoreStaggerMs: 500 });
    const before = settings.readSettings().restoreStaggerMs;
    await settings.patchSettings({ restoreStaggerMs: -5 });
    assert.equal(settings.readSettings().restoreStaggerMs, before, '非法值不应改动已有设置');
  });

  test('合法间隔可调', async () => {
    const next = await settings.patchSettings({ restoreStaggerMs: 1200 });
    assert.equal(next.restoreStaggerMs, 1200);
  });

  test('布尔字段传非布尔值不会误改', async () => {
    await settings.patchSettings({ restoreOnBoot: true });
    await settings.patchSettings({ restoreOnBoot: 'yes' });
    assert.equal(settings.readSettings().restoreOnBoot, true, '非布尔值应被忽略');
  });
});

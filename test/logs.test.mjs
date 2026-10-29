import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { LogStore } = await load('logs.js');

/**
 * 直接往内存缓冲里塞行：底部活动面板只消费缓冲内容，
 * 用显式时间戳才能稳定验证「跨服务排序」这类行为。
 */
function makeStore(rows) {
  const store = new LogStore();
  for (const [serviceId, ts, stream, text] of rows) {
    store._state(serviceId).buffer.push({ serviceId, ts, stream, text });
  }
  return store;
}

describe('LogStore.recent（底部活动面板的跨服务聚合）', () => {
  test('跨服务按时间升序合并', () => {
    const store = makeStore([
      ['svc-a', '2026-10-29T03:00:01.000Z', 'system', 'a 启动'],
      ['svc-a', '2026-10-29T03:00:05.000Z', 'stdout', 'a 运行输出'],
      ['svc-b', '2026-10-29T03:00:02.000Z', 'system', 'b 启动'],
      ['svc-b', '2026-10-29T03:00:03.000Z', 'stderr', 'b 报错'],
    ]);
    assert.deepEqual(
      store.recent(10).map((line) => line.text),
      ['a 启动', 'b 启动', 'b 报错', 'a 运行输出'],
    );
  });

  test('只保留最后 limit 条（与实时滚动的观感一致）', () => {
    const store = makeStore([
      ['svc-a', '2026-10-29T03:00:01.000Z', 'system', '第 1 行'],
      ['svc-a', '2026-10-29T03:00:02.000Z', 'system', '第 2 行'],
      ['svc-a', '2026-10-29T03:00:03.000Z', 'system', '第 3 行'],
      ['svc-a', '2026-10-29T03:00:04.000Z', 'system', '第 4 行'],
    ]);
    const lines = store.recent(2);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.text), ['第 3 行', '第 4 行']);
    assert.equal(lines[0].serviceId, 'svc-a');
  });

  test('没有时间戳的磁盘历史行不混进全局时间线', () => {
    const store = makeStore([
      ['svc-a', null, 'stdout', '历史输出（无时间戳）'],
      ['svc-a', '2026-10-29T03:00:01.000Z', 'system', '实时系统事件'],
      ['svc-b', null, 'stderr', '历史报错（无时间戳）'],
    ]);
    assert.deepEqual(store.recent(10).map((line) => line.text), ['实时系统事件']);
  });

  test('limit 非法或为 0 时返回空数组', () => {
    const store = makeStore([
      ['svc-a', '2026-10-29T03:00:01.000Z', 'system', '任意行'],
    ]);
    assert.deepEqual(store.recent(0), []);
    assert.deepEqual(store.recent(-5), []);
  });
});

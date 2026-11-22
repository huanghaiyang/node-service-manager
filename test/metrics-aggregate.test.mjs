import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { ProcessSampler } = await load('metrics.js');

/** 造一个最小可用的采样快照 */
function snapshot(rows, { treeSupported = true, cores = 4 } = {}) {
  const processes = new Map(rows.map((r) => [r.pid, r]));
  const cpuByPid = new Map(rows.map((r) => [r.pid, r.cpuSeconds || 0]));
  return { processes, cpuByPid, cores, treeSupported, ts: Date.now() };
}

const row = (pid, ppid, rss, name = 'node') => ({ pid, ppid, rss, name, cpuSeconds: 0 });

describe('aggregateMany（同一服务多端口/多实例时按并集汇总）', () => {
  const sampler = new ProcessSampler();

  test('单个根与旧的 aggregate 行为一致', () => {
    const snap = snapshot([row(10, 1, 100), row(11, 10, 50), row(20, 1, 70)]);
    const one = sampler.aggregate(snap, 10);
    const many = sampler.aggregateMany(snap, [10]);
    assert.equal(one.processCount, 2);
    assert.equal(one.memoryBytes, 150);
    assert.equal(one.pid, 10);
    assert.equal(many.processCount, 2);
    assert.equal(many.memoryBytes, 150);
    assert.equal(many.processes.filter((p) => p.isRoot).length, 1);
  });

  test('两个启动根：进程、内存按并集汇总，端口归属也就能覆盖两个实例', () => {
    // 10 → 11（前端 5173）  20 → 21（后端 8080）  30 无关进程
    const snap = snapshot([row(10, 1, 100), row(11, 10, 50), row(20, 1, 70), row(21, 20, 30), row(30, 1, 999)]);
    const agg = sampler.aggregateMany(snap, [10, 20]);
    assert.equal(agg.processCount, 4);
    assert.equal(agg.memoryBytes, 250);
    assert.deepEqual(agg.roots, [10, 20]);
    assert.equal(agg.pid, 10);
    assert.deepEqual([...agg.processes.filter((p) => p.isRoot).map((p) => p.pid)].sort((a, b) => a - b), [10, 20]);
    assert.equal(agg.processes.some((p) => p.pid === 30), false);
  });

  test('重复的根不会重复计数', () => {
    const snap = snapshot([row(10, 1, 100), row(11, 10, 50)]);
    const agg = sampler.aggregateMany(snap, [10, 10, 11]);
    assert.equal(agg.processCount, 2);
    assert.equal(agg.memoryBytes, 150);
  });

  test('根已退出时 alive=false，但其它根仍计入', () => {
    const snap = snapshot([row(20, 1, 70), row(21, 20, 30)]);
    const agg = sampler.aggregateMany(snap, [10, 20]);
    assert.equal(agg.alive, true);
    assert.equal(agg.processCount, 2);
  });

  test('无根时返回空结果', () => {
    const snap = snapshot([row(10, 1, 100)]);
    const agg = sampler.aggregateMany(snap, []);
    assert.equal(agg.processCount, 0);
    assert.equal(agg.memoryBytes, 0);
    assert.equal(agg.alive, false);
  });

  test('降级模式（无父子关系）只统计根进程本身', () => {
    const snap = snapshot([row(10, 1, 100), row(11, 10, 50)], { treeSupported: false });
    const agg = sampler.aggregateMany(snap, [10, 11]);
    assert.equal(agg.processCount, 2);
    assert.equal(agg.memoryBytes, 150);
    assert.equal(agg.scope, 'process');
  });
});

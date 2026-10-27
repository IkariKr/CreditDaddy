/**
 * formatDurationMs — 冷却时长的可读格式。
 * 退避阶梯第一档只有 30s，按分钟四舍五入会显示成「1 分钟」（甚至与 0 混淆），
 * 所以这里逐档钉死秒/分钟的边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatDurationMs } = await import('../src/formatDuration.js');

test('不足 1 分钟按秒显示（30s 不能抹成 1 分钟）', () => {
  assert.equal(formatDurationMs(30_000), '30 秒');
  assert.equal(formatDurationMs(1_000), '1 秒');
  assert.equal(formatDurationMs(59_000), '59 秒');
});

test('1 分钟及以上按分钟显示', () => {
  assert.equal(formatDurationMs(60_000), '1 分钟');
  assert.equal(formatDurationMs(120_000), '2 分钟');
  assert.equal(formatDurationMs(240_000), '4 分钟');
  assert.equal(formatDurationMs(30 * 60_000), '30 分钟');
});

test('退避阶梯四档的实际输出', () => {
  const ladder = [30_000, 60_000, 120_000, 240_000];
  assert.deepEqual(ladder.map(formatDurationMs), ['30 秒', '1 分钟', '2 分钟', '4 分钟']);
});

test('异常输入不崩：0 / 负数 / 非有限值', () => {
  assert.equal(formatDurationMs(0), '0 秒');
  assert.equal(formatDurationMs(-5000), '0 秒');
  assert.equal(formatDurationMs(Number.NaN), '0 秒');
  assert.equal(formatDurationMs(Number.POSITIVE_INFINITY), '0 秒');
});

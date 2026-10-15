/**
 * 办公小浣熊（issue #27）回归：balance 解析（信封/四桶）、401 auth 失效标记、
 * 身份尽力而为、载荷四腿形状（isCreditBalance + detailOnly，与 modelscope 同口径不照抄拆分）、
 * authInvalid 降级 message 卡不回退旧快照。
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xhx-test-'));
process.env.CREDITDADDY_HOME = HOME;

const xhx = await import('../src/xiaohuanxiongClient.js');
const cs = await import('../src/cookieSites.js');

const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const site = cs.getSite('xiaohuanxiong');

test('站点配置：API 裸域 + verify api + 双源 cookieUrls（issue #27 的两个坑）', () => {
  assert.ok(site);
  assert.equal(site.verify, 'api');
  assert.deepEqual(site.cookieUrls, ['https://office.xiaohuanxiong.com', 'https://xiaohuanxiong.com']);
  assert.match(xhx.XHX_BALANCE_URL, /^https:\/\/xiaohuanxiong\.com\//, 'API 必须在裸域（office 子域会 307 跳登录页）');
});

test('fetchRaccoonBalance：信封 data 四桶解析', async () => {
  let calledUrl = '';
  let calledHeaders = null;
  const fetchImpl = async (url, init) => {
    calledUrl = String(url);
    calledHeaders = init.headers;
    return okRes({ code: 0, message: 'success', data: { available_points: 3000, daily_points: 300, monthly_points: 0, reward_points: 2700, topup_points: 0, topup_frozen: false } });
  };
  const b = await xhx.fetchRaccoonBalance('other=1; raccoon_token=SECRET-TOKEN; user_id=u9', { fetchImpl });
  assert.equal(b.ok, true);
  assert.equal(b.balance, 3000);
  assert.deepEqual(b.buckets, { daily: 300, monthly: 0, reward: 2700, topup: 0 });
  assert.ok(calledUrl.startsWith('https://xiaohuanxiong.com/'), '请求必须打裸域');
  // API 只认 Bearer（issue #27）；裸 Cookie 头 = 401 authorization_empty（2026-10-15 实测坑）
  assert.equal(calledHeaders.Authorization, 'Bearer SECRET-TOKEN', '必须带 Authorization: Bearer <raccoon_token>');
  assert.match(calledHeaders.Cookie, /raccoon_token=SECRET-TOKEN/);
  assert.ok(!JSON.stringify(calledHeaders).includes('user_id=u9') === false, 'Cookie 原样随行');
});

test('fetchRaccoonBalance：401 → authExpired（code 200001 归会话失效）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ code: 200001, message: 'authorization_empty_error' }) });
  const b = await xhx.fetchRaccoonBalance('bad', { fetchImpl });
  assert.equal(b.ok, false);
  assert.equal(b.authExpired, true, '401 必须标 authExpired（推送线靠它降级 message 卡）');
});

test('fetchRaccoonBalance：结构变化（无 available_points）→ 带字段名的错误，不标 auth', async () => {
  const fetchImpl = async () => okRes({ code: 0, data: { weird_field: 1 } });
  const b = await xhx.fetchRaccoonBalance('c=1', { fetchImpl });
  assert.equal(b.ok, false);
  assert.ok(!b.authExpired);
  assert.match(b.error, /weird_field/);
});

test('fetchRaccoonIdentity：user_info 解析 id/name；失败返 null（fail-soft）', async () => {
  const good = await xhx.fetchRaccoonIdentity('c=1', { fetchImpl: async () => okRes({ code: 0, data: { id: 'u77', name: '小浣熊', email: 'a@b.com' } }) });
  assert.deepEqual(good, { id: 'u77', name: '小浣熊', email: 'a@b.com' });
  const bad = await xhx.fetchRaccoonIdentity('c=1', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(bad, null);
});

test('buildXhxQuotaPayload：Balance 汇总行 + 四条 detailOnly 腿（0 腿也出）', () => {
  const a = { id: 'x1', name: '办公小浣熊 (a@b.com)', token: 'c', uid: 'u77', meta: { raccoonSession: { id: 'u77', email: 'a@b.com' } } };
  const { source, payload } = xhx.buildXhxQuotaPayload(a, { balance: 3000, buckets: { daily: 300, monthly: 0, reward: 2700, topup: 0 } });
  assert.equal(source, 'xiaohuanxiong-u77');
  assert.deepEqual(Object.keys(payload.quotas), ['Balance', 'Daily', 'Monthly', 'Reward', 'Topup']);
  assert.equal(payload.quotas.Balance.total, 3000);
  assert.equal(payload.quotas.Balance.isCreditBalance, true);
  assert.equal(payload.quotas.Balance.summarizesDetail, true);
  for (const k of ['Daily', 'Monthly', 'Reward', 'Topup']) {
    assert.equal(payload.quotas[k].detailOnly, true, `${k} 必须是明细腿`);
    assert.equal(payload.quotas[k].isCreditBalance, true);
  }
  assert.equal(payload.quotas.Daily.total, 300);
  assert.equal(payload.quotas.Monthly.total, 0.000001, '0 腿给最小正数（10R positiveNumber）');
});

test('buildXhxQuotaPayload：authInvalid → message 状态卡，不回退旧快照', () => {
  const a = { id: 'x1', name: '小浣熊行', token: 'c', uid: 'u77', meta: { raccoonBalance: { amount: 3000 } } };
  const { payload } = xhx.buildXhxQuotaPayload(a, { authInvalid: true, error: '会话失效（HTTP 401）' });
  assert.match(payload.message, /会话失效/);
  assert.ok(!payload.quotas, '死会话不得带旧余额行');
  assert.ok(!JSON.stringify(payload).includes('3000'), '旧快照数字不得出现');
});

test('buildXhxQuotaPayload：无 liveData → 快照兜底出行（推送线网络失败不清卡）', () => {
  const a = { id: 'x1', name: '行', token: 'c', uid: 'u77', meta: { raccoonBalance: { amount: 1234, buckets: { daily: 0, monthly: 0, reward: 1234, topup: 0 } } } };
  const { payload } = xhx.buildXhxQuotaPayload(a, null);
  assert.equal(payload.quotas.Balance.total, 1234);
});

test('isAutoGeneratedName：办公小浣熊自动名家族（身份后缀）可升级、手改名受保护', async () => {
  assert.ok(cs.isAutoGeneratedName(site, '办公小浣熊网页会话'));
  assert.ok(cs.isAutoGeneratedName(site, '办公小浣熊 (a@b.com)'));
  assert.equal(cs.isAutoGeneratedName(site, '我的备用号'), false, '家族外名字 = 用户手改备注，任何路径不得覆盖');
});

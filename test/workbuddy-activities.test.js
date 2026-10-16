/**
 * WorkBuddy 临时活动批量领取（额外补偿 / 首月赠礼）——用已存 Bearer 凭据领，免逐个网页点击。
 * 覆盖：状态解析（active/claimed/credit_num）、幂等领取（已领/未激活不发领取请求）、
 * 批量端点只对可领项发请求。全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 干净配置目录 + 清代理环境变量：否则 fetchJsonRace 走 fetchViaProxy（绕开 fetch mock）
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-act-test-'));
process.env.CREDITDADDY_HOME = HOME;
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];

// 造一个可解析的 Keycloak 风格 JWT（exp 远期，避免 withToken 走刷新）
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_JWT = [b64({ alg: 'none' }), b64({ sub: 'u-1', iss: 'https://www.codebuddy.cn/auth', exp: Math.floor(Date.now() / 1000) + 3600 }), 'sig'].join('.');
const mkAccount = () => ({ id: 'wb-1', provider: 'workbuddy', name: '测试号', token: FAKE_JWT, uid: 'u-1', meta: { domain: 'www.codebuddy.cn' }, expiresAt: new Date(Date.now() + 3600_000).toISOString() });

// 全局 fetch 拦截：按路径回状态/领取响应
function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [pat, fn] of handlers) {
      if (u.includes(pat)) return fn(init, u);
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
  };
  return calls;
}
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });

const { fetchWbActivities, claimWbActivity } = await import('../src/workbuddyClient.js');

test('fetchWbActivities：解析补偿+赠礼状态（active/claimed/credit_num/claimable）', async () => {
  mockFetch([
    ['/billing/meter/compensation-status', () => jsonRes({ code: 0, msg: 'OK', data: { claimed: false, active: true, credit_num: 500, validity_period: 1, end_time: '2026-10-22 23:59:59' } })],
    ['/billing/meter/check-gift-claimed', () => jsonRes({ code: 0, msg: 'OK', data: { claimed: true, claimed_at: '2026-08-01 11:40:32', active: true, credit_num: 1500, validity_period: 1, start_time: '2026-04-01 00:00:00', end_time: '2026-10-31 23:59:59' } })],
  ]);
  const acts = await fetchWbActivities(mkAccount());
  const comp = acts.find((x) => x.kind === 'compensation');
  const gift = acts.find((x) => x.kind === 'gift');
  assert.equal(comp.active, true);
  assert.equal(comp.claimed, false);
  assert.equal(comp.creditNum, 500);
  assert.equal(comp.claimable, true, 'active && !claimed → 可领');
  assert.equal(gift.claimed, true);
  assert.equal(gift.claimable, false, '已领 → 不可领');
});

test('claimWbActivity：active && !claimed → 发领取请求，返回 checked-in + 积分数', async () => {
  const calls = mockFetch([
    ['/billing/meter/compensation-status', () => jsonRes({ code: 0, data: { claimed: false, active: true, credit_num: 500 } })],
    ['/billing/meter/claim-compensation', () => jsonRes({ code: 0, msg: 'OK' })],
  ]);
  const r = await claimWbActivity(mkAccount(), 'compensation');
  assert.equal(r.status, 'checked-in');
  assert.equal(r.claimedAmount, 500);
  assert.ok(calls.some((c) => c.url.includes('claim-compensation')), '必须发领取请求');
});

test('claimWbActivity：已领 → already，不发领取请求（幂等）', async () => {
  const calls = mockFetch([
    ['/billing/meter/compensation-status', () => jsonRes({ code: 0, data: { claimed: true, active: true, credit_num: 500 } })],
  ]);
  const r = await claimWbActivity(mkAccount(), 'compensation');
  assert.equal(r.status, 'already');
  assert.ok(!calls.some((c) => c.url.includes('claim-compensation')), '已领不得再发领取请求');
});

test('claimWbActivity：未激活 → no-activity，不发领取请求', async () => {
  const calls = mockFetch([
    ['/billing/meter/compensation-status', () => jsonRes({ code: 0, data: { claimed: false, active: false, credit_num: 500 } })],
  ]);
  const r = await claimWbActivity(mkAccount(), 'compensation');
  assert.equal(r.status, 'no-activity');
  assert.ok(!calls.some((c) => c.url.includes('claim-compensation')), '未激活不得发领取请求');
});

test('claimWbActivity：领取接口返非 0 code → failed（带服务端 msg）', async () => {
  mockFetch([
    ['/billing/meter/compensation-status', () => jsonRes({ code: 0, data: { claimed: false, active: true, credit_num: 500 } })],
    ['/billing/meter/claim-compensation', () => jsonRes({ code: 17153, msg: '活动已结束' })],
  ]);
  const r = await claimWbActivity(mkAccount(), 'compensation');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /活动已结束/);
});

test('claimWbActivity：领取接口 401 → failed（鉴权失效）', async () => {
  mockFetch([
    ['/billing/meter/compensation-status', () => jsonRes({ code: 0, data: { claimed: false, active: true, credit_num: 500 } })],
    ['/billing/meter/claim-compensation', () => jsonRes({}, 401)],
  ]);
  const r = await claimWbActivity(mkAccount(), 'compensation');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /鉴权失败/);
});

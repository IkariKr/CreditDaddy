/**
 * codearts（华为云码道，issue #40）测试：
 *  - COOKIE_SITES 站点注册：portal 域为会话主体，console/auth 一并收割
 *  - provider 注册表（PROVIDERS / productOf / PROVIDER_LABEL / productImpl 挂上 checkin+quota）
 *  - fetchCodeartsBalance：JSON=成功解析积分；HTML=会话失效；401=失效
 *  - checkinCodearts：成功 / HTTP 失败 / 会话失效分类
 * 端点事实源：2026-10-29 浏览器网络面板捕获（详见 codeartsClient.js 文件头）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-codearts-'));
process.env.CREDITDADDY_HOME = path.join(root, 'data');

const { COOKIE_SITES, getSite, siteForLoginUrl } = await import('../src/cookieSites.js');
const constants = await import('../src/constants.js');
const providers = await import('../src/providers.js');
const ca = await import('../src/codeartsClient.js');

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const htmlRes = (status = 200) => new Response('<!DOCTYPE html><html>', { status, headers: { 'content-type': 'text/html;charset=utf-8' } });

test('码道站点注册：portal 为主体会话域，登录链接可归户', () => {
  const site = getSite('codearts');
  assert.ok(site);
  assert.equal(site.provider, 'codearts');
  assert.ok(site.cookieUrls.includes('https://codearts.huaweicloud.com'), 'portal 域必须在收割名单（后端认它的 httpOnly 会话）');
  assert.ok(site.cookieUrls.includes('https://auth.huaweicloud.com'));
  assert.equal(siteForLoginUrl('https://codearts.huaweicloud.com/portal')?.id, 'codearts');
});

test('provider 注册表齐全，productImpl 挂上 checkin 与 quota', () => {
  assert.ok(constants.PROVIDERS.includes('codearts'));
  assert.equal(constants.productOf('codearts'), 'codearts');
  assert.equal(constants.PROVIDER_LABEL.codearts, '码道 CodeArts');
  const impl = providers.productImpl('codearts');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
});

test('fetchCodeartsBalance：JSON 解析积分三件套 + 即将到期', async () => {
  const body = { all_credit_package: { package_credit_amount: 4600, package_credit_used: 100, package_credit_remain: 4500, expiring_credit_amount: 100 } };
  let seenHeaders = null;
  const r = await ca.fetchCodeartsBalance('c=1', {
    fetchImpl: async (url, init) => { seenHeaders = init.headers; return jsonRes(body); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.total, 4600);
  assert.equal(r.used, 100);
  assert.equal(r.remain, 4500);
  assert.equal(r.expiring, 100);
  // 请求头契约：cftk 无源时为空串（不抛错）；语言与 XRW 头必备
  assert.equal(seenHeaders.cftk, '');
  assert.equal(seenHeaders['x-requested-with'], 'XMLHttpRequest');
  assert.equal(seenHeaders.language, 'zh-cn');
});

test('fetchCodeartsBalance：cftk 从 devclouddevuibjtcftk 提取 + HTML 判会话失效', async () => {
  let seen = null;
  const r1 = await ca.fetchCodeartsBalance('a=1; devclouddevuibjtcftk=TK-TK; b=2', {
    fetchImpl: async (url, init) => { seen = init.headers; return jsonRes({ all_credit_package: { package_credit_amount: 100, package_credit_used: 0, package_credit_remain: 100 } }); },
  });
  assert.equal(seen.cftk, 'TK-TK');
  assert.equal(r1.ok, true);

  const r2 = await ca.fetchCodeartsBalance('a=1', { fetchImpl: async () => htmlRes() });
  assert.equal(r2.ok, false);
  assert.equal(r2.authExpired, true, 'SPA fallback HTML 必须按会话失效分类');
});

test('checkinCodearts：delivery→claim 两步（可领=成功、已领=already、无活动=no-activity）', async () => {
  const cookie = 'a=1; devclouddevuibjtcftk=TK-TK';
  const daily = (over = {}) => ({ campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', triggerMode: 'MANUAL_CLAIM', claimable: true, status: 'ELIGIBLE', benefitAmount: 100, extra: { triggerEvent: 'user.login' }, ...over });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).includes('/ops/delivery')) return jsonRes({ code: 0, data: { items: [daily()] } });
    if (String(url).includes('/ops/events/trigger')) return jsonRes({ code: 0 });
    if (String(url).includes('/ops/claim')) return jsonRes({ code: 0, message: 'ok' });
    throw new Error('unexpected url ' + url);
  };
  const ok = await ca.checkinCodearts(cookie, { fetchImpl });
  assert.equal(ok.status, 'checked-in');
  assert.ok(calls.some((c) => c.url.includes('/ops/claim')));
  const claimCall = calls.find((c) => String(c.body || '').includes('"campaignId":34'));
  assert.ok(claimCall, 'claim 必须带 campaignId');
  const claimBody = JSON.parse(claimCall.body);
  assert.equal(claimBody.channel, 'PORTAL', 'claim 必须带 channel=PORTAL');
  assert.ok(/^[0-9a-f]{32}$/.test(claimBody.idempotentKey), 'claim 必须带 32hex idempotentKey（缺它 400 参数无效）');
  const trig = calls.find((c) => c.url.includes('/ops/events/trigger'));
  assert.ok(trig, 'claim 前先事件资格上报');
  const trigBody = JSON.parse(trig.body);
  assert.equal(trigBody.triggerEvent, 'user.login');
  assert.match(trigBody.idempotentKey, /^login-\d{8}-/, 'trigger 幂等键按日形状（与前端 m8c 同款）');
  assert.equal(trigBody.channel, 'PORTAL');

  // 已领（CLAIMED）→ already，不打 claim
  calls.length = 0;
  const al = await ca.checkinCodearts(cookie, { fetchImpl: async (url) => {
    calls.push({ url: String(url) });
    if (String(url).includes('/ops/delivery')) return jsonRes({ code: 0, data: { items: [daily({ claimable: false, status: 'CLAIMED' })] } });
    throw new Error('should not claim');
  } });
  assert.equal(al.status, 'already');
  assert.ok(!calls.some((c) => String(c.url).includes('/ops/claim')), '已领不得空枪 claim');

  // 活动不在列表 → no-activity
  const na = await ca.checkinCodearts(cookie, { fetchImpl: async () => jsonRes({ code: 0, data: { items: [] } }) });
  assert.equal(na.status, 'no-activity');
});

test('checkinCodearts：会话失效分类（HTML fallback / 401）', async () => {
  const dead1 = await ca.checkinCodearts('c=1', { fetchImpl: async () => htmlRes() });
  assert.equal(dead1.status, 'failed');
  assert.equal(dead1.authExpired, true);
  const dead2 = await ca.checkinCodearts('c=1', { fetchImpl: async () => new Response('unauth', { status: 401 }) });
  assert.equal(dead2.status, 'failed');
  assert.equal(dead2.authExpired, true);
});

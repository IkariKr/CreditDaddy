// Inception Labs 网页会话线测试——接口形状来自用户抓包（2026-10-20，dashboard/billing XHR）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-inception-'));

const ic = await import('../src/inceptionClient.js');

const USAGE_OK = {
  requests: 0, tokens: 0,
  metadata: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 12345 },
  limits: { requests: null, totalTokens: 100000000, inputTokens: 100000000, outputTokens: 100000000 },
  isFreeTier: true,
  freeTokenGrant: { total: 100000000, default: 100000000, isDefault: true, expiresAt: null },
  billingPeriod: { start: '2026-09-01T14:10:40.764Z', end: '2026-10-20T15:47:04.041Z' },
};

const mkRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('fetchInceptionUsage：正常解析（total/used/remaining，expiresAt 缺省为 null）', async () => {
  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => { seen = { url: String(url), headers: init.headers }; return mkRes(USAGE_OK); };
  try {
    const u = await ic.fetchInceptionUsage('session=ABC');
    assert.equal(u.ok, true);
    assert.equal(u.total, 100000000);
    assert.equal(u.used, 12345);
    assert.equal(u.remaining, 100000000 - 12345);
    assert.equal(u.expiresAt, null);
    assert.equal(u.isFreeTier, true);
    assert.match(seen.url, /api\/usage\?quota=1/);
    assert.equal(seen.headers.Cookie, 'session=ABC');
  } finally { globalThis.fetch = real; }
});

test('fetchInceptionUsage：401 → auth 失效', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const u = await ic.fetchInceptionUsage('bad');
    assert.equal(u.ok, false);
    assert.equal(u.auth, true);
  } finally { globalThis.fetch = real; }
});

test('fetchInceptionUsage：Cloudflare 拦截页（200 HTML）→ 解析失败而非误报成功', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>Attention Required! | Cloudflare</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  try {
    const u = await ic.fetchInceptionUsage('x');
    assert.equal(u.ok, false);
    assert.match(u.error, /无法解析|代理/);
  } finally { globalThis.fetch = real; }
});

test('inception 在 PROVIDERS 白名单且 cookieSites 配置齐备（收割上报回归钉子）', async () => {
  const { PROVIDERS } = await import('../src/constants.js');
  const { COOKIE_SITES } = await import('../src/cookieSites.js');
  assert.ok(PROVIDERS.includes('inception'));
  const site = COOKIE_SITES.find((s) => s.id === 'inception');
  assert.ok(site, 'inception 站点配置存在');
  assert.equal(site.provider, 'inception');
  assert.ok(site.probe.url.includes('/api/usage'));
});

test('buildInceptionQuotaPayload：正常数据 → tokens 计数卡（source 单号后缀）', async () => {
  const r = await import('../src/inceptionClient.js');
  const { source, payload } = r.buildInceptionQuotaPayload(
    { id: 'acc-1', name: 'Inception 主号' },
    { used: 12345, total: 100000000, remaining: 100000000 - 12345, expiresAt: null },
  );
  assert.match(source, /^inception-[a-z0-9-]+$/);
  assert.equal(payload.provider, 'inception');
  assert.equal(payload.plan, 'Free');
  const row = payload.quotas.q0;
  assert.equal(row.total, 100000000);
  assert.equal(row.used, 12345);
  assert.equal(row.displayRemaining, true);
});

test('buildInceptionQuotaPayload：无 live 无快照 → message 状态卡（不误报 0 余额）', async () => {
  const r = await import('../src/inceptionClient.js');
  const { payload } = r.buildInceptionQuotaPayload({ id: 'acc-2', name: 'X' }, null);
  assert.ok(payload.message);
  assert.equal(payload.quotas, undefined);
});

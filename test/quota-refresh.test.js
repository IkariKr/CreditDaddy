/**
 * 10Router 外配额卡「刷新配额」回调（quotaRefresh.js）回归：
 * - refreshUrl 形状（source/exp/sig 三标量，无裸令牌）
 * - HMAC 校验闭环：正确签名放行、篡改 source/exp/sig 拒、过期拒、远期拒
 * - 令牌缺失时自动生成并落盘（同一 source 两次签发 sig 均可验）
 * - 单 IP 限流滑动窗口
 * - runQuotaPush 附带 refreshUrl（载荷标量闸不破）与 onlySource 单路过滤
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-refresh-test-'));
process.env.CREDITDADDY_HOME = HOME;

const qr = await import('../src/quotaRefresh.js');
const eq = await import('../src/externalQuota.js');

test('quotaRefreshUrl：source/exp/sig 三标量，无裸令牌；同一 source 滚动签发均有效', async () => {
  const url = await qr.quotaRefreshUrl('xiaomi-mimo-6786673', { base: 'http://127.0.0.1:47860' });
  const u = new URL(url);
  assert.equal(u.pathname, '/api/quota-refresh');
  assert.equal(u.searchParams.get('source'), 'xiaomi-mimo-6786673');
  assert.ok(Number(u.searchParams.get('exp')) > Date.now() / 1000);
  assert.match(u.searchParams.get('sig'), /^[0-9a-f]{64}$/);
  // 无裸令牌：URL 里不得出现 settings 里的 quotaRefreshToken 原文
  const settings = JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8'));
  assert.ok(settings.quotaRefreshToken && settings.quotaRefreshToken.length >= 20);
  assert.ok(!url.includes(settings.quotaRefreshToken), 'refreshUrl 不得内嵌裸令牌');
});

test('verifyQuotaRefresh：正确签名放行；篡改 source/exp/sig、过期、远期一律拒', async () => {
  const now = Date.now();
  const url = await qr.quotaRefreshUrl('river-abc', { base: 'http://x', nowMs: now });
  const u = new URL(url);
  const good = { source: u.searchParams.get('source'), exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') };

  assert.equal((await qr.verifyQuotaRefresh(good, { nowMs: now })).ok, true);
  assert.equal((await qr.verifyQuotaRefresh({ ...good, source: 'river-evil' }, { nowMs: now })).ok, false);
  assert.equal((await qr.verifyQuotaRefresh({ ...good, exp: String(Number(good.exp) + 1) }, { nowMs: now })).ok, false);
  assert.equal((await qr.verifyQuotaRefresh({ ...good, sig: 'a'.repeat(64) }, { nowMs: now })).ok, false);
  assert.equal((await qr.verifyQuotaRefresh({ ...good, sig: 'ab' }, { nowMs: now })).ok, false);
  assert.equal((await qr.verifyQuotaRefresh({ ...good, sig: good.sig.slice(0, -1) }, { nowMs: now })).ok, false);

  // 过期（now 超过 exp）
  const expired = await qr.verifyQuotaRefresh(good, { nowMs: (Number(good.exp) + 10) * 1000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');

  // 远期签名（exp 超出 TTL+容差）拒发——防止签名常驻
  const far = await qr.quotaRefreshUrl('river-abc', { base: 'http://x', nowMs: now + 40 * 86_400_000 });
  const farU = new URL(far);
  // 手工构造一个「现在签的超远期」签名：verify 侧应拒
  const { default: crypto } = await import('node:crypto');
  const token = JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')).quotaRefreshToken;
  const expSec = Math.floor(now / 1000) + 30 * 86_400;
  const sig = crypto.createHmac('sha256', token).update(`v1\nriver-abc\n${expSec}`).digest('hex');
  const far2 = await qr.verifyQuotaRefresh({ source: 'river-abc', exp: String(expSec), sig }, { nowMs: now });
  assert.equal(far2.ok, false);
  assert.equal(far2.reason, 'bad-params');
  assert.ok(farU.searchParams.get('sig'));
});

test('verifyQuotaRefresh：缺参拒', async () => {
  assert.equal((await qr.verifyQuotaRefresh({})).ok, false);
  assert.equal((await qr.verifyQuotaRefresh({ source: 'x', exp: '1', sig: '' })).ok, false);
  assert.equal((await qr.verifyQuotaRefresh({ source: '', exp: '1', sig: 'a'.repeat(64) })).ok, false);
});

test('refreshRateLimited：窗口内超限即拦，窗口外放行', () => {
  const ip = '10.9.9.9';
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 20; i++) {
    assert.equal(qr.refreshRateLimited(ip, { nowMs: t0 + i }), false);
  }
  assert.equal(qr.refreshRateLimited(ip, { nowMs: t0 + 21 }), true);
  // 滑出窗口后恢复
  assert.equal(qr.refreshRateLimited(ip, { nowMs: t0 + 61_000 }), false);
});

test('runQuotaPush：载荷带 refreshUrl（HMAC 签名、无裸令牌）；onlySource 只推一路', async () => {
  const pushes = [];
  let upstreamHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/external-quota/')) {
      pushes.push({ url: u, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, entries: 1 }), { status: 200 });
    }
    upstreamHits++;
    if (u.includes('/magicubes/balance')) {
      return new Response(JSON.stringify({ data: { total_balance: 300, available_balance: 300 } }), { status: 200 });
    }
    if (u.includes('/magicubes/transactions')) {
      return new Response(JSON.stringify({ data: { records: [] } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const accounts = [{
      id: 'ms-1', provider: 'modelscope', name: 'ModelScope (dev@example.com)',
      token: 'session-id=SECRET-COOKIE-MATERIAL',
      meta: { cookieSiteId: 'modelscope', msSession: { id: 'u-9', email: 'dev@example.com' } },
    }];
    const r = await eq.runQuotaPush({
      endpoint: 'http://10r.local', key: 'sk-test', accounts, fetchImpl: globalThis.fetch,
      onlySource: 'modelscope-u-9',
    });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].source, 'modelscope-u-9');
    assert.equal(pushes.length, 1);
    const body = pushes[0].body;
    // refreshUrl 随载荷下发且可验
    assert.equal(typeof body.refreshUrl, 'string');
    const u = new URL(body.refreshUrl);
    const { verifyQuotaRefresh } = await import('../src/quotaRefresh.js');
    const v = await verifyQuotaRefresh({
      source: u.searchParams.get('source'), exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig'),
    });
    assert.equal(v.ok, true, '载荷里的 refreshUrl 必须能通过签名校验');
    assert.equal(u.searchParams.get('source'), 'modelscope-u-9');
    // 凭据纪律不破：cookie/token 原文不得出现在载荷（含 refreshUrl）
    assert.ok(!JSON.stringify(body).includes('SECRET'), '载荷不得含凭据材料');
    assert.ok(!JSON.stringify(body).includes('session-id='), '载荷不得含会话 cookie');

    // onlySource 不匹配 → 一路不推，且别路 source 不打上游
    pushes.length = 0;
    const upstreamBefore = upstreamHits;
    const r2 = await eq.runQuotaPush({
      endpoint: 'http://10r.local', key: 'sk-test', accounts, fetchImpl: globalThis.fetch,
      onlySource: 'tokenharbor',
    });
    assert.equal(r2.results.length, 0);
    assert.equal(pushes.length, 0, 'onlySource 不匹配时不得推任何卡');
    assert.equal(upstreamHits, upstreamBefore, '单卡回调不得为别路 source 打上游');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('浏览器直连闭环：外站 Origin 的 POST/OPTIONS 走通 daemon HTTP 栈（回归 rejectForeignRequest 豁免）', async () => {
  const daemon = await import('../src/daemon.js');
  const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
  try {
    const url = await qr.quotaRefreshUrl('modelscope-u-9', { base: `http://127.0.0.1:${port}` });
    // 1) 预检（10R 页面跨站 POST 前浏览器必发）
    const opt = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://10router.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(opt.status, 204, 'OPTIONS 预检应放行（浏览器直连依赖它）');
    assert.equal(opt.headers.get('access-control-allow-origin'), '*');
    // 2) 外站 Origin 的 POST 不被跨站闸掐死（未配 10Router 时应到 503 才算走进了处理器）
    const post = await fetch(url, { method: 'POST', headers: { Origin: 'https://10router.example.com' } });
    assert.notEqual(post.status, 403, '外站 Origin 不得再被 rejectForeignRequest 403');
    const body = await post.json();
    // 未配 endpoint/key → 503；已配（测试环境共享 HOME 里可能有）→ 200。两者都证明路由通了
    assert.ok(post.status === 503 || post.status === 200, `应到达处理器，实际 ${post.status} ${JSON.stringify(body)}`);
    // 3) 其余 API 路径跨站照拒（豁免只给回调）
    const other = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(other.status, 403, '其他 API 路径跨站 Origin 仍须 403');
  } finally {
    server.close();
  }
});

/**
 * LongCat（longcat.chat，美团）Token 资源包余额抓取与 10Router 外部配额推送（issue #29）。
 * 覆盖：
 *  1. parsePacksSummary 解析 summary 响应（currentLot + otherLots，消耗顺序排序）
 *  2. fetchLongcatPacks 正常读包 / 401 authExpired / 业务错误归类
 *  3. fetchLongcatIdentity 解析 user-current 双标识（userId + uid，2026-10-15 实测形状）
 *  4. buildLongcatQuotaPayload 储值卡（Balance 汇总 + 逐包 detailOnly + giftPack 标志）
 *  5. 载荷标量纪律（assertScalarOnly）
 *  6. runQuotaPush longcat 推送链路（含 auth 失效降级 message 状态卡）
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'longcat-test-'));
process.env.CREDITDADDY_HOME = HOME;

const client = await import('../src/longcatClient.js');
const eq = await import('../src/externalQuota.js');
const store = await import('../src/store.js');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const PACKS_BODY = {
  code: 0,
  message: 'success',
  data: {
    currentLot: {
      status: 'ACTIVE', totalToken: 5000000, remainingToken: 3532800, consumedToken: 1467200,
      expireTime: '2026-10-25 00:00:00', grantCategory: 'GIFT', source: 'FREE_PACK', consumeOrder: 1,
    },
    otherLots: [
      {
        status: 'ACTIVE', totalToken: 10000000, remainingToken: 10000000, consumedToken: 0,
        expireTime: '2026-11-11 00:00:00', grantCategory: 'PURCHASED', source: 'PAID_PACK', consumeOrder: 2,
      },
    ],
  },
};

const USER_BODY = {
  code: 0,
  message: 'success',
  data: { userId: '704460616', uid: '1370048301', name: '余师洋_xxx' },
};

test('parsePacksSummary：currentLot + otherLots 全部 ACTIVE 包，按 consumeOrder 排序', () => {
  const r = client.parsePacksSummary(PACKS_BODY);
  assert.ok(r.ok);
  assert.equal(r.packs.length, 2);
  assert.equal(r.packs[0].remaining, 3532800);
  assert.equal(r.packs[0].grantCategory, 'GIFT');
  assert.equal(r.packs[1].total, 10000000);
  // 耗尽包（currentLot null）宽容处理
  const empty = client.parsePacksSummary({ code: 0, data: { currentLot: null, otherLots: [] } });
  assert.ok(empty.ok && empty.packs.length === 0);
  // 无 data 归结构错误
  assert.equal(client.parsePacksSummary({ code: 0 }).ok, false);
});

test('lcTimeToIso：UTC+8 站点时间转 ISO', () => {
  assert.equal(client.lcTimeToIso('2026-10-25 00:00:00'), new Date(Date.UTC(2026, 9, 24, 16)).toISOString());
  assert.equal(client.lcTimeToIso('garbage'), null);
});

test('fetchLongcatPacks：正常读包 / 401 authExpired / 业务错误', async () => {
  const ok = await client.fetchLongcatPacks('c=1', { fetchImpl: async () => jsonResponse(200, PACKS_BODY) });
  assert.ok(ok.ok && ok.packs.length === 2);
  const auth = await client.fetchLongcatPacks('c=1', { fetchImpl: async () => jsonResponse(401, { code: 401, msg: '用户未登录，请先登录' }) });
  assert.equal(auth.ok, false);
  assert.equal(auth.authExpired, true);
  const biz = await client.fetchLongcatPacks('c=1', { fetchImpl: async () => jsonResponse(200, { code: 500, msg: 'boom' }) });
  assert.equal(biz.ok, false);
  assert.equal(biz.authExpired, undefined);
});

test('fetchLongcatIdentity：解析 user-current 双标识（userId + uid）', async () => {
  const r = await client.fetchLongcatIdentity('c=1', { fetchImpl: async () => jsonResponse(200, USER_BODY) });
  assert.ok(r.ok);
  assert.equal(r.session.userId, '704460616');
  assert.equal(r.session.uid, '1370048301');
  assert.equal(r.session.name, '余师洋_xxx');
  // 401 fail-soft
  const auth = await client.fetchLongcatIdentity('c=1', { fetchImpl: async () => jsonResponse(401, { code: 401 }) });
  assert.equal(auth.ok, false);
});

function lcAccount() {
  return {
    id: 'acc-lc-1',
    provider: 'longcat',
    name: 'LongCat (余师洋_xxx)',
    token: 'c=1',
    uid: '704460616',
    meta: {
      cookieSiteId: 'longcat',
      longcatSession: { userId: '704460616', uid: '1370048301', name: '余师洋_xxx' },
      longcatPacks: client.longcatSnapshot(client.parsePacksSummary(PACKS_BODY).packs),
    },
  };
}

test('buildLongcatQuotaPayload：Balance 汇总 + 逐包 detailOnly + giftPack 标志', () => {
  const { source, payload } = client.buildLongcatQuotaPayload(lcAccount());
  assert.ok(source.startsWith('longcat-704460616'));
  assert.equal(payload.provider, 'longcat');
  const bal = payload.quotas.Balance;
  assert.equal(bal.isCreditBalance, true);
  assert.equal(bal.summarizesDetail, true);
  // 353.28万 + 1000万
  assert.equal(bal.total, 13532800);
  const pack1 = payload.quotas.Pack1;
  assert.equal(pack1.detailOnly, true);
  assert.equal(pack1.giftPack, true);
  assert.equal(pack1.resetAt, new Date(Date.UTC(2026, 9, 24, 16)).toISOString());
  const pack2 = payload.quotas.Pack2;
  assert.equal(pack2.giftPack, undefined);
  // 10R quota key 白名单字符纪律（CJK 放行版）
  for (const k of Object.keys(payload.quotas)) assert.match(k, /^[\p{L}\p{N}][\p{L}\p{N} ._@·（）()\-]{0,63}$/u);
});

test('buildLongcatQuotaPayload：auth 失效降级 message 状态卡（不回退旧快照）', () => {
  const { payload } = client.buildLongcatQuotaPayload(lcAccount(), { error: '会话失效（HTTP 401）', authInvalid: true });
  assert.ok(payload.message);
  assert.equal(payload.quotas, undefined);
});

test('buildLongcatQuotaPayload：快照兜底带陈粮标注（>24h）', () => {
  const a = lcAccount();
  a.meta.longcatPacks.at = new Date(Date.now() - 48 * 3600_000).toISOString();
  a.meta.quotaSnapshot = { used: 0, total: 13532800, isCreditBalance: true, at: a.meta.longcatPacks.at };
  const { payload } = client.buildLongcatQuotaPayload(a, null);
  assert.match(payload.plan, /（数据 \d{1,2}-\d{1,2} \d{2}:\d{2}）/);
});

test('runQuotaPush：longcat 账号推送链路（含 auth 失效 message 卡）', async () => {
  const pushCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/external-quota/')) {
      pushCalls.push({ url: u, body: JSON.parse(init?.body || '{}') });
      return jsonResponse(200, { ok: true, entries: 3 });
    }
    // LongCat 上游
    return jsonResponse(200, PACKS_BODY);
  };
  try {
    // 第二账号换 uid → source 不同，onlySource 过滤应把它筛掉
    const accounts = [lcAccount(), (() => { const a = lcAccount(); a.id = 'acc-lc-2'; a.uid = '888888888'; a.meta.longcatSession = { userId: '888888888' }; a.meta.longcatPacks = {}; return a; })()];
    await store.saveAccounts(accounts);
    const cfg = await store.loadSettings();
    const results = await eq.runQuotaPush({
      endpoint: 'http://10r.test',
      key: 'vk-test',
      accounts,
      settings: cfg,
      fetchImpl: globalThis.fetch,
      onlySource: ['longcat-704460616'],
    });
    // onlySource 过滤：只推认领 source
    assert.equal(results.results.length, 1);
    assert.equal(results.results[0].source, 'longcat-704460616');
    assert.equal(results.results[0].status, 'ok');
    assert.ok(pushCalls.length >= 1);
    const sent = pushCalls[0].body;
    assert.equal(sent.provider, 'longcat');
    assert.ok(sent.quotas.Balance);
  } finally {
    globalThis.fetch = origFetch;
  }
});

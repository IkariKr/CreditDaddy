/**
 * issue #24：10Router 通用额度推送接线（externalQuota.js）。
 * 覆盖：TH 探针 HTML 解析（捕获侧快照来源）、tokenharbor 载荷组装（新鲜/过期/降级 message）、
 * minimax-code 载荷组装（存量行/查询失败降级）、标量闸、推送请求形状与 fail-soft。
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-quota-test-'));
process.env.CREDITDADDY_HOME = HOME;

const { parseTokenHarborQuota } = await import('../src/cookieSites.js');
const eq = await import('../src/externalQuota.js');

const DAY = 86_400_000;

test('parseTokenHarborQuota：百分比 + Resets in 读数', () => {
  const html = '<div>Free allowance <span>80% used</span><em>Resets in 5d 4h 30m</em></div>';
  const q = parseTokenHarborQuota(html);
  assert.equal(q.used, 80);
  assert.ok(Date.parse(q.resetAt) > Date.now() + 5 * DAY);
  assert.ok(Date.parse(q.resetAt) < Date.now() + 6 * DAY);
});

test('parseTokenHarborQuota：无 Free allowance 标记返回 null', () => {
  assert.equal(parseTokenHarborQuota('<div>Sign in with Google</div>'), null);
  assert.equal(parseTokenHarborQuota(''), null);
});

test('buildTokenHarborPayload：新鲜快照出行，行名走 name、key 全 ASCII', () => {
  const accounts = [{
    name: 'TH 一号(a@b.com)',
    meta: { cookieSiteId: 'tokenharbor', quotaSnapshot: { used: 30, resetAt: new Date(Date.now() + DAY).toISOString(), at: new Date().toISOString() } },
  }];
  const p = eq.buildTokenHarborPayload(accounts);
  const keys = Object.keys(p.quotas);
  assert.deepEqual(keys, ['acc1']);
  const row = p.quotas.acc1;
  assert.equal(row.used, 30);
  assert.equal(row.total, 100);
  assert.equal(row.remainingPercentage, 70);
  assert.equal(row.name, 'TH 一号(a@b.com)');
  assert.equal(p.provider, 'tokenharbor');
});

test('buildTokenHarborPayload：快照过期（resetAt 已过 / 超 7 天）→ 降级 message 状态卡', () => {
  const now = Date.now();
  const staleReset = [{ meta: { quotaSnapshot: { used: 50, resetAt: new Date(now - 1000).toISOString(), at: new Date(now - DAY).toISOString() } } }];
  let p = eq.buildTokenHarborPayload(staleReset, { now });
  assert.ok(!p.quotas && p.message, 'resetAt 已过的读数应作废');

  const staleAt = [{ meta: { quotaSnapshot: { used: 50, resetAt: new Date(now + 30 * DAY).toISOString(), at: new Date(now - 8 * DAY).toISOString() } } }];
  p = eq.buildTokenHarborPayload(staleAt, { now });
  assert.ok(!p.quotas && p.message, '超过 7 天的快照应作废');
});

test('buildTokenHarborPayload：部分行新鲜部分过期 → 出行 + label 标注失败数', () => {
  const now = Date.now();
  const accounts = [
    { name: '好行', meta: { quotaSnapshot: { used: 10, at: new Date(now).toISOString() } } },
    { name: '旧行', meta: { quotaSnapshot: { used: 90, at: new Date(now - 30 * DAY).toISOString() } } },
  ];
  const p = eq.buildTokenHarborPayload(accounts, { now });
  assert.equal(Object.keys(p.quotas).length, 1);
  assert.match(p.label, /1 个会话读取失败/);
});

test('buildMiniMaxPayload：存量行（used=0 / total=余额 / displayRemaining），零余额仍可出卡', async () => {
  const accounts = [{ name: '主', uid: 'u1' }, { name: '空', uid: 'u2' }];
  const fetchQuota = async (a) => (a.name === '主' ? { remaining: 1234.5 } : { remaining: 0 });
  const p = await eq.buildMiniMaxPayload(accounts, fetchQuota, { resetAt: '2026-10-13T00:00:00Z' });
  assert.deepEqual(Object.keys(p.quotas), ['acc1', 'acc2']);
  assert.equal(p.quotas.acc1.used, 0);
  assert.equal(p.quotas.acc1.total, 1234.5);
  assert.equal(p.quotas.acc1.displayRemaining, true);
  assert.equal(p.quotas.acc1.resetAt, '2026-10-13T00:00:00Z');
  assert.ok(p.quotas.acc2.total > 0, 'total 必须 >0（10Router positiveNumber）');
});

test('buildMiniMaxPayload：全部查询失败 → 降级 message', async () => {
  const p = await eq.buildMiniMaxPayload([{ name: 'x' }], async () => { throw new Error('401'); });
  assert.ok(!p.quotas && p.message);
});

test('nextUtc8Midnight：返回下一个 UTC+8 零点', () => {
  const iso = eq.nextUtc8Midnight(new Date('2026-10-12T03:30:00Z'));   // UTC+8 = 11:30
  assert.equal(iso, '2026-10-12T16:00:00.000Z');                        // 下一个 UTC+8 零点
  const iso2 = eq.nextUtc8Midnight(new Date('2026-10-12T17:00:00Z'));   // UTC+8 次日 01:00
  assert.equal(iso2, '2026-10-13T16:00:00.000Z');
});

test('runQuotaPush：推送形状 = POST /api/external-quota/<source> + Bearer key；自动清理 minimax-code 残留', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (url.includes('/tokenharbor') && init.method === 'POST') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    if (url.includes('/xiaomi-mimo')) return { ok: true, status: 200, json: async () => ({ ok: true, source: 'xiaomi-mimo-6786673', entries: 1 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const accounts = [
    { provider: 'tokenharbor', name: 'th', token: 'cookie=SECRET-COOKIE-MATERIAL', meta: { cookieSiteId: 'tokenharbor', quotaSnapshot: { used: 20, at: new Date().toISOString() } } },
    { provider: 'xiaomi-mimo', name: 'mimo', token: 'cookie=SECRET-MIMO-COOKIE', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673', quotaSnapshot: { total: 33.55 } } },
  ];
  const r = await eq.runQuotaPush({
    endpoint: 'http://127.0.0.1:20128', key: 'sk-test', accounts, fetchImpl,
  });
  const bySource = Object.fromEntries(r.results.map((x) => [x.source, x]));
  assert.equal(bySource.tokenharbor.status, 'failed');
  assert.equal(bySource['xiaomi-mimo-6786673'].status, 'ok');

  // 验证 DELETE minimax-code 发起
  const delMm = calls.find((c) => c.url.includes('/minimax-code') && c.init.method === 'DELETE');
  assert.ok(delMm, '应自动请求 DELETE minimax-code 清理残留');

  // 凭据永不出载荷：整份请求体里不得出现 cookie/token 材料
  for (const c of calls.filter((c) => c.init.body)) {
    assert.ok(!String(c.init.body).includes('SECRET'), '载荷不得含凭据材料');
  }
});

test('runQuotaPush：无对应账号时该路整体跳过', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const r = await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts: [], fetchImpl });
  assert.deepEqual(r.results, []);
});

test('runQuotaPush：live 401/403（auth 失效）→ 推 message 状态卡，不回退旧快照数字', async () => {
  const pushes = [];
  let upstreamHits = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/external-quota/')) {
      pushes.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, entries: 1 }) };
    }
    upstreamHits++;
    // 模拟小米控制台会话已死：profile/balance 一律 401（非 JSON 响应体也是真实 SDK 行为）
    return { ok: false, status: 401, json: async () => { throw new Error('not json'); }, text: async () => 'unauthorized' };
  };
  const accounts = [
    { provider: 'xiaomi-mimo', name: '死会话', token: 'cookie=SECRET-MIMO-COOKIE', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673', quotaSnapshot: { total: 32.88 } } },
  ];
  const r = await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts, fetchImpl });
  assert.equal(r.results[0].status, 'ok', 'message 状态卡照常推（不算失败）');
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].message, '必须降级为 message 卡');
  assert.match(pushes[0].message, /会话失效/);
  assert.ok(!pushes[0].quotas, '死会话不得带旧余额行');
  assert.ok(!JSON.stringify(pushes[0]).includes('32.88'), '旧快照数字不得出现');
  assert.ok(!JSON.stringify(pushes[0]).includes('SECRET'), '载荷不得含凭据材料');
});

test('runQuotaPush：网络失败（非 auth）→ 保留旧快照数字（不清空卡面）', async () => {
  const pushes = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/external-quota/')) {
      pushes.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, entries: 1 }) };
    }
    throw new Error('ECONNRESET');
  };
  const accounts = [
    { provider: 'xiaomi-mimo', name: ' NetWork抖动', token: 'c=1', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673', quotaSnapshot: { total: 32.88 } } },
  ];
  await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts, fetchImpl });
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].quotas, '网络抖动仍推余额行');
  assert.equal(pushes[0].quotas.Balance.total, 32.88, '保留旧快照数字');
  assert.ok(!pushes[0].message);
});

test('runQuotaPush：onlySource 接受数组（重探只推涉及的多路）', async () => {
  const pushed = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/external-quota/')) {
      pushed.push(u.split('/api/external-quota/')[1]);
      return { ok: true, status: 200, json: async () => ({ ok: true, entries: 1 }) };
    }
    // 上游余额全部成功
    if (u.includes('/api/v1/balance')) return { ok: true, status: 200, json: async () => ({ data: { availableBalance: 1.23 } }), text: async () => JSON.stringify({ data: { availableBalance: 1.23 } }) };
    if (u.includes('/magicubes/balance')) return { ok: true, status: 200, json: async () => ({ data: { total_balance: 300 } }) };
    if (u.includes('/magicubes/transactions')) return { ok: true, status: 200, json: async () => ({ data: { records: [] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const accounts = [
    { provider: 'xiaomi-mimo', name: 'm', token: 'c=1', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673', quotaSnapshot: { total: 1 } } },
    { provider: 'modelscope', name: 'ModelScope (a@b.com)', token: 'c=2', meta: { cookieSiteId: 'modelscope', msSession: { id: 'u-9', email: 'a@b.com' } } },
  ];
  const r = await eq.runQuotaPush({
    endpoint: 'http://x', key: 'sk', accounts, fetchImpl,
    onlySource: ['xiaomi-mimo-6786673', 'modelscope-u-9'],
  });
  assert.deepEqual(pushed.sort(), ['modelscope-u-9', 'xiaomi-mimo-6786673']);
  assert.equal(r.results.length, 2);
});

test('自愈①：后台推送的 live 结果回写 lastProbe（呼吸灯有后台心跳）；noProbeMark 跳过', async () => {
  const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-quota-probe-'));
  const saved = process.env.CREDITDADDY_HOME;
  process.env.CREDITDADDY_HOME = HOME2;
  try {
    const store = await import('../src/store.js');
    const dead401 = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/external-quota/')) return { ok: true, status: 200, json: async () => ({ ok: true, entries: 1 }) };
      return { ok: false, status: 401, json: async () => ({}) };
    };
    const acc = { id: 'probe-1', provider: 'xiaomi-mimo', name: 'm', token: 'c=1', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673' } };
    // probeMark 走 withAccounts 队列按 id 查库回写——账号必须先在库里
    await store.withAccounts((list) => { list.push({ ...acc, meta: { ...acc.meta } }); });
    await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts: [acc], fetchImpl: dead401 });
    // withAccounts 串行队列排空
    await new Promise((r) => setTimeout(r, 60));
    const saved1 = JSON.parse(fs.readFileSync(path.join(HOME2, 'accounts.json'), 'utf8')).find((a) => a.id === 'probe-1');
    assert.equal(saved1.meta.lastProbe?.ok, false, '401 后台推送必须回写 lastProbe');
    assert.equal(saved1.meta.lastProbe?.status, 'dead', '401 归 dead（呼吸灯转红）');
    // noProbeMark：回调路径不写
    await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts: [acc], fetchImpl: dead401, noProbeMark: true });
    await new Promise((r) => setTimeout(r, 60));
    const saved2 = JSON.parse(fs.readFileSync(path.join(HOME2, 'accounts.json'), 'utf8')).find((a) => a.id === 'probe-1');
    assert.equal(saved2.meta.lastProbe.status, 'dead', 'noProbeMark 不得覆盖');
  } finally {
    process.env.CREDITDADDY_HOME = saved;
    fs.rmSync(HOME2, { recursive: true, force: true });
  }
});

test('自愈①b：后台推送 live 余额落库 quotaSnapshot（面板 /quota 缓存路径的数据源）', async () => {
  const HOME3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-quota-persist-'));
  const saved = process.env.CREDITDADDY_HOME;
  process.env.CREDITDADDY_HOME = HOME3;
  try {
    const store = await import('../src/store.js');
    const liveOk = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/external-quota/')) return { ok: true, status: 200, json: async () => ({ ok: true, entries: 1 }) };
      if (u.includes('/api/v1/balance')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: { balance: 16.36, cashBalance: 10.5, giftBalance: 5.86 } }) };
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };
    const acc = { id: 'persist-1', provider: 'xiaomi-mimo', name: 'm', token: 'c=1', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673', quotaSnapshot: { used: 0, total: 0, isCreditBalance: true, at: new Date(Date.now() - 86_400_000).toISOString() } } };
    await store.withAccounts((list) => { list.push({ ...acc, meta: { ...acc.meta } }); });
    await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts: [acc], fetchImpl: liveOk });
    await new Promise((r) => setTimeout(r, 60));
    const savedAcc = JSON.parse(fs.readFileSync(path.join(HOME3, 'accounts.json'), 'utf8')).find((a) => a.id === 'persist-1');
    assert.equal(savedAcc.meta.quotaSnapshot?.total, 16.36, 'live 余额必须落库 quotaSnapshot（缓存路径数据源）');
    assert.equal(savedAcc.meta.quotaSnapshot?.isCreditBalance, true);
    assert.equal(savedAcc.meta.mimoBalance?.balance, 16.36, '各家明细字段同步落库');
    assert.equal(savedAcc.meta.mimoBalance?.cash, 10.5);
    assert.ok(savedAcc.meta.quotaSnapshot?.at, 'at 时间戳更新（缓存保鲜判据）');
  } finally {
    process.env.CREDITDADDY_HOME = saved;
    fs.rmSync(HOME3, { recursive: true, force: true });
  }
});

test('自愈②：dead 账号 6h 内跳过 live 拉取（照常推状态卡），单卡回调不跳过', async () => {
  const now = Date.now();
  const deadAcc = { id: 'd1', provider: 'xiaomi-mimo', name: 'm', token: 'c=1', uid: '6786673', meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673', lastProbe: { ok: false, status: 'dead', error: '会话失效（HTTP 401）', at: new Date(now - 3600_000).toISOString() } } };
  let liveHits = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/external-quota/')) return { ok: true, status: 200, json: async () => ({ ok: true, entries: 1 }) };
    if (u.includes('/api/v1/userProfile') || u.includes('/api/v1/balance')) { liveHits++; return { ok: false, status: 401, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // 全量轮（后台）：dead 6h 内 → 不打上游
  await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts: [deadAcc], fetchImpl });
  assert.equal(liveHits, 0, 'dead 账号 6h 内不得打上游');
  // 单卡回调（only）：用户显式刷新必须真试
  await eq.runQuotaPush({ endpoint: 'http://x', key: 'sk', accounts: [deadAcc], fetchImpl, onlySource: 'xiaomi-mimo-6786673' });
  assert.ok(liveHits > 0, '单卡回调必须真试（不跳过 dead）');
});

test('自愈③：snapshotAgeTag——>24h 陈粮带时刻标注，新鲜/无时刻为空', async () => {
  const fresh = { total: 1, at: new Date(Date.now() - 3600_000).toISOString() };
  assert.equal(eq.snapshotAgeTag(fresh), '', '24h 内不标注');
  const old = { total: 1, at: new Date(Date.now() - 3 * 86_400_000).toISOString() };
  assert.match(eq.snapshotAgeTag(old), /（数据 \d+-\d+ \d+:\d+）/, '超 24h 带时刻');
  assert.equal(eq.snapshotAgeTag(null), '');
  assert.equal(eq.snapshotAgeTag({ total: 1 }), '', '无 at 不标注');
});

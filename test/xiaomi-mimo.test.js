/**
 * issue #26：小米 MiMo 开放平台（platform.xiaomimimo.com）控制台余额抓取与 10Router 外部配额推送。
 * 测试覆盖：
 *  1. fetchXiaomiMimoProfile 提取 UID 与用户名
 *  2. fetchXiaomiMimoBalance 提取账户充值余额
 *  3. buildXiaomiMimoQuotaPayload 组装单值余额卡（Balance, total=99.5, isStoredValueRow 匹配）
 *  4. runQuotaPush 推送 source=xiaomi-mimo-{userId}，载荷合规（标量强校验）
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchXiaomiMimoProfile,
  fetchXiaomiMimoBalance,
  buildXiaomiMimoQuotaPayload,
} from '../src/xiaomiMimoClient.js';
import { runQuotaPush } from '../src/externalQuota.js';

test('fetchXiaomiMimoProfile：从 userProfile 接口解析 userId 与 userName', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/api\/v1\/userProfile/);
    assert.equal(init.headers.Cookie, 'token=123');
    return new Response(JSON.stringify({
      code: 0,
      data: { userId: '6786673', userName: 'xiaomi-dev' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await fetchXiaomiMimoProfile('token=123', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.userId, '6786673');
  assert.equal(r.userName, 'xiaomi-dev');
});

test('fetchXiaomiMimoProfile：未登录 401 报错', async () => {
  const fetchImpl = async () => new Response('{"code":401}', { status: 401 });
  const r = await fetchXiaomiMimoProfile('bad', { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('fetchXiaomiMimoBalance：提取账户余额与代金券', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/api\/v1\/balance/);
    assert.match(init.headers.Referer, /userId=6786673/);
    return new Response(JSON.stringify({
      code: 0,
      data: {
        availableBalance: 99.50,
        cashBalance: 80.00,
        voucherBalance: 19.50,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await fetchXiaomiMimoBalance('token=123', '6786673', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.balance, 99.5);
  assert.equal(r.cash, 80);
  assert.equal(r.voucher, 19.5);
});

test('buildXiaomiMimoQuotaPayload：组装单值储值卡（汇总行 summarizeDetail + 现金/赠送两腿折叠明细）', () => {
  const account = {
    id: 'acc-1',
    provider: 'xiaomi-mimo',
    uid: '6786673',
    meta: {
      userId: '6786673',
      quotaSnapshot: { total: 99.50 },
      mimoBalance: { balance: 99.50, cash: 0, voucher: 99.50 },
    },
  };
  const { source, payload } = buildXiaomiMimoQuotaPayload(account, { balance: 99.50, cash: 0, voucher: 99.50 });
  assert.equal(source, 'xiaomi-mimo-6786673');
  assert.equal(payload.provider, 'xiaomi-mimo');
  assert.equal(payload.label, 'Xiaomi MiMo (UID: 6786673)');
  assert.equal(payload.plan, '控制台充值余额');
  assert.ok(payload.quotas?.Balance);
  assert.equal(payload.quotas.Balance.name, '现金余额：¥ 0.00 · 赠送余额：¥ 99.50 (CNY)');
  assert.equal(payload.quotas.Balance.total, 99.50);
  assert.equal(payload.quotas.Balance.used, 0);
  assert.equal(payload.quotas.Balance.displayRemaining, true);
  // 汇总行只出大数字+副标题，绝不落进逐包明细（汇总句混进明细 = 同一数值印两遍）
  assert.equal(payload.quotas.Balance.summarizesDetail, true);
  // 明细两腿：0 腿也出行，与副标题的现金/赠送两腿对位；detailOnly 不进汇总池
  assert.ok(payload.quotas?.Cash);
  assert.equal(payload.quotas.Cash.name, '现金余额 (CNY)');
  assert.equal(payload.quotas.Cash.total, 0);
  assert.equal(payload.quotas.Cash.detailOnly, true);
  assert.ok(payload.quotas?.Voucher);
  assert.equal(payload.quotas.Voucher.name, '赠送余额 (CNY)');
  assert.equal(payload.quotas.Voucher.total, 99.50);
  assert.equal(payload.quotas.Voucher.detailOnly, true);
  // 账号别名 = 10R 同名认领的匹配键：改名后 label 跟随
  const { payload: renamed } = buildXiaomiMimoQuotaPayload({ ...account, name: 'test' }, { balance: 99.50, cash: 0, voucher: 99.50 });
  assert.equal(renamed.label, 'test');
});

test('runQuotaPush：包含 xiaomi-mimo 账号时自动发起 live 查询并推送到 10Router', async () => {
  const pushes = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/v1/balance')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { balance: 88.66 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/external-quota/')) {
      pushes.push({ url: u, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ ok: true, entries: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('404', { status: 404 });
  };

  const accounts = [
    {
      id: 'm1',
      provider: 'xiaomi-mimo',
      token: 'cookie-secret-123',
      uid: '6786673',
      meta: { cookieSiteId: 'xiaomi-mimo', userId: '6786673' },
    },
  ];

  const r = await runQuotaPush({
    endpoint: 'http://127.0.0.1:20128',
    key: 'sk-virtual-key',
    accounts,
    fetchImpl,
  });

  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].source, 'xiaomi-mimo-6786673');
  assert.equal(r.results[0].status, 'ok');

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, 'http://127.0.0.1:20128/api/external-quota/xiaomi-mimo-6786673');
  assert.equal(pushes[0].body.provider, 'xiaomi-mimo');
  assert.equal(pushes[0].body.quotas.Balance.total, 88.66);
  // 凭据材料绝不出载荷
  assert.ok(!JSON.stringify(pushes[0].body).includes('cookie-secret-123'), '载荷中绝不能出现 cookie 材料');
});

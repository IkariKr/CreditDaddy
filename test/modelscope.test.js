/**
 * ModelScope 魔方余额抓取与 10Router 推卡（CD#25）。
 * 覆盖：余额解析 / 会话探测（401 归类）/ 载荷（别名 label + 标量）/ runQuotaPush 链路。
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const client = await import('../src/modelscopeClient.js');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
  return () => { globalThis.fetch = orig; };
}

test('parseMagicubeBalance：真实形态优先（total_balance = UI 的 balance）', () => {
  // 事实源：前端 store `balance: e?.total_balance, available_balance: e?.available_balance`
  assert.equal(client.parseMagicubeBalance({ data: { total_balance: 1234, available_balance: 1200 } }), 1234);
  assert.equal(client.parseMagicubeBalance({ data: { available_balance: 1200 } }), 1200);
  // 演化兜底
  assert.equal(client.parseMagicubeBalance({ data: { balance: 99 } }), 99);
  assert.equal(client.parseMagicubeBalance({ amount: 50 }), 50);
  assert.equal(client.parseMagicubeBalance({}), null);
});

test('parseMagicubeLedger：今日（expire_days<=1 且今日获得）/长期拆分——官方发放记录口径 300=200+50+50', () => {
  const now = Date.now();
  const today = new Date(now);
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const items = [
    { type: 'EARN', expire_days: 1, total_amount: 200, date: t },        // 每日发放（1 天有效）
    { type: 'EARN', expire_days: 90, total_amount: 50, date: t },        // 信息完善 ×2（90 天）
    { type: 'EARN', expire_days: 90, amount: 50, gmt_created: `${t} 12:00:00` },
    { type: 'EXPIRE', expire_days: 1, total_amount: 200, date: t },      // 过期事件不计
    { type: 'SPEND_CONFIRM', expire_days: 90, total_amount: 10, date: t }, // 消耗不计（长期吸收）
    { type: 'EARN', expire_days: 1, total_amount: 200, date: '2020-01-01' }, // 昨日/往日的 1 天有效不算
    { type: 'EARN', total_amount: 30, date: t },                          // 有效期缺失=未知→归长期，绝不折算成今日
  ];
  const r = client.parseMagicubeLedger(items, 330, now);
  assert.equal(r.today, 200);
  assert.equal(r.long, 130);
});

test('buildModelScopeQuotaPayload：有拆分出三行（汇总句 + 两腿明细），无拆分回退单值', () => {
  const account = {
    id: 'ms-1',
    provider: 'modelscope',
    name: 'ModelScope (dev@example.com)',
    meta: { msSession: { id: 'u-9', email: 'dev@example.com' } },
  };
  const { payload } = client.buildModelScopeQuotaPayload(account, { balance: 300, ledger: { today: 200, long: 100 } });
  assert.match(payload.quotas.Balance.name, /今日发放 200/);
  assert.match(payload.quotas.Balance.name, /长期 100/);
  assert.equal(payload.quotas.Balance.summarizesDetail, true);
  assert.equal(payload.quotas.Today.detailOnly, true);
  assert.equal(payload.quotas.Today.total, 200);
  assert.equal(payload.quotas.LongTerm.detailOnly, true);
  assert.equal(payload.quotas.LongTerm.total, 100);
  const { payload: flat } = client.buildModelScopeQuotaPayload(account, { balance: 300 });
  assert.equal(flat.quotas.Today, undefined);
  assert.match(flat.quotas.Balance.name, /魔粒/);
});

test('fetchMagicubeBalance：会话 cookie 读 /openapi/v1/magicubes/balance，身份双端点合并（大写 Data 信封）', async () => {
  const restore = stubFetch(async (url, init) => {
    if (url.includes('/magicubes/balance')) {
      assert.match(init.headers.Cookie, /session-id=abc/);
      return jsonResponse(200, { data: { total_balance: 1234, available_balance: 1200 } });
    }
    // 身份端点真身在 /api/v1（2026-10-14 端点探测）：login/info 带 Name，users/info 带 email/email_extra
    if (url.includes('/users/login/info')) {
      assert.ok(url.includes('/api/v1/users/login/info'), '身份端点必须是 /api/v1 前缀');
      return jsonResponse(200, { Success: true, Data: { Name: 'Dev', UserId: 'u-9' } });
    }
    if (url.includes('/users/info')) {
      return jsonResponse(200, { Success: true, Data: { email: 'dev@example.com', email_extra: [{ email: 'dev@example.com', identity: 'user' }] } });
    }
    return jsonResponse(404, {});
  });
  try {
    const r = await client.fetchMagicubeBalance('session-id=abc; csrftoken=x', { fetchImpl: globalThis.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.balance, 1234);
    assert.equal(r.identity?.email, 'dev@example.com', 'email 来自 users/info');
    assert.equal(r.identity?.name, 'Dev', 'Name 来自 login/info，两端点互补合并');
    assert.equal(r.identity?.id, 'u-9');
  } finally { restore(); }
});

test('probeMagicubeSession：余额+身份+流水拆分一步到位（捕获/重探共用）', async () => {
  const now = Date.now();
  const t = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}-${String(new Date(now).getDate()).padStart(2, '0')}`;
  const restore = stubFetch(async (url) => {
    if (url.includes('/magicubes/balance')) return jsonResponse(200, { data: { total_balance: 300, available_balance: 300 } });
    if (url.includes('/magicubes/transactions')) return jsonResponse(200, { data: { records: [
      { type: 'EARN', expire_days: 1, total_amount: 200, date: t },
      { type: 'EARN', expire_days: 90, total_amount: 50, date: t },
      { type: 'EARN', expire_days: 90, total_amount: 50, date: t },
    ] } });
    if (url.includes('/users/login/info')) return jsonResponse(200, { Success: true, Data: { Name: 'Dev', UserId: 'u-9' } });
    if (url.includes('/users/info')) return jsonResponse(200, { Success: true, Data: { email: 'dev@example.com' } });
    return jsonResponse(404, {});
  });
  try {
    const r = await client.probeMagicubeSession('session-id=abc', { fetchImpl: globalThis.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.balance, 300);
    assert.equal(r.identity, 'dev@example.com');
    assert.equal(r.msBalance.today, 200);
    assert.equal(r.msBalance.long, 100);
    assert.equal(r.msSession.email, 'dev@example.com');
  } finally { restore(); }
});

test('fetchMagicubeBalance：401 归类会话失效', async () => {
  const restore = stubFetch(async () => jsonResponse(401, { error: 'unauthorized' }));
  try {
    const r = await client.fetchMagicubeBalance('stale', { fetchImpl: globalThis.fetch });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  } finally { restore(); }
});

test('buildModelScopeQuotaPayload：储值计数卡（别名 label = 认领键）', () => {
  const account = {
    id: 'ms-1',
    provider: 'modelscope',
    name: 'ModelScope (dev@example.com)',
    meta: { msSession: { id: 'u-9', email: 'dev@example.com' } },
  };
  const { source, payload } = client.buildModelScopeQuotaPayload(account, { balance: 1234 });
  assert.equal(source, 'modelscope-u-9');
  assert.equal(payload.provider, 'modelscope');
  assert.equal(payload.label, 'ModelScope (dev@example.com)');
  assert.ok(payload.quotas?.Balance);
  assert.equal(payload.quotas.Balance.total, 1234);
  assert.equal(payload.quotas.Balance.isCreditBalance, true);
  assert.equal(payload.quotas.Balance.summarizesDetail, true);
  for (const [k, v] of Object.entries(payload.quotas.Balance)) {
    assert.notEqual(typeof v, 'object', `quotas.Balance.${k} 必须是标量`);
  }
  // 改名后 label 跟随（同名认领）
  const { payload: renamed } = client.buildModelScopeQuotaPayload({ ...account, name: '魔搭#1' }, { balance: 1234 });
  assert.equal(renamed.label, '魔搭#1');
  // 读失败 → message 状态卡
  const { payload: bad } = client.buildModelScopeQuotaPayload(account, { error: '会话失效' });
  assert.ok(!bad.quotas && bad.message);
});

test('runQuotaPush：modelscope 账号 live 读余额并推送，载荷不带 cookie', async () => {
  const pushes = [];
  const restore = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes('/magicubes/balance')) return jsonResponse(200, { data: { total_balance: 1234, available_balance: 1200 } });
    if (u.includes('/magicubes/transactions')) return jsonResponse(200, { data: { records: [] } });
    if (u.includes('/users/login/info')) return jsonResponse(200, { Success: true, Data: { Name: 'Dev', UserId: 'u-9' } });
    if (u.includes('/users/info')) return jsonResponse(200, { Success: true, Data: { email: 'dev@example.com' } });
    if (u.includes('/api/external-quota/')) {
      pushes.push({ url: u, body: JSON.parse(init.body) });
      return jsonResponse(200, { ok: true, entries: 1 });
    }
    return jsonResponse(404, {});
  });
  try {
    const { runQuotaPush } = await import('../src/externalQuota.js');
    const accounts = [{
      id: 'ms-1',
      provider: 'modelscope',
      token: 'session-id=cookie-secret-999',
      meta: { cookieSiteId: 'modelscope' },
    }];
    const r = await runQuotaPush({ endpoint: 'http://127.0.0.1:20128', key: 'sk-test', accounts, fetchImpl: globalThis.fetch });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].status, 'ok');
    assert.equal(pushes[0].body.quotas.Balance.total, 1234);
    assert.ok(!JSON.stringify(pushes[0].body).includes('cookie-secret-999'), '载荷中绝不能出现会话 cookie');
  } finally { restore(); }
});

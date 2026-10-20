// 豆包网页会话线测试（issue #32）——接口形状 2026-10-19/20 CDP 实测钉死。
// 干净配置目录：store 等模块按测试隔离初始化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-doubao-'));

const dc = await import('../src/doubaoClient.js');

const DETAIL_SIGNED = {
  code: 0,
  data: {
    campaign_code: 'pc_incentive_task_mvp_v3',
    tasks: [
      {
        campaign_code: 'daily_signin',
        task_kind: 'daily_signin',
        task_status: 3,
        daily_checkin: {
          checked_in_today: true,
          continuous_days: 3,
          last_checkin_date: '2026-10-20',
          reward: { reward_amount: 200, reward_type: 'quota_grant' },
          reward_status: 3,
          total_days: 3,
        },
      },
      { campaign_code: 'select_work_fields', task_kind: 'chat_activity', task_status: 1 },
    ],
    progress: { total_amount: 600 },
  },
  msg: '',
};

const DETAIL_UNSIGNED = {
  ...DETAIL_SIGNED,
  data: {
    ...DETAIL_SIGNED.data,
    tasks: [
      {
        ...DETAIL_SIGNED.data.tasks[0],
        task_status: 1,
        daily_checkin: {
          checked_in_today: false,
          continuous_days: 2,
          last_checkin_date: '2026-10-19',
          reward: { reward_amount: 200, reward_type: 'quota_grant' },
          total_days: 2,
        },
      },
    ],
    progress: { total_amount: 400 },
  },
};

const CLAIM_OK = {
  code: 0,
  data: {
    checked_in: true,
    checkin_date: '2026-10-20',
    continuous_days: 3,
    idempotent: false,
    reward_amount: 200,
    reward_code: 'quota_grant',
    reward_status: 3,
    reward_type: 'quota_grant',
  },
  msg: '',
  message: '',
};

const CLAIM_IDEMPOTENT = { ...CLAIM_OK, data: { ...CLAIM_OK.data, idempotent: true } };

const LOGIN_INVALID = { data: null, code: 710012001, msg: '登录已过期，请重新登录', message: 'login invalid' };

/** 注入 global fetch：fetchJsonRace 直连路径走 globalThis.fetch（无代理场景） */
function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

const mkRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('fetchDoubaoStatus：已签场景（checked_in_today=true，连续天数与总额解析）', async () => {
  let seen = null;
  const restore = stubFetch(async (url, init) => {
    seen = { url, method: init.method, body: init.body, headers: init.headers };
    return mkRes(DETAIL_SIGNED);
  });
  try {
    const st = await dc.fetchDoubaoStatus('sid=ABC');
    assert.equal(st.auth, true);
    assert.equal(st.code, 0);
    assert.equal(st.checkin.checkedIn, true);
    assert.equal(st.checkin.continuousDays, 3);
    assert.equal(st.checkin.lastDate, '2026-10-20');
    assert.equal(st.checkin.rewardAmount, 200);
    assert.equal(st.totalAmount, 600);
    assert.equal(seen.method, 'POST');
    assert.deepEqual(JSON.parse(seen.body), { campaign_group_code: 'pc_incentive_task_mvp_v3' });
    assert.equal(seen.headers.Cookie, 'sid=ABC');
  } finally { restore(); }
});

test('fetchDoubaoStatus：会话失效（code 710012001 → auth=false）', async () => {
  const restore = stubFetch(async () => mkRes(LOGIN_INVALID));
  try {
    const st = await dc.fetchDoubaoStatus('bad');
    assert.equal(st.auth, false);
    assert.equal(st.code, 710012001);
    assert.equal(st.checkin, null);
  } finally { restore(); }
});

test('checkinDoubao：未签 → claim 成功（+200 额度，连续天数 +1）', async () => {
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    if (url.includes('/landing/checkin')) return mkRes(CLAIM_OK);
    throw new Error('unexpected url ' + url);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'checked-in');
    assert.equal(r.claimedAmount, 200);
    assert.match(r.message, /连续 3 天/);
    assert.equal(calls.length, 2, '先 detail 后 checkin');
  } finally { restore(); }
});

test('checkinDoubao：已签 → already（不打 claim）', async () => {
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    return mkRes(DETAIL_SIGNED);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'already');
    assert.equal(calls.length, 1, 'detail 查完即返回');
  } finally { restore(); }
});

test('checkinDoubao：claim 返回 idempotent=true → already（服务端幂等去重）', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes(CLAIM_IDEMPOTENT);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'already');
    assert.match(r.message, /幂等/);
  } finally { restore(); }
});

test('checkinDoubao：会话失效抛 auth 错误（调用方按凭据失效引导重新捕获）', async () => {
  const restore = stubFetch(async () => mkRes(LOGIN_INVALID));
  try {
    await assert.rejects(
      dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'bad' } } }),
      (e) => e.auth === true && /重新登录/.test(e.message),
    );
  } finally { restore(); }
});

test('checkinDoubao：无签到任务 → no-activity（活动未开放 / 飞书企业号）', async () => {
  const restore = stubFetch(async () => mkRes({ code: 0, data: { tasks: [{ task_kind: 'chat_activity', task_status: 1 }], progress: { total_amount: 0 } } }));
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'no-activity');
    assert.match(r.message, /无签到任务/);
  } finally { restore(); }
});

test('doubao 进 providers 注册表：checkin / quota 可分发', async () => {
  const { productImpl } = await import('../src/providers.js');
  const impl = productImpl('doubao');
  assert.equal(impl.label, '豆包');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
});

test('cookieSites 配置表的 provider 全部在 PROVIDERS 白名单（豆包收割上报被 store 校验拒的回归钉子）', async () => {
  const { COOKIE_SITES } = await import('../src/cookieSites.js');
  const { PROVIDERS } = await import('../src/constants.js');
  for (const site of COOKIE_SITES) {
    assert.ok(PROVIDERS.includes(site.provider), `站点 ${site.id} 的 provider "${site.provider}" 不在 PROVIDERS 白名单——收割上报会被 store 拒绝`);
  }
});

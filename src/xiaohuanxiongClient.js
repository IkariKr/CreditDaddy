/**
 * 办公小浣熊（商汤，office.xiaohuanxiong.com）积分余额抓取（issue #27）。
 *
 * 形状与 modelscope 同款：纯只读接入——免费个人版每天 00:00 自动发放积分、无签到/领取
 * 动作端点（191 chunk 考古结论：无任何 check_in/claim POST），能做的只有
 * 「捕获会话 → 读余额 → 出卡」。凭据 = `.xiaohuanxiong.com` 域的 raccoon_token cookie，
 * 走 `Authorization: Bearer`。
 *
 * ⚠ 端点在**裸域** `https://xiaohuanxiong.com`（office 子域只负责页面；在 office 子域
 * 拼 API 会 307 跳登录页，看起来像「会话失效」实际是 URL 错了——接入时最容易误判的一个）。
 *
 * 卡面口径（与 modelscope 的关键差异，不照抄）：消耗是**按桶顺序扣**的（每日→每月→奖励→
 * 加油包），四桶余额各自独立到期，「total − daily」反推不出任何有意义的东西——直接用
 * balance 响应的四个桶字段出 detailOnly 明细腿，是唯一正确解。权威余额永远是 balance
 * 接口（明细有延迟且含桌面端本地 Agent 消耗，不拿 bills 求和）。
 *
 * 安全纪律：会话 cookie 只存本机账号库（0600），推 10Router 只带积分数字标量。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';
import { snapshotAgeTag } from './externalQuota.js';

export const XHX_HOME_URL = 'https://office.xiaohuanxiong.com/home';
/** API 根 = 裸域（office 子域只负责页面，拼错会 307 跳登录） */
export const XHX_API_BASE = 'https://xiaohuanxiong.com';
export const XHX_BALANCE_URL = `${XHX_API_BASE}/api/web/points/v1/balance`;
export const XHX_USER_INFO_URL = `${XHX_API_BASE}/api/web/auth/v1/user_info`;

const XHX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

/**
 * 小浣熊的 API 只认 `Authorization: Bearer <raccoon_token>`（bundle createHeaders 事实源），
 * 裸 Cookie 头打过去就是 401 + code 200001（authorization_empty）——token 从收割的
 * cookie 串里抽出来拼 Bearer。X-Org-Code 仅企业身份需要（个人不带），v1 只支持个人。
 */
export function raccoonTokenOf(cookie) {
  const m = /(?:^|;\s*)raccoon_token=([^;]+)/.exec(String(cookie || ''));
  return m ? decodeURIComponent(m[1].trim()) : null;
}

function xhxHeaders(cookie) {
  const token = raccoonTokenOf(cookie);
  return {
    Accept: 'application/json, text/plain, */*',
    Cookie: String(cookie || '').trim(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Referer: `${XHX_HOME_URL}`,
    'X-Raccoon-Language': 'zh',
    'User-Agent': XHX_UA,
  };
}

/**
 * balance 响应 → 积分余额。信封与字段（bundle 字面量事实源）：
 *   { code, message, data: { available_points, daily_points, monthly_points,
 *      reward_points, topup_points, topup_frozen, enterprise_topup_points? } }
 * 会话失效 = HTTP 401 + `code: 200001`（authorization_empty_error），按 auth 失效归类。
 * @returns {{ ok: boolean, balance?: number, buckets?: object, raw?: object, error?: string, status?: number, authExpired?: boolean }}
 */
export async function fetchRaccoonBalance(cookie, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doFetch(XHX_BALANCE_URL, { headers: xhxHeaders(cookie) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const d = body?.data && typeof body.data === 'object' ? body.data : null;
    const balance = Number(d?.available_points);
    if (!d || !Number.isFinite(balance) || balance < 0) {
      // 失败时把响应字段名带进错误（只记键名不记值）——字段演化时一眼定位
      const keys = Object.keys(d || body || {}).slice(0, 12).join(',');
      return { ok: false, status: res.status, error: `未能从响应中提取积分余额（响应字段：${keys || '空'}）`, raw: body };
    }
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
    };
    // 四桶构成 = 官方「资源用量 → 积分构成」UI 的一一对应（每日/每月/奖励/加油包）
    const buckets = {
      daily: num(d.daily_points),
      monthly: num(d.monthly_points),
      reward: num(d.reward_points),
      topup: num(d.topup_points),
    };
    return { ok: true, balance: num(balance), buckets, raw: body };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 身份尽力而为：auth/v1/user_info（{data:{id,name,…}}）；失败不影响余额（返回 null） */
export async function fetchRaccoonIdentity(cookie, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doFetch(XHX_USER_INFO_URL, { headers: xhxHeaders(cookie) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const d = body?.data && typeof body.data === 'object' ? body.data : {};
    const id = d.id || d.user_id || d.uid || null;
    const name = d.name || d.nickname || d.username || null;
    const email = d.email || null;
    return id || name || email ? { id: id ? String(id) : null, name, email } : null;
  } catch {
    return null;
  }
}

/** 断面快照入库形状（capture/reprobe 共用）：余额 + 四桶 + 时间戳 */
export function raccoonSnapshot(bal) {
  return {
    amount: bal.balance,
    buckets: bal.buckets,
    at: new Date().toISOString(),
  };
}

/**
 * 组装办公小浣熊的 10Router external-quota 载荷（储值积分卡，modelscope 同口径）：
 *  - Balance 行 = available_points（isCreditBalance + summarizesDetail，不进逐包明细）；
 *  - 四条 detailOnly 明细腿 = 每日 / 每月 / 奖励 / 加油包（0 腿也出行，对位官方构成 UI）。
 * @param {object} account  meta.raccoonSession（身份）/ meta.raccoonBalance（快照）
 * @param {{ balance?: number, buckets?: object, error?: string, authInvalid?: boolean }} [liveData]
 *   authInvalid = live 拉取明确 401/403（会话失效）——不回退旧快照，降级 message 状态卡
 * @returns {{ source: string, payload: object }}
 */
export function buildXhxQuotaPayload(account, liveData = null) {
  const sess = account?.meta?.raccoonSession || {};
  const userId = account?.uid || sess.id || '';
  const short = String(userId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  const source = short ? `xiaohuanxiong-${short}`.slice(0, 32) : `xiaohuanxiong-${(account?.id || 'default').slice(0, 24)}`;
  const nameStr = String(account?.name || '').trim();
  const email = sess.email || /[\w.+-]+@[\w-]+\.[\w.]+/.exec(nameStr)?.[0] || '';
  const label = (nameStr || (email ? `办公小浣熊 (${email})` : '办公小浣熊')).slice(0, 100);

  if (liveData?.authInvalid) {
    return {
      source,
      payload: {
        provider: 'xiaohuanxiong',
        label,
        message: liveData.error || t('办公小浣熊会话已失效，请在 CreditDaddy「网页会话」页重新登录捕获'),
      },
    };
  }

  let balance = liveData?.balance;
  let ageTag = '';
  if (!Number.isFinite(balance)) {
    const snap = account?.meta?.quotaSnapshot;
    balance = Number(snap?.total ?? account?.meta?.raccoonBalance?.amount);
    // 快照回退（非 live）：距今 >24h 的陈粮在副标题标注数据时刻（可见性兜底）
    ageTag = snapshotAgeTag(snap?.at ? snap : account?.meta?.raccoonBalance);
  }
  const payload = { provider: 'xiaohuanxiong', label, plan: t('积分余额') + ageTag };

  if (Number.isFinite(balance) && balance >= 0) {
    const buckets = (liveData?.buckets || account?.meta?.raccoonBalance?.buckets) || {};
    // 副标题 = 四桶构成（官方「资源用量」口径；桶缺省按 0 展示）
    const f = (n) => Number(n || 0).toFixed(0);
    const subText = t('每日 {daily} · 每月 {monthly} · 奖励 {reward} · 加油包 {topup}', {
      daily: f(buckets.daily), monthly: f(buckets.monthly), reward: f(buckets.reward), topup: f(buckets.topup),
    });
    payload.quotas = {
      Balance: {
        name: `${subText} (${t('积分')})`,
        used: 0,
        total: Math.max(0, balance) || 0.000001,
        remainingPercentage: balance > 0 ? 100 : 0,
        displayRemaining: true,
        isCreditBalance: true,
        summarizesDetail: true,
      },
    };
    // 四条 detailOnly 明细腿（0 腿也出——官方构成 UI 四行恒在；不进汇总池）
    const legs = [
      ['Daily', t('每日额度'), buckets.daily],
      ['Monthly', t('每月额度'), buckets.monthly],
      ['Reward', t('奖励积分'), buckets.reward],
      ['Topup', t('加油包'), buckets.topup],
    ];
    for (const [key, name, val] of legs) {
      const v = Number.isFinite(Number(val)) ? Number(val) : 0;
      payload.quotas[key] = {
        name,
        used: 0,
        total: Math.max(0, v) || 0.000001,
        remainingPercentage: v > 0 ? 100 : 0,
        displayRemaining: true,
        isCreditBalance: true,
        detailOnly: true,
      };
    }
  } else {
    payload.message = liveData?.error || t('办公小浣熊会话已失效，请在 CreditDaddy「网页会话」页重新登录捕获');
  }

  return { source, payload };
}

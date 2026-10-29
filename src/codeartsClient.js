/**
 * 华为云码道 CodeArts 代码智能体 — 每日签到领积分（issue #40）。
 *
 *   活动期 2026-10-27 20:00 ～ 2026-12-31 23:59（UTC+8），积分当日有效：
 *     个人体验版 100 / 标准版 150 / 高级版与旗舰版 200（官方文档）。
 *   入口：码道网页端 codearts.huaweicloud.com/portal「头像 → 活动福利 → 每日领取」。
 *
 * 协议事实（2026-10-29 浏览器实测 + 网络面板捕获）：
 *   - 基址 https://codearts.huaweicloud.com/portal/；后端认 portal 域自身会话
 *     cookie（SessionID 等，部分 httpOnly）——收割必须覆盖该域（见 cookieSites）。
 *   - 所有 API 必带请求头：cftk（CSRF，值 = cookie devclouddevuibjtcftk）、
 *     language / x-language: zh-cn、x-requested-with: XMLHttpRequest；
 *     缺 cftk 或 Accept 不是 JSON 时网关回 200 HTML（SPA fallback）——判定时先看 content-type。
 *   - 余额：GET /snap-manager/v1/package/overview?_=<ts>（axios 形状：带 Content-Type: application/json 的 GET）
 *     → { all_credit_package: { package_credit_amount, package_credit_used, package_credit_remain,
 *         expiring_credit_amount, ... }, basic_package: {...}, ... }
 *   - 签到：POST /promptcenter/v1/ops/claim（无可读 body 需求；此前实测页面调用成功 +100，
 *     「积分领取成功！」通知；同活动记录进「已完成与已隐藏活动」）。
 *     同族端点：POST /promptcenter/v1/ops/events/trigger（事件上报）、GET /ops/delivery?channel=PORTAL
 *     （活动渲染数据，含「每日签到」任务状态——即将领取与否看它）。
 *
 * 失效语义：未登录/会话过期 → 网关 200 返回登录跳转 HTML（非 JSON）；401/403 直接拒绝。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

export const CODEARTS_PORTAL_BASE = 'https://codearts.huaweicloud.com';
export const CODEARTS_LOGIN_URL = `${CODEARTS_PORTAL_BASE}/portal`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

/** 从 cookie 串里取单个值（cftk 在 devclouddevuibjtcftk 里） */
export function cookieValue(cookie, name) {
  for (const part of String(cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** 码道 API 通用头：cftk 缺失时网关必回 SPA fallback HTML——调用方拿到的 200 不可信，以 content-type 复核 */
export function codeartsHeaders(cookie, { json = false } = {}) {
  const cftk = cookieValue(cookie, 'devclouddevuibjtcftk') || cookieValue(cookie, 'console_cftk') || '';
  return {
    Accept: 'application/json, text/plain, */*',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Cookie: String(cookie || '').trim(),
    language: 'zh-cn',
    'x-language': 'zh-cn',
    'x-requested-with': 'XMLHttpRequest',
    cftk,
    Referer: `${CODEARTS_LOGIN_URL}/settings/personal-usage?locale=zh-cn`,
    'User-Agent': UA,
  };
}

const doFetch = (fetchImpl, headers) => (url, init = {}) =>
  (fetchImpl || ((u, i) => fetchJsonRace(u, { headers: i.headers, method: i.method, body: i.body, timeoutMs: FETCH_TIMEOUT_MS })))(url, { ...init, headers });

/** 响应是否为 JSON（SPA fallback 的 200 HTML = 会话失效/未路由，一律按未登录处理） */
function looksJson(res) {
  return String(res.headers?.get?.('content-type') || res.headers?.['content-type'] || '').includes('json');
}

/**
 * 余额 + 会话探活二合一（捕获验证 / 保活监视 / 额度展示共用）。
 * @returns {Promise<{ok: boolean, authExpired?: boolean, total?: number, remain?: number, used?: number,
 *                     expiring?: number, raw?: object, error?: string}>}
 */
export async function fetchCodeartsBalance(cookie, { fetchImpl } = {}) {
  const doReq = doFetch(fetchImpl, codeartsHeaders(cookie, { json: true }));
  const url = `${CODEARTS_PORTAL_BASE}/portal/snap-manager/v1/package/overview?_=${Date.now()}`;
  try {
    const res = await doReq(url, { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { ok: false, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (!looksJson(res)) return { ok: false, authExpired: true, error: '会话失效（网关返回登录页）' };
    const body = await res.json().catch(() => null);
    const pkg = body?.all_credit_package;
    if (!pkg || !Number.isFinite(Number(pkg.package_credit_amount))) {
      return { ok: false, error: '响应结构变化：缺少 all_credit_package', raw: body };
    }
    return {
      ok: true,
      total: Number(pkg.package_credit_amount) || 0,
      used: Number(pkg.package_credit_used) || 0,
      remain: Number(pkg.package_credit_remain) || 0,
      expiring: Number(pkg.expiring_credit_amount) || 0,
      raw: body,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 兼容旧探测入口名（保活监视）：等价 fetchCodeartsBalance */
export async function probeCodeartsSession(cookie, opts = {}) {
  return fetchCodeartsBalance(cookie, opts);
}

/**
 * 活动列表（delivery）：含每活动的 campaignId / claimable / status（ELIGIBLE=可领、
 * CLAIMED=今日已领、CONFIRMED=已到账、CONSUMED=已消耗）与 benefitAmount。
 * 「每日签到领100积分」campaignId=34、MANUAL_CLAIM 模式、活动期 2026-10-27 ~ 12-31。
 */
export async function fetchCodeartsCampaigns(cookie, { fetchImpl } = {}) {
  const doReq = doFetch(fetchImpl, codeartsHeaders(cookie, { json: true }));
  const url = `${CODEARTS_PORTAL_BASE}/portal/promptcenter/v1/ops/delivery?channel=PORTAL&_=${Date.now()}`;
  const res = await doReq(url, { method: 'GET' });
  if (res.status === 401 || res.status === 403) return { ok: false, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  if (!looksJson(res)) return { ok: false, authExpired: true, error: '会话失效（网关返回登录页）' };
  const body = await res.json().catch(() => null);
  const items = Array.isArray(body?.data?.items) ? body.data.items : null;
  if (!items) return { ok: false, error: '响应结构变化：delivery 无 items', raw: body };
  return { ok: true, items, raw: body };
}

/**
 * 身份（多账号归户用）：GET /portal/rest/me → { userId, userName, domainId, domainName }。
 * 会话失效时网关回登录页 HTML（非 JSON）→ authExpired。
 * @returns {Promise<{ok: boolean, authExpired?: boolean, identity?: {userId, userName, domainId, domainName}, error?: string}>}
 */
export async function fetchCodeartsIdentity(cookie, { fetchImpl } = {}) {
  const doReq = doFetch(fetchImpl, codeartsHeaders(cookie, { json: true }));
  const url = `${CODEARTS_PORTAL_BASE}/portal/rest/me?_=${Date.now()}`;
  try {
    const res = await doReq(url, { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { ok: false, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (!looksJson(res)) return { ok: false, authExpired: true, error: '会话失效（网关返回登录页）' };
    const body = await res.json().catch(() => null);
    if (!body?.userId) return { ok: false, error: 'rest/me 无 userId（响应结构变化）', raw: body };
    return {
      ok: true,
      identity: {
        userId: String(body.userId),
        userName: body.userName || body.name || null,
        domainId: body.domainId || null,
        domainName: body.domainName || null,
      },
      raw: body,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 每日签到（活动福利 → 每日领取）。
 * 协议从 portal 前端 bundle（CodeArtsAgentPortal/126.10.101 index-0d2cb53c.js）逆向 + 页面实测：
 *   1) POST events/trigger { triggerEvent: 'user.login', idempotentKey: `login-YYYYMMDD-<rand6>`, channel: 'PORTAL' }
 *      （页面侧静默上报，错误被吞；资格认定可能依赖它，失败不阻断后续但记日志）
 *   2) POST claim { campaignId, channel: 'PORTAL', idempotentKey: <32hex 随机> }
 *      成功 = { code: 0, data: { status: 'CLAIMED' } }；业务拒绝 = 非 0 code + error_msg
 *      （缺 idempotentKey 时 400「campaignId : 参数无效」——2026-10-30 实测踩过）
 * 已领预判：delivery 的 status/claimable **有时延**（页面领取后仍短暂 ELIGIBLE），
 * 不能只信它——claim 拒绝时复查一次 delivery，status 转 CLAIMED 即按 already 收口。
 * @returns {Promise<{ status: 'checked-in'|'already'|'no-activity'|'failed', message?: string, raw?: object }>}
 */
function randomHex32() {
  // 与前端 Zco() 同形状：16 字节随机数的 hex（无 crypto.subtle 依赖，签到幂等键够用）
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function loginIdempotentKey(now = new Date()) {
  const p = (a) => String(a).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `login-${day}-${rand}`;
}

export async function checkinCodearts(cookie, { fetchImpl } = {}) {
  const doReq = doFetch(fetchImpl, codeartsHeaders(cookie, { json: true }));
  const list = await fetchCodeartsCampaigns(cookie, { fetchImpl }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!list.ok) return { status: 'failed', message: list.error || '活动列表获取失败', authExpired: list.authExpired };
  // 每日签到的活动识别：type=USER_LOGIN + triggerMode=MANUAL_CLAIM（标题兜底「每日签到」）
  const daily = list.items.find((it) => it.type === 'USER_LOGIN' && it.triggerMode === 'MANUAL_CLAIM')
    || list.items.find((it) => /每日签到/.test(String(it.title || '')));
  if (!daily) return { status: 'no-activity', message: '活动列表里没有每日签到活动（活动可能已结束）', raw: list.raw };
  if (daily.claimable === false && /CLAIMED|CONFIRMED|CONSUMED/.test(String(daily.status || ''))) {
    return { status: 'already', message: '今日已领', raw: daily };
  }
  // 事件资格上报（页面形状：triggerEvent + 按日 idempotentKey + channel；失败不阻断）
  await doReq(`${CODEARTS_PORTAL_BASE}/portal/promptcenter/v1/ops/events/trigger`, {
    method: 'POST',
    body: JSON.stringify({ triggerEvent: daily.extra?.triggerEvent || 'user.login', idempotentKey: loginIdempotentKey(), channel: 'PORTAL' }),
  }).catch(() => {});
  const res = await doReq(`${CODEARTS_PORTAL_BASE}/portal/promptcenter/v1/ops/claim`, {
    method: 'POST',
    body: JSON.stringify({ campaignId: daily.campaignId, channel: 'PORTAL', idempotentKey: randomHex32() }),
  });
  if (res.status === 401 || res.status === 403) return { status: 'failed', message: `会话失效（HTTP ${res.status}）`, authExpired: true };
  if (!res.ok) {
    // delivery 状态有时延：claim 被拒时复查一次，转 CLAIMED 则实际已入账（按 already 收口）
    await new Promise((r) => setTimeout(r, 1500));
    const again = await fetchCodeartsCampaigns(cookie, { fetchImpl }).catch(() => null);
    const now = again?.ok ? again.items.find((it) => it.campaignId === daily.campaignId) : null;
    if (now && /CLAIMED|CONFIRMED|CONSUMED/.test(String(now.status || ''))) {
      return { status: 'already', message: '今日已领', raw: now };
    }
    return { status: 'failed', message: `HTTP ${res.status}`, raw: now || daily };
  }
  if (!looksJson(res)) return { status: 'failed', message: '会话失效（网关返回登录页）', authExpired: true };
  const body = await res.json().catch(() => null);
  const code = Number(body?.code);
  if (Number.isFinite(code) && code !== 0) {
    // 同上：拒绝可能只是 delivery 状态时延，复查后再定性
    await new Promise((r) => setTimeout(r, 1500));
    const again = await fetchCodeartsCampaigns(cookie, { fetchImpl }).catch(() => null);
    const now = again?.ok ? again.items.find((it) => it.campaignId === daily.campaignId) : null;
    if (now && /CLAIMED|CONFIRMED|CONSUMED/.test(String(now.status || ''))) {
      return { status: 'already', message: '今日已领', raw: now };
    }
    return { status: 'failed', message: body?.error_msg || body?.message || `claim code=${code}`, raw: body };
  }
  const okStatus = /CLAIMED|CONFIRMED|CONSUMED/.test(String(body?.data?.status || '')) || !body?.data?.status;
  if (!okStatus) return { status: 'failed', message: `claim 返回 status=${body?.data?.status}`, raw: body };
  return { status: 'checked-in', message: `积分领取成功（+${daily.benefitAmount ?? 100}）`, raw: body };
}

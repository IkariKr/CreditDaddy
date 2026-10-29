/**
 * 华为云码道 CodeArts 代码智能体 — 每日签到领积分（issue #40）。
 *
 *   活动期 2026-10-27 20:00 ～ 2026-12-31 23:59（UTC+8），积分当日有效：
 *     个人体验版 100 / 标准版 150 / 高级版与旗舰版 200（issue #40 已核实官方文档）。
 *   签到入口（官方文档）：码道控制台 / 网页端「头像 → 活动福利 → 每日领取」。
 *   控制台 console.huaweicloud.com/agentarts（华为云统一账号签发会话）。
 *
 * 鉴权：华为云控制台会话 cookie（console.huaweicloud.com 域，含 region 路由参数）。
 * 端点考古状态（2026-10-29）：**未定**——本项目端点形状 / 业务码 / 响应结构均需
 * 真 cookie 实测（面板「网页会话」捕获后考古，参照豆包 issue #32 的节奏）。
 * 常量集中在 CODEARTS_API，改一处即可接上；fetch 全部带 12s 超时 + 明确业务分类。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

/** 码道控制台 API 基址（agentarts 服务挂在 console 域下；region 由 cookie 会话路由） */
export const CODEARTS_CONSOLE_BASE = 'https://console.huaweicloud.com';
export const CODEARTS_SERVICE_BASE = `${CODEARTS_CONSOLE_BASE}/agentarts`;

/**
 * 端点表（待真 cookie 考古回填；键即语义，路径为占位推测）。
 * - checkin：POST 每日领取；expectedOkCode / alreadyCodes / loginInvalidCodes 待实测
 * - points：GET 积分余额
 */
export const CODEARTS_API = {
  checkin: { method: 'POST', path: null },   // TODO(#40): 抓包「活动福利 → 每日领取」回填
  points: { method: 'GET', path: null },     // TODO(#40): 抓包活动福利页的余额查询回填
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function codeartsHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    Cookie: String(cookie || '').trim(),
    Referer: `${CODEARTS_SERVICE_BASE}/?region=cn-southwest-2`,
    'User-Agent': UA,
  };
}

/** 会话探活：捕获验证与保活监视共用。端点未定前恒返回「待考古」，不误杀会话。 */
export async function probeCodeartsSession(cookie, { fetchImpl } = {}) {
  if (!CODEARTS_API.points.path) {
    return { ok: false, pending: true, error: '码道端点考古中（issue #40），会话已存但探测未启用' };
  }
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: 12_000 }));
  try {
    const res = await doFetch(CODEARTS_CONSOLE_BASE + CODEARTS_API.points.path, { headers: codeartsHeaders(cookie) });
    if (res.status === 401 || res.status === 403) return { ok: false, authExpired: true, status: res.status, error: `会话失效（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    return { ok: Boolean(body), body };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Inception Labs（Mercury 扩散模型）网页会话 — 免费额度读数（100M tokens）。
 *
 *   GET https://platform.inceptionlabs.ai/api/usage?quota=1
 *   → { requests, tokens, metadata: { total_tokens }, limits: { totalTokens, ... },
 *       isFreeTier, freeTokenGrant: { total, default, expiresAt }, billingPeriod: { start, end } }
 *
 * 鉴权：platform.inceptionlabs.ai 会话 cookie（credentials: include），无签名风控。
 * ⚠ 出口代理为必须项：Cloudflare/CloudFront 对大陆与部分亚太 IP 直接 403（2026-10-20 实测，
 * sin1 节点拒绝）——探测走 fetchJsonRace 跟随全局代理（与 Token Harbor 同款约束）。
 * 接口形状来自用户抓包（2026-10-20，dashboard/billing 的 XHR）。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

export const INCEPTION_USAGE_URL = 'https://platform.inceptionlabs.ai/api/usage?quota=1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

/**
 * 用量接口 → 归一化额度。
 * @returns {{ ok: true, used: number, total: number, remaining: number, expiresAt: string|null, isFreeTier: boolean }
 *          | { ok: false, auth?: boolean, error: string }}
 */
export async function fetchInceptionUsage(cookie) {
  let res;
  try {
    res = await fetchJsonRace(INCEPTION_USAGE_URL, {
      headers: {
        Cookie: String(cookie || ''),
        Accept: '*/*',
        Referer: 'https://platform.inceptionlabs.ai/dashboard/billing',
        'User-Agent': UA,
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, error: e?.message || '网络错误（Inception 需代理出口，请检查网络出口配置）' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, auth: true, error: 'Inception 会话已失效，请重新登录捕获' };
  if (res.status === 302 || res.status === 303) return { ok: false, auth: true, error: 'Inception 会话已失效（被重定向回登录），请重新登录捕获' };
  if (!res.ok) return { ok: false, error: `Inception 用量接口 HTTP ${res.status}` };
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { return { ok: false, error: 'Inception 用量接口返回无法解析（可能被边缘节点拦截，请检查代理出口）' }; }
  const limits = body?.limits || {};
  const total = Number(limits.totalTokens);
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: 'Inception 响应缺少 limits.totalTokens（接口形状可能已变化）' };
  const used = Number(body?.metadata?.total_tokens) || 0;
  const grant = body?.freeTokenGrant || {};
  const expiresAt = typeof grant.expiresAt === 'string' && grant.expiresAt ? grant.expiresAt : null;
  return {
    ok: true,
    used,
    total,
    remaining: Math.max(total - used, 0),
    expiresAt,
    isFreeTier: body?.isFreeTier === true,
  };
}

/**
 * 通用「浏览器站点 cookie 捕获」（issue #23）——配置驱动的首个接入方：Token Harbor。
 *
 * 适用面：额度/信息只存在于登录后的 dashboard HTML、凭据只能是浏览器会话 cookie 的供应商。
 * 配置表加一行即可接入新站点（登录页 URL / 收割域 / 探测规则），10Router 侧零改动——
 * 同步走既有 `providerSpecificData.creditDaddyWebSession.cookie` 传输（与 qoder 同形状）。
 *
 * ⚠ 探测头必须与 10Router `services/usage/tokenharbor.js` 同款的浏览器形:裸 fetch 的 UA
 * 会拿到「HTML 空壳 / bot 拦截」（配额标记根本不在 HTML 里，探测必然误报「登录未完成」）。
 *
 * 测试用后门（仅测试改动探测地址）：环境变量 `CD_PROBE_<站点 id 大写,非字母数字→_>`，
 * 如 CD_PROBE_TOKENHARBOR 指向本地假站。生产配置永远取 probe.url。
 */

import { fetchJsonRace } from './zcodeClient.js';

/** 浏览器形探测头（对齐 10Router tokenharbor 探针：裸 UA 会被边缘节点喂空壳页） */
export function dashboardHeaders(site) {
  return {
    Cookie: '',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    Referer: (site.homeUrl || site.probe.url.split('/').slice(0, 3).join('/')) + '/',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

/** 登录页壳判定（会话已失效被挡回登录页）：没有配额标记且页面主题就是「登录」表单 */
function looksLikeLoginPage(html) {
  return /sign\s?in|log\s?in/i.test(html);
}

export const COOKIE_SITES = [
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    provider: 'tokenharbor',
    label: 'Token Harbor 免费额度（10Router 卡片）',
    loginUrl: 'https://tokenharbor.ai/login',
    homeUrl: 'https://tokenharbor.ai',
    probe: { url: 'https://tokenharbor.ai/dashboard', match: 'Free allowance' },
    // 免费账号要多账号轮换(#23 增补):身份从浏览器探针 HTML 里抽(邮箱通用正则)。
    // 抽不到 → 归到「未识别身份」单例,不影响既有行;有多账号需求的站点在配置里
    // 统一按这个抽,验证/合并逻辑对全表通用,不再一家一家硬编码。
    identity: { fromHtml: /[\w.+-]+@[\w-]+\.[\w.]+/ },
    accountName: 'Token Harbor 网页会话',
    hint: '登录后 dashboard 才有 Free allowance 配额；凭据只存本机（账号库加密），同步到 10Router 时按 creditDaddyWebSession 形状传输。',
  },
];

export const getSite = (id) => COOKIE_SITES.find((s) => s.id === id) || null;

/** 按登录窗口 URL 找到对应站点配置（登录页或其同源首页） */
export function siteForLoginUrl(url) {
  const u = String(url || '');
  return COOKIE_SITES.find((s) => u.startsWith(s.loginUrl) || u.startsWith(s.homeUrl)) || null;
}

/** cookies.get({url}) 可能返回 host-only 与域级同名项——按 name 去重留后写者，拼成 handler 接受的 plain string */
export function serializeCookies(cookies) {
  const byName = new Map();
  for (const c of cookies || []) {
    if (c && typeof c.name === 'string' && c.name) byName.set(c.name, String(c.value ?? ''));
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function probeUrl(site) {
  const env = process.env['CD_PROBE_' + site.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  return env || site.probe.url;
}

/**
 * 探测一份会话 cookie 是否仍然有效。
 * 探测走 fetchJsonRace（跟随全局代理配置——Token Harbor 对大陆/港澳有封锁，出口代理是必须项）。
 * @returns {Promise<{ok: boolean, reason?: 'invalid'|'no-match'|'http'|'network', status?: number}>}
 */
export async function verifySiteCookie(site, cookie, { fetchImpl } = {}) {
  const url = probeUrl(site);
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: 12000 }));
  try {
    const headers = { ...dashboardHeaders(site), Cookie: String(cookie || '') };
    const r = await doFetch(url, { headers });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'invalid', status: r.status };
    if (r.status !== 200) return { ok: false, reason: 'http', status: r.status };
    const text = await r.text();
    if (site.probe.match && !text.includes(site.probe.match)) {
      // 被挡回登录页 = 会话失效（与 10Router 的 AUTH_EXPIRED 分类对齐），不是「页面结构变化」
      return { ok: false, reason: looksLikeLoginPage(text) ? 'invalid' : 'no-match', status: r.status };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, reason: 'network', error: e?.message || String(e) };
  }
}

/**
 * 用「浏览器出品的 HTML」做探针(credit 桌面壳隐藏 Chromium 窗口的 probeHtml)——
 * 不经任何网络层,标记判定与网络探针完全同款(marker / 登录页壳分类),只做纯文本判断。
 */
export function verifyProbeHtml(site, html) {
  const text = String(html || '');
  if (site.probe.match && !text.includes(site.probe.match)) {
    return { ok: false, reason: looksLikeLoginPage(text) ? 'invalid' : 'no-match' };
  }
  return { ok: true };
}


/** 从浏览器探针产 HTML 里抽登录身份(邮箱等);抽不到返 null(调用方按单例兜底)。 */
export function extractIdentity(site, html) {
  if (!site.identity || !site.identity.fromHtml) return null;
  const m = site.identity.fromHtml.exec(String(html || ''));
  return m && m[0] ? m[0] : null;
}

/** 归户键的短哈希(不暴露身份原文;merge/dedupe 都只比对它) */
export function identityHashOf(value) {
  if (!value) return null;
  let h = 0;
  const s = String(value);
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) | 0) >>> 0;
  return 'ih' + h.toString(36);
}

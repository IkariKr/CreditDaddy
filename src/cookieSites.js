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
    Accept: site?.probe?.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

/**
 * Token Harbor dashboard HTML → 免费额度读数（与 10Router `services/usage/tokenharbor-free.js`
 * 同款口径——两处解析同一页面，规则改动需同步）。捕获时从浏览器探针 HTML 里解析一次，
 * 数字进 `meta.quotaSnapshot`，供 issue #24 的额度推送直接消费（推送不再打网络）。
 * @returns {{ used: number, resetAt: string|null } | null} 解析不出配额返回 null
 */
export function parseTokenHarborQuota(html) {
  const text = String(html || '');
  let used = null;
  const allowanceMatch = text.match(/Free allowance[\s\S]*?(\d+)%\s*(?:used|of total)/i);
  if (allowanceMatch) used = parseInt(allowanceMatch[1], 10);
  else {
    const generalPercentMatch = text.match(/Free allowance[\s\S]*?(\d+)%/i);
    if (generalPercentMatch) used = parseInt(generalPercentMatch[1], 10);
  }
  if (used === null) return null;
  let resetAt = null;
  const resetMatch = text.match(/Resets?\s+(?:in\s+)?(?:(\d+)\s*[dD])?\s*(?:(\d+)\s*[hH])?\s*(?:(\d+)\s*[mM])?/i);
  if (resetMatch && (resetMatch[1] || resetMatch[2] || resetMatch[3])) {
    const days = parseInt(resetMatch[1] || '0', 10);
    const hours = parseInt(resetMatch[2] || '0', 10);
    const minutes = parseInt(resetMatch[3] || '0', 10);
    const msOffset = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
    if (msOffset > 0) resetAt = new Date(Date.now() + msOffset).toISOString();
  }
  return { used, resetAt };
}

export const COOKIE_SITES = [
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    provider: 'tokenharbor',
    label: 'Token Harbor 免费额度',
    loginUrl: 'https://tokenharbor.ai/login',
    homeUrl: 'https://tokenharbor.ai',
    // 探测标记：由于 Token Harbor 的 dashboard 页面将 Free allowance 移至客户端动态组件中渲染，
    // SSR 阶段只直出用户上下文（userEmail）。为兼顾 Node 探测与隐藏浏览器探针，满足其一即代表会话正常有效。
    probe: {
      url: 'https://tokenharbor.ai/dashboard',
      match: (html) => html.includes('Free allowance') || /userEmail[\\"]*:[\\"]*[^\\",]+@[^\\",]+/.test(html),
    },
    // 免费账号要多账号轮换(#23 增补):身份优先从 Next.js SSR state 的 userEmail 抽，兜底邮箱正则。
    identity: {
      fromHtml: {
        exec: (str) => {
          const m = /userEmail[\\"]*:[\\"]*([^\\",]+)/.exec(str);
          if (m && m[1] && m[1].includes('@')) return [m[1].trim()];
          return /[\w.+-]+@[\w-]+\.[\w.]+/.exec(str);
        },
      },
    },
    // issue #24：捕获时顺手解析网页读数，存 meta.quotaSnapshot 供额度推送消费
    quota: { fromHtml: parseTokenHarborQuota },
    accountName: 'Token Harbor 网页会话',
    hint: '登录后 dashboard 才有 Free allowance 配额；凭据只存本机（账号库加密），同步到 10Router 时按 creditDaddyWebSession 形状传输。',
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    provider: 'xiaomi-mimo',
    label: '小米 MiMo 控制台余额',
    loginUrl: 'https://platform.xiaomimimo.com/console/balance',
    homeUrl: 'https://platform.xiaomimimo.com',
    probe: {
      url: 'https://platform.xiaomimimo.com/api/v1/userProfile',
      match: 'userId',
      accept: 'application/json, text/plain, */*',
    },
    accountName: '小米 MiMo 控制台会话',
    hint: '登录后自动抓取 UID 与控制台充值余额；通过外部配额（issue #24/26）推送到 10Router 配额追踪器显示余额卡片。',
  },
  {
    id: 'modelscope',
    name: 'ModelScope 魔搭',
    provider: 'modelscope',
    label: 'ModelScope 魔方余额',
    loginUrl: 'https://modelscope.cn',
    homeUrl: 'https://modelscope.cn',
    // 魔方余额 API 本身就是探测（GET /openapi/v1/magicubes/balance 带会话 cookie）；
    // 每日魔方额度为登录自动发放（前端无 claim 端点），故无签到自动化，只读余额出卡。
    cookieUrls: ['https://modelscope.cn', 'https://www.modelscope.cn'],
    verify: 'api',
    accountName: 'ModelScope 网页会话',
    identity: { fromHtml: /[\w.+-]+@[\w-]+\.[\w.]+/ },
    hint: '登录魔搭后自动抓取魔方（Magicube）余额；每日额度自动发放无需签到，token 只存本机，余额数字推 10Router 出卡（同名认领可挂连接卡）。',
  },
  {
    id: 'river',
    name: 'River AI',
    provider: 'river',
    label: 'River AI 免费额度',
    loginUrl: 'https://console.river.ai',
    homeUrl: 'https://console.river.ai',
    // 凭据主体是 WorkOS 会话——实测（2026-10-14）SPA 的 token 只在内存 Map，localStorage
    // 通常为空；持久会话走 cookie（WORKOS_REFRESH_SESSION @ auth.console.river.ai 等）。
    // 收割面必须覆盖**三个源**（console / auth / login 子域），storage 键做前缀扫描兜底。
    // 探测/身份/额度由 daemon 的 river 线一步完成（cookie 直连 → Bearer → 刷新兑换），不走 HTML 探针。
    storageKeys: ['workos:access-token', 'workos:refresh-token', 'workos:expires-at', 'workos:user'],
    storagePrefixes: ['workos:'],
    cookieUrls: ['https://console.river.ai', 'https://auth.console.river.ai', 'https://login.console.river.ai'],
    verify: 'api',
    accountName: 'River AI 网页会话',
    hint: '登录 console.river.ai 后自动抓取 WorkOS 会话与 Billing 余额（$25 免费额度）；token 只存本机，推送 10Router 只带余额数字，会话过期自动刷新（单次轮换即时落盘）。',
  },
  {
    id: 'longcat',
    name: 'LongCat',
    provider: 'longcat',
    label: 'LongCat Token 资源包',
    loginUrl: 'https://longcat.chat/pc/login',
    homeUrl: 'https://longcat.chat',
    // 资源包汇总 API 即探测：带对 cookie 返 200 {code:0}，未登录 401「用户未登录」（2026-10-15 实测）
    probe: {
      url: 'https://longcat.chat/api/pay/quota/metering/token-packs/summary',
      match: '"code"',
      accept: 'application/json, text/plain, */*',
    },
    verify: 'api',
    accountName: 'LongCat 网页会话',
    hint: '登录 longcat.chat 后自动抓取 Token 资源包余量与逐包明细（当前包 + 其他包，按官方消耗顺序排列）；推送 10Router 只带 token 数字，会话 cookie 只存本机。',
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

function testProbeMatch(site, text) {
  if (!site?.probe?.match) return true;
  if (typeof site.probe.match === 'function') return Boolean(site.probe.match(text));
  return text.includes(site.probe.match);
}

/**
 * 探测一份会话 cookie 是否仍然有效。
 * 探测走 fetchJsonRace（跟随全局代理配置——Token Harbor 对大陆/港澳有封锁，出口代理是必须项）。
 * @returns {Promise<{ok: boolean, reason?: 'invalid'|'no-match'|'http'|'network', status?: number, html?: string}>}
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
    if (!testProbeMatch(site, text)) {
      // 被挡回登录页 = 会话失效（与 10Router 的 AUTH_EXPIRED 分类对齐），不是「页面结构变化」
      return { ok: false, reason: looksLikeLoginPage(text) ? 'invalid' : 'no-match', status: r.status };
    }
    return { ok: true, status: r.status, html: text };
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
  if (!testProbeMatch(site, text)) {
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

/** 从浏览器探针 HTML 里抽额度读数(site.quota.fromHtml);解析不出返 null,不影响既有行。 */
export function extractQuotaSnapshot(site, html) {
  if (!site.quota || typeof site.quota.fromHtml !== 'function') return null;
  try { return site.quota.fromHtml(html) || null; } catch { return null; }
}

/** 归户键的短哈希(不暴露身份原文;merge/dedupe 都只比对它) */
export function identityHashOf(value) {
  if (!value) return null;
  let h = 0;
  const s = String(value);
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) | 0) >>> 0;
  return 'ih' + h.toString(36);
}

/**
 * 行名是否属于「自动名家族」（站点默认名[+身份后缀] / Xiaomi MiMo (UID: …) / River AI (…) / ModelScope (…)）。
 * 自动名可以随身份解析升级（如「ModelScope (会话)」→「ModelScope (x@y.com)」）；
 * 不在家族里的名字视为**用户手改的备注名**（10R 同名认领键），一律不动——
 * 这层判定独立于 meta.renamed 标记，把历史改名（旧版无标记）也保护进来。
 */
export function isAutoGeneratedName(site, name) {
  const n = String(name || '');
  if (!n) return true;   // 无名 → 允许回填自动名
  const acc = String(site?.accountName || '');
  const escaped = acc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (acc && new RegExp(`^${escaped}(\\(.+\\))?$`).test(n))
    || /^Xiaomi MiMo \(UID: .+\)$/.test(n)
    || /^River AI \(.+\)$/.test(n)
    || /^ModelScope \(.+\)$/.test(n);
}

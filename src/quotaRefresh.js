/**
 * 10Router 外配额卡「刷新配额」回调（CD 侧接口）：
 *   10R 外配额卡的刷新按钮拿到载荷里的 refreshUrl → POST 回 CD → CD 现拉该 source 的
 *   最新余额并推卡（runQuotaPush 只推这一路）→ 10R 重读快照，卡片即显新数字。
 *
 * 安全模型（延续「推载荷只带标量、凭据材料禁止入载荷」）：
 *   - refreshUrl 里**没有裸令牌**——`sig = HMAC-SHA256(quotaRefreshToken, "v1\n<source>\n<exp>")`，
 *     密钥只存本机 settings.json（0600），永不出仓；载荷里只有 source / exp / sig 三个标量。
 *   - 签名时效 8 天（> 10R 快照 TTL 7 天），每轮推送滚动换新；过期 = 卡片先旧后失效，重推即恢复。
 *   - 触发接口本身只做「拉数字 → 推给**你自己配置的** 10Router」，响应不含任何账号数据。
 *   - 限流 20 次/分/IP，防 LAN 熊孩子拿它当上游 API 打点器。
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { withSettings } from './store.js';
import { readRuntime } from './bgdaemon.js';
import { logger } from './logger.js';

const SIGN_TTL_SEC = 8 * 24 * 3600;   // 8 天（覆盖 10R 快照 7 天 TTL，推送节奏内滚动续签）
const DEFAULT_PORT = 47860;

/** 本机签名密钥：settings.quotaRefreshToken，缺失时随机生成并落盘（0600 数据目录） */
export async function ensureQuotaRefreshToken() {
  return withSettings((s) => {
    if (!s.quotaRefreshToken || typeof s.quotaRefreshToken !== 'string' || s.quotaRefreshToken.length < 20) {
      s.quotaRefreshToken = crypto.randomBytes(24).toString('hex');
    }
    return s.quotaRefreshToken;
  });
}

/** 面板/回调可达基址：settings.quotaRefreshBase 可覆盖；默认按运行态 host:port 推导 */
export function quotaRefreshBase() {
  const rec = readRuntime() || {};
  const port = Number(rec.port) || DEFAULT_PORT;
  let host = String(rec.host || '127.0.0.1');
  if (host === '0.0.0.0' || host === '::') {
    host = firstLanIPv4() || '127.0.0.1';
  }
  return { host, port, derived: `http://${host.includes(':') ? `[${host}]` : host}:${port}` };
}

function firstLanIPv4() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it && it.family === 'IPv4' && !it.internal && it.address) return it.address;
      }
    }
  } catch {}
  return null;
}

async function sign(source, expSec) {
  const token = await ensureQuotaRefreshToken();
  return crypto.createHmac('sha256', token).update(`v1\n${source}\n${expSec}`).digest('hex');
}

/**
 * 为某个 source 生成 refreshUrl（每轮推送调用，签名滚动续期）。
 * @param {string} source  外配额 source（xiaomi-mimo-… / river-… / modelscope-… / tokenharbor）
 * @param {{base?: string, nowMs?: number}} opts  base 覆盖基址（测试注入）
 */
export async function quotaRefreshUrl(source, { base, nowMs } = {}) {
  if (!source) return undefined;
  const b = base || (await loadBaseFromSettings());
  const expSec = Math.floor((nowMs ?? Date.now()) / 1000) + SIGN_TTL_SEC;
  const sig = await sign(source, expSec);
  return `${b}/api/quota-refresh?source=${encodeURIComponent(source)}&exp=${expSec}&sig=${sig}`;
}

async function loadBaseFromSettings() {
  // settings.quotaRefreshBase 优先（反代 / 多网卡场景手填），否则按运行态推导
  const { loadSettings } = await import('./store.js');
  const s = await loadSettings().catch(() => ({}));
  const custom = String(s.quotaRefreshBase || '').trim().replace(/\/+$/, '');
  return custom || quotaRefreshBase().derived;
}

/**
 * 校验签名（时序安全比较）。source/exp/sig 全部来自查询串，缺一即拒。
 * @returns {Promise<{ok: boolean, reason?: 'expired'|'bad-sig'|'bad-params'}>}
 */
export async function verifyQuotaRefresh({ source, exp, sig }, { nowMs } = {}) {
  const src = String(source || '');
  const expSec = Number(exp);
  const given = String(sig || '');
  if (!src || !Number.isFinite(expSec) || !/^[0-9a-f]{32,128}$/i.test(given)) {
    return { ok: false, reason: 'bad-params' };
  }
  const nowSec = Math.floor((nowMs ?? Date.now()) / 1000);
  if (expSec < nowSec) return { ok: false, reason: 'expired' };
  // 给未来时间戳留 1 天容差（防时钟偏移），但不允许远期签名常驻
  if (expSec > nowSec + SIGN_TTL_SEC + 86_400) return { ok: false, reason: 'bad-params' };
  const expected = await sign(src, expSec);
  const a = Buffer.from(given.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return { ok: a.length === b.length && crypto.timingSafeEqual(a, b), reason: a.length === b.length ? undefined : 'bad-sig' };
}

/** 单 IP 滑动窗口限流（进程内，重启归零）：默认 20 次/分钟 */
const hits = new Map();   // ip → number[]
export function refreshRateLimited(ip, { limit = 20, windowMs = 60_000, nowMs } = {}) {
  const now = nowMs ?? Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > limit;
}

export function logRefresh(source) {
  logger.info('10R', '外配额卡刷新回调触发（{source}）——现拉并推卡', { source });
}

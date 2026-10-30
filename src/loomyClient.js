/**
 * 讯飞 Loomy API 客户端 — 模型接口探活与账号信息校验。
 *
 * 端点：
 *   GET https://loomyad.xunfei.cn/api/v1/models
 * 鉴权：
 *   Header: `token: <session>`
 *
 * 返回模型列表证明凭据有效。
 */

export const LOOMY_BASE_URL = 'https://loomyad.xunfei.cn/api/v1';

/** 验证 Loomy 凭据有效性并获取可用模型数量 */
export async function fetchLoomyModels(token) {
  if (!token) throw new Error('缺少 Loomy session token');
  const res = await fetch(`${LOOMY_BASE_URL}/models`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      token: String(token).trim(),
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error('Loomy session 已过期或无效，请在 Loomy 客户端重新登录');
    err.auth = true;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Loomy /models 接口返回失败: HTTP ${res.status} ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  if (data?.code === '100002') {
    const err = new Error('Loomy 提示缺少 token 或鉴权失败');
    err.auth = true;
    throw err;
  }

  const models = data?.data || data?.models || [];
  return models;
}

/** verify 接口：添加账号时的基本资料校验 */
export async function verifyLoomyAccount(account) {
  const token = account?.token || account?.apiKey || account?.session;
  if (!token) throw new Error('账号缺少 session token');

  const models = await fetchLoomyModels(token);
  const uid = account?.uid || account?.userid || null;
  const phone = account?.phone || '';

  const displayName = phone
    ? `Loomy (${phone.slice(0, 3)}****${phone.slice(-4)})`
    : uid
      ? `Loomy (${uid.slice(-6)})`
      : 'Loomy 账号';

  return {
    name: displayName,
    uid: uid || undefined,
    modelCount: models.length,
  };
}

/** quota 接口：提供给 CreditDaddy 配额总览 */
export async function fetchLoomyQuota(account) {
  const token = account?.token || account?.apiKey || account?.session;
  const models = await fetchLoomyModels(token);

  return {
    total: models.length,
    used: 0,
    remaining: models.length,
    exceeded: false,
    parts: [
      {
        name: '免费模型池',
        total: models.length,
        used: 0,
        remaining: models.length,
        recurring: true,
      },
    ],
  };
}

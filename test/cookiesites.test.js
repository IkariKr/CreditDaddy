/**
 * 通用 cookie 站点捕获（issue #23 —— tokenharbor 为首的配置驱动接入）回归：
 * - serializeCookies 去重与拼接形状（handler 接受的 plain string）
 * - verifySiteCookie 的四种结局（invalid / no-match / http / network）
 * - daemon 捕获端点的完整流：探测通过 → 入库去重 → 同步载荷形状（providerSpecificData.creditDaddyWebSession）
 * - tokenharbor 账号不得落进 Qoder 页签（productOf → 'tokenharbor' 守卫）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-csite-'));

const { serializeCookies, getSite, siteForLoginUrl, verifySiteCookie, COOKIE_SITES } = await import('../src/cookieSites.js');
const { buildConnPayload, mapProviderId } = await import('../src/tenrouterAccounts.js');
const { productOf } = await import('../src/constants.js');

test('serializeCookies：同名按后者去重、拼成 plain string', () => {
  const out = serializeCookies([
    { name: 'a', value: '1' },
    { name: 'a', value: '2' },   // host-only 后写覆盖域级
    { name: 'b', value: 'x y' },
    { name: '' , value: 'drop' },
    null,
  ]);
  assert.equal(out, 'a=2; b=x y');
});

test('配置表：getSite / siteForLoginUrl 命中与未命中', () => {
  assert.equal(getSite('tokenharbor').provider, 'tokenharbor');
  assert.equal(getSite('nope'), null);
  assert.equal(siteForLoginUrl('https://tokenharbor.ai/login').id, 'tokenharbor');
  assert.equal(siteForLoginUrl('https://tokenharbor.ai/dashboard').id, 'tokenharbor');
  assert.equal(siteForLoginUrl('https://qoder.com/auth/login'), null);
});

test('verifySiteCookie：invalid / no-match / http / network 四种结局 + 登录页壳分类', async () => {
  const site = COOKIE_SITES[0];
  const fake = (status, text = '') => async () => ({ status, text: async () => text });
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(401) })).reason, 'invalid');
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(200, '<html>nothing here</html>') })).reason, 'no-match');
  // 会话过期被挡回登录页 = invalid(与 10Router AUTH_EXPIRED 分类对齐),不是 layout-change
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(200, '<html><title>Sign in</title><form>log in</form></html>') })).reason, 'invalid');
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(500) })).reason, 'http');
  assert.equal((await verifySiteCookie(site, 'c', { fetchImpl: fake(200, '<html>Free allowance 20% used</html>') })).ok, true);
  const netFail = async () => { throw new Error('boom'); };
  assert.equal((await verifySiteCookie(site, 'c', { fetchImpl: netFail })).reason, 'network');
});

test('verifySiteCookie：探测按浏览器形头发送（裸 UA 会拿到空壳页误判 no-match）', async () => {
  const site = COOKIE_SITES[0];
  let seen = null;
  const spy = async (url, init) => { seen = init.headers; return { status: 200, text: async () => '<html>Free allowance 10% used</html>' }; };
  await verifySiteCookie(site, 'alive=1', { fetchImpl: spy });
  assert.ok(seen, 'fetch 必须被调用');
  assert.ok(/Chrome\//.test(seen['User-Agent'] || ''), '要有浏览器 UA(裸 undici UA 会被边缘节点喂空壳页)');
  assert.ok((seen['Accept'] || '').includes('text/html'), 'Accept 为 HTML');
  assert.ok((seen['Referer'] || '').startsWith('https://tokenharbor.ai'), 'Referer 带站点首页');
  assert.equal(seen['Cookie'], 'alive=1');
});

test('buildConnPayload：tokenharbor 按通用形状挂会话；qoder 老形状不回归；无会话不带字段', () => {
  const th = { id: 'x1', provider: 'tokenharbor', token: 'a=b; c=d', name: 'Token Harbor 网页会话', meta: { cookieSiteSession: { cookie: 'a=b; c=d', capturedAt: '2026-10-11T00:00:00Z' } } };
    const p1 = buildConnPayload(th, 'tokenharbor-free');
  assert.equal(p1.provider, 'tokenharbor-free');
  // sync map must land on the monitor card (wallet card is /v1 transport, cookie doesn't belong there)
  assert.equal(mapProviderId('tokenharbor'), 'tokenharbor-free');

  const q = { id: 'x2', provider: 'qoder', token: 'jwt', uid: 'u123', name: 'Q', meta: { qoderWebSession: { cookie: 's=1', capturedAt: '2026-10-01T00:00:00Z' } } };
  const p2 = buildConnPayload(q, 'qoder');
  assert.equal(p2.providerSpecificData.creditDaddyWebSession.cookie, 's=1');
  assert.equal(p2.providerSpecificData.userId, 'u123');

  const plain = { id: 'x3', provider: 'workbuddy', token: 't', name: 'W' };
  assert.equal(buildConnPayload(plain, 'codebuddy-cn').providerSpecificData, undefined);
});

test('tokenharbor 账号不落入 Qoder 页签（productOf 守卫，面板列表隔离）', () => {
  assert.equal(productOf('tokenharbor'), 'tokenharbor');
  assert.notEqual(productOf('tokenharbor'), 'qoder');
});

test('daemon 捕获端点：探测通过入库去重；401 拒绝；/api/cookie-sites 报捕获时间', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-csite-e2e-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ panelKey: '', panelKeyHash: '' }));
  // 本地假站:探测地址由测试后门 CD_PROBE_TOKENHARBOR 指进来
  const fake = http.createServer((req, res) => {
    if (req.headers.cookie?.includes('alive=1')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Free allowance 40% used</html>'); }
    else { res.writeHead(401); res.end('no'); }
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const probePort = fake.address().port;

  const savedHome = process.env.CREDITDADDY_HOME;
  const savedProbe = process.env.CD_PROBE_TOKENHARBOR;
  process.env.CREDITDADDY_HOME = home;
  process.env.CD_PROBE_TOKENHARBOR = `http://127.0.0.1:${probePort}/dashboard`;
  let daemon;
  try {
    daemon = await import('../src/daemon.js');
    const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
    try {
      const post = (body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/cookie-sites/tokenharbor/capture', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });

      const bad = await post({ cookie: 'dead=0', diag: { cookieCount: 1 } });
      assert.equal(bad.status, 401, '探测 401 必须回 401（会话不可用）');

      const ok1 = await post({ cookie: 'alive=1; theme=dark', diag: { cookieCount: 2 } });
      assert.equal(ok1.status, 200);
      assert.ok(ok1.body.accountId);

      // 第二次捕获同一站点 → 原位更新,不新增行(provider 单例合并)
      const ok2 = await post({ cookie: 'alive=1; theme=light', diag: { cookieCount: 2 } });
      assert.equal(ok2.status, 200);
      assert.equal(ok2.body.accountId, ok1.body.accountId, '同一站点重复捕获应原位更新');

      const sites = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/cookie-sites' }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        req.end();
      });
      const row = sites.sites.find((x) => x.id === 'tokenharbor');
      assert.equal(row.accountId, ok1.body.accountId);
      assert.ok(row.capturedAt, '捕获时间已回显');

      const accounts = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
      const acc = accounts.find((a) => a.provider === 'tokenharbor');
      assert.equal(accounts.filter((a) => a.provider === 'tokenharbor').length, 1, '不重复建行');
      assert.equal(acc.token, 'alive=1; theme=light');
      assert.equal(acc.meta.cookieSiteSession.cookie, 'alive=1; theme=light');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.CREDITDADDY_HOME = savedHome;
    if (savedProbe === undefined) delete process.env.CD_PROBE_TOKENHARBOR;
    else process.env.CD_PROBE_TOKENHARBOR = savedProbe;
    fake.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

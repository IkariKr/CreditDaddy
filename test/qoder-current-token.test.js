/**
 * Qoder「客户端当前」判定：按 auth.v1.dat 里解出来的 token 对齐账号库，而不是只比 uid。
 *
 * 现场：双渠道切号后（A→B 之后 B 没按钮、B→A 之后 A 没按钮），界面上「当前账号」对不上实际登录，
 * 切换键跟着一起消失。用两个同渠道账号 + 一份可解密的 auth.v1.dat 钉死：
 *   1. 按 token 认出当前账号（uid 相同但 token 换了也一样）
 *   2. 切号后 status 立即可见新当前账号（缓存被主动清掉）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 密钥要在测试体里造：模块加载期就调 powershell，Linux runner 会在收集阶段
// 直接 ENOENT 崩掉整个文件，{ skip } 形同废纸（CI 三条 job 全红的真因）。
function makeDpapiKey() {
  const key = crypto.randomBytes(32);
  const script = 'Add-Type -AssemblyName System.Security;'
    + '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
    + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const prot = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, input: key.toString('base64'), timeout: 20_000, encoding: 'utf8' }).trim();
  return { key, encryptedKey: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(prot, 'base64')]).toString('base64') };
}

test('Qoder 当前登录按 token 对齐：同 uid 换 token 也认得出；切号后 status 立即更新', { skip: process.platform !== 'win32' && '依赖 DPAPI' }, async () => {
  const DPAPI_KEY = makeDpapiKey();
  const encryptAuth = (text) => {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', DPAPI_KEY.key, nonce);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-current-'));
  const appData = path.join(root, 'Roaming');
  const dir = path.join(appData, 'com.qoder.app.stable');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: DPAPI_KEY.encryptedKey } }));
  const prev = { APPDATA: process.env.APPDATA, CREDITDADDY_HOME: process.env.CREDITDADDY_HOME };
  process.env.APPDATA = appData;
  process.env.CREDITDADDY_HOME = path.join(root, 'cd');
  const accountsApi = await import('../src/accounts.js');
  const daemon = await import('../src/daemon.js');
  let server;
  try {
    const file = path.join(dir, 'auth.v1.dat');
    const mkAuth = (uid, token) => ({ token, refreshToken: `rt-${uid}`, expiresAt: '2099-01-01T00:00:00.000Z', user: { id: uid, name: uid, email: `${uid}@example.com` } });
    // 账号库里的 A 与文件里登录的 A 是同 uid 不同 token（客户端静默刷新过 / 重新登录过）
    const idA = (await accountsApi.addAccount({ provider: 'qoder', token: 'dt-old-a', uid: 'uidA', name: 'uidA', source: 'local-app', meta: { qoderAuth: mkAuth('uidA', 'dt-old-a'), qoderAuthFile: file } }, { trusted: true })).account.id;
    const idB = (await accountsApi.addAccount({ provider: 'qoder', token: 'dt-b', uid: 'uidB', name: 'uidB', source: 'local-app', meta: { qoderAuth: mkAuth('uidB', 'dt-b'), qoderAuthFile: file } }, { trusted: true })).account.id;
    fs.writeFileSync(file, encryptAuth(JSON.stringify(mkAuth('uidA', 'dt-new-a'))));

    const { server: s, port } = await daemon.startDaemon(0, '127.0.0.1');
    server = s;
    const status = async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json();

    const st1 = await status();
    assert.equal(st1.qoderCurrent.qoder, idA, '按 token 对上的账号就是当前账号');
    assert.equal(st1.qoderCurrentToken.qoder, 'dt-new-a', '当前 token 原样可见（面板据此高亮真当前账号）');

    const r = await fetch(`http://127.0.0.1:${port}/api/accounts/${idB}/switch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.json().catch(() => ({}))));
    // 不放缓存：切完马上打 status，必须是 B
    const st2 = await status();
    assert.equal(st2.qoderCurrent.qoder, idB);
    assert.equal(st2.qoderCurrentToken.qoder, 'dt-b');
  } finally {
    server?.close();
    // 日志归档流还指着 root/cd/logs：不先关掉就 rm，Windows 会 ENOTEMPTY
    const { closeArchiveStream } = await import('../src/logger.js');
    await closeArchiveStream();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (let i = 0; i < 8; i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
  }
});

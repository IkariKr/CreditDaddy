/**
 * codearts（华为云码道，issue #40）骨架测试：
 *  - COOKIE_SITES 站点注册与 cookieUrls 覆盖 console/auth 两域
 *  - provider 注册表（PROVIDERS / productOf / PROVIDER_LABEL）
 *  - probeCodeartsSession 端点未回填时恒「待考古」（不误杀已捕获会话）
 * 端点考古回填后在此追加：签到状态机（成功 / 已领 / 未登录 / 限流）+ 余额解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-codearts-'));
process.env.CREDITDADDY_HOME = path.join(root, 'data');

const { COOKIE_SITES, getSite, siteForLoginUrl } = await import('../src/cookieSites.js');
const constants = await import('../src/constants.js');
const { CODEARTS_API, CODEARTS_SERVICE_BASE, probeCodeartsSession } = await import('../src/codeartsClient.js');

test('码道站点已注册：console 链接可归户，cookieUrls 覆盖华为云统一登录域', () => {
  const site = getSite('codearts');
  assert.ok(site, 'COOKIE_SITES 应含 codearts');
  assert.equal(site.provider, 'codearts');
  assert.equal(site.entryOnly, undefined, 'codearts 需要会话捕获（非 entryOnly）');
  assert.ok(site.cookieUrls.some((u) => u.startsWith('https://auth.huaweicloud.com')), '必须覆盖 auth 域才能在登录页收割');
  assert.equal(siteForLoginUrl('https://auth.huaweicloud.com/authui/login?id=xxx')?.id, 'codearts');
  assert.equal(siteForLoginUrl('https://console.huaweicloud.com/agentarts/?region=cn-southwest-2#/home/overview')?.id, 'codearts');
});

test('provider 注册表齐全：PROVIDERS / productOf / PROVIDER_LABEL 三处一致', () => {
  assert.ok(constants.PROVIDERS.includes('codearts'));
  assert.equal(constants.productOf('codearts'), 'codearts');
  assert.equal(constants.PROVIDER_LABEL.codearts, '码道 CodeArts');
});

test('probeCodeartsSession：端点未回填时返回 pending，不误杀会话', async () => {
  const r = await probeCodeartsSession('AWS-session-cookie=1');
  assert.equal(r.pending, true, '端点为 null 必须走待考古分支');
  assert.equal(r.ok, false);
  assert.match(r.error, /考古/);
  // 常量完整性：签到/余额两个端点占位存在（回填时改这里那行 null 即可）
  assert.equal(CODEARTS_API.checkin.path, null);
  assert.equal(CODEARTS_API.points.path, null);
  assert.equal(CODEARTS_SERVICE_BASE, 'https://console.huaweicloud.com/agentarts');
});

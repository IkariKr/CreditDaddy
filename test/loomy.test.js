import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOMY_AUTH_CONFIG } from '../src/loomyAuth.js';
import { detectLoomy, readCredential } from '../src/loomyLocal.js';
import { productImpl } from '../src/providers.js';
import { TENROUTER_PROVIDER_MAP } from '../src/tenrouterAccounts.js';

test('Loomy 供应商产品线与同步配置', () => {
  assert.equal(typeof productImpl('loomy'), 'object');
  assert.equal(TENROUTER_PROVIDER_MAP.loomy, 'loomy');
});

test('Loomy 统一认证配置常量存在', () => {
  assert.equal(LOOMY_AUTH_CONFIG.baseUrl, 'https://account.xfinfr.com');
  assert.equal(LOOMY_AUTH_CONFIG.appId, 'GM3LOOMY');
  assert.ok(LOOMY_AUTH_CONFIG.accessKeyId);
  assert.ok(LOOMY_AUTH_CONFIG.accessKeySecret);
});

test('Loomy 本机探测（Windows 本地环境）', () => {
  const d = detectLoomy();
  assert.equal(typeof d.clientInstalled, 'boolean');
  assert.equal(typeof d.running, 'boolean');
  assert.equal(typeof d.signedIn, 'boolean');
});

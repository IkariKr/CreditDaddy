/**
 * fnOS 统一网关反代（issue #39）——CreditDaddy 面板经 fnOS 网关同源访问的两跳代理：
 *
 *   fnOS 网关(HTTPS 443) → (gatewayPrefix /app/creditdaddy) → app.sock → 本代理 → 127.0.0.1:47860
 *
 * 为什么需要：桌面/APP 窗口按「当前访问主机名」拼 URL（写死 http + 47860 端口），
 * 公网 HTTPS 反代 / Tunnel 只服务 443，`http://nas.example.com:47860/` 不可达 → 白屏。
 * 走统一网关后窗口请求与页面同源（443 直达），公网即开即用。
 *
 * 设计参照 deepseek-harness-fnos 的 cmd/proxy.py（app.sock + gatewayPrefix 同款机制），
 * 用 Node 实现以贴合 CreditDaddy 零依赖形态（fnOS 依赖应用 nodejs_v24 本就存在）。
 *
 * 与 dsh 版的三个差异：
 *   1. 流式透传：CreditDaddy 的三个本地网关（/gateway/.../v1/messages）是 Anthropic SSE
 *      长流——必须流式回写（dsh 版 buffer 全量读会吊死流式输出）；/api/logs 等普通接口字节小不受影响。
 *   2. 无需 HTML 重写：panel.html 全部相对路径（/api、/gateway、/logs），同源反代天然兼容，
 *      无 dsh 的绝对资源路径前缀改写问题。
 *   3. 无 WebSocket：面板与 daemon 之间只有 HTTP + SSE 长响应，仅需处理 HTTP 升级外的场景。
 *
 * Origin/Referer 重写为回环地址：daemon 的密码门 / Host 校验按同源判定（fnOS 网关注入的
 * Host 是外部域名，Origin 也是），不改写会把同源请求当跨域。
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SOCK_PATH = process.env.SOCK_PATH || '/tmp/creditdaddy_app.sock';
const BACKEND_PORT = Number(process.env.CD_PORT || 47860);
const BACKEND_HOST = process.env.CD_HOST || '127.0.0.1';
const GATEWAY_PREFIX = (process.env.GATEWAY_PREFIX || '/app/creditdaddy').replace(/\/+$/, '');
const PROXY_TCP_ADDR = '127.0.0.1';

// fnOS 网关以 appname 小写为前缀；本应用 appname=creditdaddy
const LOOPBACK = `http://${BACKEND_HOST === '0.0.0.0' ? '127.0.0.1' : BACKEND_HOST}:${BACKEND_PORT}`;

/** Origin/Referer 的 scheme://host 段替换为回环地址（保留 path/query） */
function rebaseOrigin(url) {
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(url || '');
  if (!m) return url;
  return LOOPBACK + (m[2] || '');
}

/** 请求头进入后端前的清理与改写 */
function backendHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const kl = k.toLowerCase();
    if (kl === 'host' || kl === 'connection' || kl === 'keep-alive' || kl === 'transfer-encoding' || kl === 'upgrade') continue;
    if (Array.isArray(v)) { headers[k] = v.join(', '); continue; }
    headers[k] = v;
  }
  headers['Host'] = `${BACKEND_HOST === '0.0.0.0' ? '127.0.0.1' : BACKEND_HOST}:${BACKEND_PORT}`;
  // Node 收的请求头键是小写（http 模块规范）；写回时用小写键不改大小写
  if (headers['origin']) headers['origin'] = rebaseOrigin(headers['origin']);
  if (headers['referer']) headers['referer'] = rebaseOrigin(headers['referer']);
  // 网关注入的 X-Forwarded-* 透传原样保留（daemon 不依赖它们做安全判定）
  return headers;
}

const server = http.createServer((req, res) => {
  // 剥网关前缀（fnOS 把 /app/creditdaddy/* 转给我们时带全前缀）
  let p = req.url || '/';
  if (GATEWAY_PREFIX && (p === GATEWAY_PREFIX || p.startsWith(GATEWAY_PREFIX + '/'))) {
    p = p.slice(GATEWAY_PREFIX.length) || '/';
  }
  const headers = backendHeaders(req);
  const upstream = http.request(
    { host: BACKEND_HOST === '0.0.0.0' ? '127.0.0.1' : BACKEND_HOST, port: BACKEND_PORT, path: p, method: req.method, headers },
    (up) => {
      const ct = (up.headers['content-type'] || '').toLowerCase();
      // 当响应为 HTML 时，重写内部绝对路径为网关前缀（参照 dsh-dashboard 做法），
      // 彻底解决 fnOS iframe 桌面窗口内请求 /api/* 丢前缀导致 404 的问题。
      // 压缩响应（gzip/br 等）解码成 utf8 再替换必然产生乱码——按原文透传
      if (ct.includes('text/html') && GATEWAY_PREFIX && !up.headers['content-encoding']) {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf8');
          text = text.replaceAll('"/api/', `"${GATEWAY_PREFIX}/api/`);
          text = text.replaceAll("'/api/", `'${GATEWAY_PREFIX}/api/`);
          text = text.replaceAll('"/gateway/', `"${GATEWAY_PREFIX}/gateway/`);
          text = text.replaceAll("'/gateway/", `'${GATEWAY_PREFIX}/gateway/`);
          text = text.replaceAll('"/assets/', `"${GATEWAY_PREFIX}/assets/`);
          text = text.replaceAll("'/assets/", `'${GATEWAY_PREFIX}/assets/`);
          if (text.includes('<head>') && !text.includes('<base')) {
            text = text.replace('<head>', `<head><base href="${GATEWAY_PREFIX}/">`);
          }
          const buf = Buffer.from(text, 'utf8');
          const hdrs = { ...up.headers, 'content-length': buf.length };
          delete hdrs['transfer-encoding'];
          res.writeHead(up.statusCode || 200, hdrs);
          res.end(buf);
        });
      } else {
        // 流式透传（SSE / chunked 关键路径）：状态行 + 头原样，body 逐 chunk 回写
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res, { end: true });
      }
    },
  );
  // 请求体转发：仅当客户端真的带 body（POST/PUT 等）才 pipe——GET 也 pipe 会在
  // upstream 响应到达前提前 end 上游请求，连接被重置（ECONNRESET → 客户端 408/502）
  const contentLength = Number(req.headers['content-length']) || 0;
  if (contentLength > 0 || (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && req.method !== 'DELETE')) {
    req.pipe(upstream, { end: true });
  } else {
    upstream.end();
  }
  // 客户端中途断开（关标签页/刷新）时释放对后端的连接——SSE 长响应不主动
  // destroy 会一直挂着，反复开关页面累积泄漏上游 socket
  req.on('error', () => upstream.destroy());
  res.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
  upstream.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    try { res.end(`gateway proxy: ${e.message}`); } catch { /* 客户端已断开 */ }
  });
});

function main() {
  if (process.env.PROXY_TCP_PORT) {
    // 测试 / 调试口（可选)：fnOS 上不设此变量，走 app.sock
    server.listen(Number(process.env.PROXY_TCP_PORT), '127.0.0.1', () => {
      console.log(`creditdaddy gateway proxy: tcp://${PROXY_TCP_ADDR}:${process.env.PROXY_TCP_PORT} -> http://${BACKEND_HOST}:${BACKEND_PORT} (prefix=${GATEWAY_PREFIX || '(none)'})`);
    });
  } else {
    try { os.unlinkSync(SOCK_PATH); } catch { /* 不存在 */ }
    server.listen(SOCK_PATH, () => {
      console.log(`creditdaddy gateway proxy: ${SOCK_PATH} -> http://${BACKEND_HOST}:${BACKEND_PORT} (prefix=${GATEWAY_PREFIX || '(none)'})`);
    });
  }
  process.on('SIGTERM', () => { try { os.unlinkSync(SOCK_PATH); } catch { /* ignore */ } process.exit(0); });
  process.on('SIGINT', () => { try { os.unlinkSync(SOCK_PATH); } catch { /* ignore */ } process.exit(0); });
}

main();

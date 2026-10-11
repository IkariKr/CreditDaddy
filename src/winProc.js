/**
 * Windows 进程探测的高性能公共实现。
 *
 * 优化重点：
 *   1. 原版对每个 exe 单独跑一次 tasklist.exe，多软件多变体导致单次 /api/status 串行阻塞 5~6 秒；
 *   2. 本实现采用「全量快照 + 短缓存 (TTL 5s) + 后台异步自动预热刷新」；
 *   3. 无论查询多少个不同客户端，同周期内仅消耗一次 tasklist（甚至 0ms 纯读内存缓存）；
 *   4. 支持 invalidateProcCache()，在杀死进程（terminate*）后强制拉取最新状态。
 */

import { execFile, execFileSync } from 'node:child_process';

/** tasklist 的 Buffer 输出 → 字符串（GBK 优先，解码器不可用时退回 utf8） */
export function decodeTasklist(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

let processCache = new Set();
let lastCacheTime = 0;
let isRefreshing = false;
const CACHE_TTL_MS = 5000;

function parseTasklistOutput(buf) {
  const str = decodeTasklist(buf);
  const set = new Set();
  for (const line of str.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CSV 格式: "imagename.exe","pid","session","session#","mem"
    const m = /^"([^"]+)"/.exec(trimmed);
    if (m) {
      set.add(m[1].toLowerCase());
    } else {
      // 兼容非 CSV 的标准 /NH 格式（第一列通常为映像名称）
      const firstCol = trimmed.split(/\s+/)[0];
      if (firstCol && firstCol.toLowerCase().endsWith('.exe')) {
        set.add(firstCol.toLowerCase());
      }
    }
  }
  return set;
}

/** 异步刷新进程缓存（非阻塞） */
export function refreshProcessCacheAsync() {
  if (process.platform !== 'win32' || isRefreshing) return;
  isRefreshing = true;
  execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 5000,
  }, (err, stdout) => {
    isRefreshing = false;
    if (!err && stdout && stdout.length > 0) {
      try {
        processCache = parseTasklistOutput(stdout);
        lastCacheTime = Date.now();
      } catch {}
    }
  });
}

/** 手动作废缓存（在 terminate 等操作后调用） */
export function invalidateProcCache() {
  lastCacheTime = 0;
  processCache.clear();
}

/**
 * 获取当前运行进程名集合（全小写）。
 * 优先返回缓存并触发后台异步刷新；若从未拉取过且 sync=true，则进行一次同步初始化。
 */
export function getRunningProcesses({ sync = false } = {}) {
  if (process.platform !== 'win32') return new Set();
  const now = Date.now();
  const isStale = (now - lastCacheTime) > CACHE_TTL_MS;

  if (isStale) {
    if (sync || lastCacheTime === 0) {
      // 首次启动或明确要求同步
      try {
        const buf = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
          windowsHide: true,
          encoding: 'buffer',
          timeout: 5000,
        });
        processCache = parseTasklistOutput(buf);
        lastCacheTime = Date.now();
      } catch {
        // 出错回退
      }
    } else {
      // 有旧缓存，直接使用旧缓存并后台异步刷新最新状态
      refreshProcessCacheAsync();
    }
  }
  return processCache;
}

/**
 * 任一 exe 是否在运行。
 * @param {string|string[]} exes
 * @param {object} [opts]
 * @param {boolean} [opts.sync] 是否强制同步刷新
 * @returns {boolean} 查不到（命令不存在 / 超时）一律按「没在运行」处理，不阻塞调用方
 */
export function anyProcRunning(exes, { sync = false } = {}) {
  if (process.platform !== 'win32') return false;
  const running = getRunningProcesses({ sync });
  for (const exe of [].concat(exes)) {
    if (!exe) continue;
    const clean = String(exe).trim().toLowerCase();
    if (running.has(clean)) return true;
  }
  return false;
}

export function isProcRunning(exe, opts) {
  return anyProcRunning(exe, opts);
}

// 模块加载时立即在后台触发一次进程列表预热
if (process.platform === 'win32') {
  refreshProcessCacheAsync();
}


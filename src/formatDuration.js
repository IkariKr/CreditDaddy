/**
 * 冷却时长的人类可读格式（三个网关共用）。
 *   30_000   → '30 秒'
 *   60_000   → '1 分钟'
 *   120_000  → '2 分钟'
 *   240_000  → '4 分钟'
 * 不足 1 分钟的按秒显示，否则 30s 会被 Math.round 抹成「1 分钟」（或与 0 混淆）。
 */
export function formatDurationMs(ms) {
  // 冷却截止是 Date.now() + ms 算出来的，正常不会异常；但 NaN / Infinity 直接进模板
  // 会渲染成「NaN 分钟」这种鬼东西，这里统一兜成 0 秒
  const finite = Number.isFinite(ms) ? ms : 0;
  const s = Math.max(0, Math.round(finite / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  return `${m} 分钟`;
}

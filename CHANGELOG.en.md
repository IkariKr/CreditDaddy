# Changelog (English)

English changelog — recent releases translated. For the full history in Chinese, see [CHANGELOG.md](./CHANGELOG.md).

---

## [1.6.0] (2026-10-21)

> **Same-version re-release (2026-10-21)**: six fixes landed the same day after the first 1.6.0 build (tag not yet published, no public artifacts), all merged into this release. Earlier locally distributed test builds (81b02e0 / 5b5aab6 / b6f6dad etc.) are superseded by this tag build.

Theme: **Trae 9074 device-id rotation retry (#31) + WorkBuddy intl "active-claim" retirement + Doubao daily check-in as the 8th product line (#32) + MiniMax free-quota card back on 10Router with read-only check-in status (#33 plan B) + the 2026-10-21 six-fix batch**.

### ✨ New

- **Doubao (doubao.com) daily check-in (issue #32, 8th product line, web-session capture)**: endpoint shapes verified live via CDP (checked-in + unchecked) — status via the campaign detail API, claim via the landing check-in API (+200 credits/day); pure cookie auth, no a_bogus/msToken signing, server-side idempotent (duplicate claim returns `idempotent:true`, treated as already); the cookieSites probe framework now supports method/body (first JSON-API probe). Eligibility verified: **personal accounts only** (Feishu org accounts are rejected, error surfaced as-is).
- **MiniMax free-quota card back on 10Router + read-only check-in status (#33 plan B)**: pushes resumed with `checkinToday` / `streakDays` read-only fields per quota row — credentials never leave CD, 10Router only displays (badge rendering consumed by 10Router#77; older 10R ignores unknown fields). **Check-in action stays out of 10R** (read-only boundary). New `fetchMiniMaxCheckinStatus` queries without claiming; failures return null without breaking pushes.
- **WorkBuddy one-click activity claiming**: a batch-claim endpoint for temporary activities (extra compensation / first-month gifts) across all accounts from the panel.
- **Web-session probe frequency governance**: the panel's 2-minute polling no longer hits all upstreams; `/quota` reads cached snapshots by default, only the manual "Refresh" button probes live; the push loop refreshes snapshots in passing.

### 🐛 Fixed

- **Trae check-in 9074 device-id rotation retry (issue #31)**: controlled experiments confirmed derived device ids are always rejected with 9074 while the real device id succeeds — retries now **rotate the derived device id** (attempt increments) with 3s/8s/15s backoff. ⚠️ The derived-salt change rotates every account's default fingerprint once: **seeing 9074 on the first check-in after upgrading is expected**; the retry mechanism rotates ids automatically and stabilizes after a few rounds.
- **Update-log dialog experience**: opens instantly with a loading state; the online fetch recognizes the "Theme:" line format (1.5.1 entries previously showed only the title).

### 🔧 Fixed (2026-10-21 six-fix batch, see docs/incident-20261021-quota-sync.md)

- **mirasim usage syncs official-relay rows only**: calls whose upstream is the local 10Router are no longer re-imported (they were double-counted on 10Router as both codebuddy-cn and mirasim-anthropic). The viaRelay boundary has zero overlap in practice; stale duplicates on 10Router were cleaned up server-side (4,066 rows deleted, aggregates rewritten to the true 342 relay rows).
- **minimax-free legacy aggregate card cleaned up on upgrade**: the old aggregate card is DELETEd on the first push after upgrading instead of lingering for its 7-day TTL alongside the new per-account cards.
- **TraeWork→TRAE migration adaptation**: the new TRAE CN client is detected first (the retired SOLO CN's leftover directory with stale credentials is no longer preferred) + importing from an international client (trae.ai) now shows an explicit "CN edition only" warning instead of silently importing an unusable account.
- **Account-card balance refreshes right after a web-session harvest**: the harvest handler skipped the quota-cache reload, leaving stale numbers (e.g. Xiaomi ¥0.00) until a manual refresh.
- **"Free quota push settings" renamed "Quota card push settings"**: the push covers subscription/stored-value lines too, not just free ones; all four dictionaries updated.
- **i18n dictionary dead-entry cleanup**: 86 unreferenced entries ×4 languages removed (1783→1699), with two verification passes to avoid false deletions.

---

## [1.5.1] (2026-10-18)

Theme: **Trae check-in 9074 risk-control correction (issue #31) — transient rate-limit backoff retry instead of misreporting "already claimed on this device", failure messages carry the server code, network errors aggregate both causes.** No breaking changes.

### 🐛 Fixed

- Trae 9074 handled as transient rate limiting: backoff retry (3s/8s/15s) instead of marking the account "claimed"; failure toasts now include the server code; network-error causes aggregated.
- Logger runtime hardening: error listeners on rotated archive streams + the current stream (Windows EBUSY/EPERM during async writes could previously crash the daemon).

---

## [1.5.0] (2026-10-15)

Theme: **web-session capture across the board — generic browser cookie-capture framework (config-driven) + five integrations (Token Harbor / Xiaomi MiMo / River AI / ModelScope / LongCat) + 10Router quota-card sync**. No breaking changes.

Earlier releases: see [CHANGELOG.md](./CHANGELOG.md) (Chinese).

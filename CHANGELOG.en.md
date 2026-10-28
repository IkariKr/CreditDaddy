# Changelog (English)

English changelog — recent releases translated. For the full history in Chinese, see [CHANGELOG.md](./CHANGELOG.md).

---

## [1.6.2] (2026-10-26)

Theme: **ZCode pack gateway dispatch hardening (rotation fix + session stickiness) + LongCat pack-row number fix + claim arrival time surfaced + 429 backoff ladders and switch/claim feedback hardening**.

> **Added before tagging (2026-10-28)**: the four groups below — 429 backoff ladders, WorkBuddy not-installed guard, instant claim feedback, and 10Router per-channel sync switches — ship with this release (the tag had not been published, so no separate version number was needed).

### 🔧 Fixed

- **Gateway 429 cooldown: fixed 5 minutes → escalating backoff ladder**: all three gateways (ZCode / MiniMax / Trae) hardcoded a 5-minute cooldown on 429 — upstream rate-limit windows usually outlast it, so each account looped "cooldown expires → immediately 429 again" (the log showed nothing but "cooling 5 minutes"). Now the cooldown follows a ladder by consecutive count: **30s → 1min → 2min → 5min → 10min** (capped at 10 minutes from the 5th consecutive 429), and one successful completion resets the count — an occasional 429 never accumulates; only genuinely throttled accounts see longer waits. Resets cover both completion paths (streaming / JSON), credential-refresh revival, gateway re-enable, and a fresh claim; the log now carries the streak ("cooling 10 min, consecutive #2"), making one-off vs. sustained throttling obvious at a glance.
- **Trae gateway: 429 during the events phase didn't count**: Trae completions are two-phase (create session → read the events stream); a 429 on the stream only logged "events HTTP 429" without counting, so the next request still started from the 30-second rung and crashed into the window again. It now follows the same ladder as session creation.
- **WorkBuddy: switching without the client installed now says so clearly**: `writeWorkbuddySession()` used to mkdir + write the session file unconditionally and report success — on machines without the WorkBuddy / CodeBuddy client the panel showed "switched" while no client would ever apply those credentials, a pure dead end. New `detectWorkbuddy()` only trusts the client executable (the credentials directory is not evidence — the empty shell CD itself mkdirs would false-positive), the switch endpoint returns `WORKBUDDY_NOT_INSTALLED`, the panel toasts guidance on click and the WorkBuddy page shows a banner when not installed (token import / quota / daily claiming are unaffected; only switching needs the client).
- **ZCode claim results now land on the card instantly**: both claim paths (background auto-claim and the manual dialog) only reloaded quotas without re-rendering, leaving the card stale; and `statusOf()` returned an empty badge for ZCode, so the claim result left no trace at all. Activity grants usually carry an `effective_at` later the same day — until then the quota row shows "pending", indistinguishable from "nothing happened" to the user, whose only recourse was a manual refresh. All three triggers (auto-claim / manual dialog / per-card refresh) now re-render, and ZCode got "Claimed / Already claimed / Claim failed" badges.
- **ZCode pack gateway "multi-account rotation" never actually rotated — every request piled onto the first account**: `rotationQueue()` normalized the rotation pointer `rrIndex` into range but **never incremented it**, so the queue head was always the first account in the store and `handleGateway` started every request there; other accounts only got traffic when it failed / cooled / died. The pointer now advances one step per request, spreading load across accounts; when the ready-set changes the start re-normalizes instead of walking out of bounds. The sibling MiniMax gateway's "sticky primary + weight sort" always dispatched; ZCode's pointer never turned at all — an implementation defect unique to that line.
- **LongCat pack rows reported distorted numbers (issue #37)**: rows pushed to 10Router embedded the real numbers in the `name` text ("3.1757M / 5M · 36% consumed") while the structured fields carried `used=0 / total=remaining / remainingPercentage=100` — 10R's renderer only trusts structured fields, so cards drew a full unused bar contradicting the label. Now **fields are the truth**: `used` = consumed, `total` = pack total, `remainingPercentage` = remaining %, `name` is a plain label again ("Bonus pack" / "Resource pack"), expiry rides `resetAt`; the Balance summary row pushes Σconsumed / Σtotal so 10R can draw the consumed segment (it previously pushed remaining as total, leaving the bar always full).
- **ZCode claim that lands later now says when ("HH:MM arrival")**: `claimPlan()` always returned `startsAt`, but `zcodeAutoClaim` dropped it — `claims` carried only plan/via/ok. Symptom: the auto-claim log said "claimed (no captcha) — 300M ZCODE GLOBAL BUILD tokens" while the panel only showed "pending 300M · arrives 23:00", leaving users unsure whether the claim had actually taken. Both claim paths (no-captcha / silent-captcha) now carry `startsAt` and append "（arrives HH:MM）" only while the arrival time is still in the future (time-only for same-day, date+time across days).

### ✨ New

- **ZCode pack gateway session stickiness**: consecutive turns of the same conversation pin to the same account; only a new session rotates (hopping accounts fragments context). The session id comes from the caller's `metadata.user_id` (tolerant parsing of nested JSON string / bare top-level fields / raw string), and `metadata.user_id` is now **passed through verbatim when provided, generated only when absent** — previously every request minted a fresh `session_id`, so from the upstream's view every request was a new conversation and continuity was broken by design. Stickiness TTL 30 minutes before yielding to rotation; a pinned account that gets blocked / cooled / marked yields automatically instead of sticking. Callers without `metadata` degrade to pure rotation (safe).
- **10Router per-channel sync switches**: the Account Management dialog gains a channel checklist (only channels with accounts on this machine), each with two boxes — the main box = quota-card push, "conn" = account-connection sync. When 10Router already has a same-source channel configured (e.g. a minimax-code connection), unticking here drops CD's duplicate free card (`minimax-free-*`) — previously both cards existed with independently refreshing numbers. `tenrouter.json` gains `accountSync { enabled, providers }` (empty providers = all channels, backward compatible) and `quotaPushDisabledProviders[]`; refresh callbacks for excluded channels return 410 and stop going upstream. Cards already on 10Router are not deleted by CD (avoiding removal of hand-made cards) — they age out over the 7-day TTL or can be deleted manually.
- The "In use by API" badge now notes rotation sharing when multiple ZCode accounts exist (n accounts, one per request), so a single account doesn't look like the only servant; `gatewayStatus` exposes `stickySessions`.

### 🌐 Other

- All three gateways' `gatewayStatus` gained `coolingDetail` (remaining seconds / text / streak); the `cooling` field keeps its historical string-array shape.
- New `formatDuration.js`: human-readable durations — 30s displays as "30 s" (rounding ms→minutes would render it as "1 minute").
- 10Router toolbar order is now Refresh · Usage sync · Account management · Settings.
- Test hardening: per-rung ladder assertions + cap + reset-on-success for all three gateways, `formatDuration` boundaries, `detectWorkbuddy` decisions, channel allow-list filtering / excluded-channel zero-push (key cases verified to fail with the fix removed); 340 tests total.
- i18n entries for the cooldown ladder / WorkBuddy guidance / channel switches, synced across four languages; `scripts/check-i18n.js` full coverage passes.

---

## [1.6.1] (2026-10-23)

Theme: **Qoder dual-channel switching hardening (current-account alignment / real-cause errors / auto-relaunch) + ZCode pending-grant display + 10Router account-management entry**.

### 🔧 Fixed

- **Current-account misalignment after Qoder switching (the vanishing switch button)**: toggling between international / domestic channels left the panel's "client current" marker disagreeing with the actual login — `/api/status`'s `qoderCurrent` compared by uid only with a 60-second cache. The observed path: the client silently refreshes its token (same uid, new token), and uid comparison against "multiple records with the same uid" mispicked another record as current — the new account showed no badge and the switch-button visibility logic went wrong, which the user saw as "the switch button disappeared after switching". Now aligned by the **token decoded from `auth.v1.dat`** (uid fallback), with the cache cleared immediately after a successful switch; the panel's `isClientCurrent()` judges by id. Regression: `test/qoder-current-token.test.js` (which also fixed two environment dependencies that redened CI — DPAPI key creation deferred into the test body, and closing the log archive stream on teardown).
- **Qoder switch failures now point at the real cause**: the old error "credential file missing (client may be uninstalled or moved directories)" mislabeled the most common case — the client signed out and deleted `auth.v1.dat` — as a moved directory, sending users hunting for a directory that was never the problem. Now the detection result drives the guidance (installed → sign in inside the client and re-import; not installed → install and sign in first), and the message names the account and channel.

### ✨ New

- **Qoder auto-relaunch after switching**: a forced switch closes Qoder first, but the flow used to stop at "please reopen" — users had to hunt for the shortcut themselves. Now aligned with ZCode / mirasim / CatPaw / Trae: after writing the login the client starts automatically, opening only the edition switched to (switching intl doesn't also launch domestic Qoder CN, and vice versa).
- **ZCode pending grants shown as "Pending"**: activity grants only enter the balance at `effective_at` (e.g. ZCode 1024 Dev Day's 300M + 200M), which used to render as "0 / 500M remaining" — looking like lost quota. With everything pending the main row now reads "Pending 500M tokens · activity name · arrives HH:MM" with a dashed bar; when partially active, a pending line appends under the remaining row. Backend adds `pendingTotal` / `pendingAt` and per-entitlement `planName` (so users know which activity issued it).
- **10Router "Cookie sessions" became "Account management"**: account sync used to sit at the bottom of the "10Router connection settings" dialog where nobody found it, and cookie sessions had their own button. The toolbar's "Account management" dialog now holds both — account sync (push local Qoder / WorkBuddy as upstream connections, with the panel-password field for the OAuth channel) and web sessions (Token Harbor etc. cookie capture). The duplicated sync block in the settings dialog and the old dialog's dead code were removed; the free-quota page's "Sync to 10Router" remains one-click-both (connections + quota cards).

### 🌐 Other

- i18n entries for pending-grant / arrival / account-management / Qoder relaunch, synced across four languages; `scripts/check-i18n.js` full coverage passes.

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

КАИ Расписание is a full-stack university schedule management web app. Students browse schedules; admins manage them through a protected dashboard.

**Stack:** React 19 + Vite (frontend), Express 5 (backend), SQLite via better-sqlite3.

A Russian walkthrough for people is `docs/ARCHITECTURE.md`; `README.md` is the public, recruiter-facing page (formal Russian, no em dashes) — keep notes for agents out of it.

## Invariants — read before changing anything

Each of these was a real bug or a deliberate decision; the sections below explain them.

1. **The template is the specialist's draft; students see only entered weeks.** A week is entered when it has rows of its own (`specific_week`); a teaching week not entered shows «Расписание не внесено». The public (student page, teacher page, Alice) sees pairs only up to the end of the current week — or of the next one once that is entered (`utils/visibility.js`) — and session records any day. Template rows are never sent publicly.
2. **Hours are computed, never stored** (except `final_hours` of a closed semester), and only from entered weeks. A pair counts only through the exact five-field identity with a plan row — no link column, no text matching.
2a. **The draft keeps its history.** Template edits start from the current week (`template_from_week` from the server clock), or the next one when that cell's pair this week has already ended (`utils/templateWeek.js`); removals leave tombstones, so a week entered later still gets the version that was current for it. Never rewrite or delete old template versions.
3. **Ids win over text.** When `teacher_id`/`discipline_id` is given, the text comes from the dictionary (`resolveTeacherDiscipline`). Renames propagate; deleting a referenced teacher/discipline is refused.
4. **Three different "which semester" questions** (working / in effect on a date / viewed) — never substitute one for another.
5. **A closed semester is frozen**: every write touching it returns 409.
6. **Joined groups**: the member owns nothing; read through `scheduleGroupId`, refuse writes naming the member.
7. **The client and the server resolve a day the same way** (`src/lib/scheduleResolve.js` + `templateResolve.js` ↔ `server/utils/templateResolve.js` + `server/utils/dayResolve.js`, the one server-side "what does group X have on date D" used by the Alice skill, the session clash checks and the Excel export); `tests/dayResolve.parity.test.js` and the other parity tests guard it — change both or neither.
8. **No hard-coded calendar dates** in app code (`tests/codeGuards.test.js`); every audit action needs a Russian label in `src/pages/adminDashboard/format.js` (same test).
9. **One-off data fixes run once per database** (`runDataFixOnce`); schema migrations must be idempotent; a boot snapshot is taken before them.
10. **Never commit databases or real people's data** (`data/*.db`, `seed/*.db`, real teacher names in tests/fixtures — use made-up names).
11. Run `npm test` after any change; it must stay green (132 tests).

## Commands

```bash
# Install
npm install
cp .env.example .env

# Development (runs Vite :5173 + Express :3000 concurrently)
npm run dev

# Individual servers
npm run dev:client    # Vite only, proxies /api → :3000
npm run dev:server    # Express only with --watch

# Production
npm run build         # Vite build → dist/
npm start             # Express serves dist/
npm run start:build   # Build then start

# Database
npm run seed          # Destructive — resets DB with demo data (dev only)

# Tests
npm test              # node --test: every file in tests/
```

## Environment Variables

Required for production (see `.env.example`):
- `JWT_SECRET` — must be set
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin credentials
- `NODE_ENV`, `PORT` (default 3000)

Optional: `HOST` (set `127.0.0.1` behind Caddy so port 3000 is not on the network), `ALICE_WEBHOOK_TOKEN` (the Alice webhook then requires `?token=`), `ADMIN_COOKIE_NAME`, `TRUST_PROXY`, `ADMIN_ALLOWED_IPS`, `BACKUPS_DIR`, `DB_PATH`, `API_RATE_LIMIT_MAX` (public reads, default 5000/min — a flood ceiling, since the whole campus shares one NAT address), `ADMIN_RATE_LIMIT_MAX` (default 300/min), `API_RATE_LIMIT_WINDOW_MS` (default 60000), `ALERT_WEBHOOK_URL` + `ALERT_CHAT_ID` (Telegram/Discord/Slack webhook for crash and 500 alerts — see `server/alerts.js`), `SEED_DB_PATH` (snapshot a missing database is created from, default `seed/schedule.seed.db`)

## Architecture

### Request Flow

```
Browser → Vite dev proxy (/api) → Express :3000 → SQLite (data/schedule.db)
```

In production, Express serves the Vite-built `dist/` and handles all `/api` routes directly.

### Backend (`server/`)

| File | Role |
|---|---|
| `index.js` | Entry point, starts HTTP server |
| `app.js` | Express app setup, middleware wiring |
| `db.js` | SQLite singleton, schema, table definitions |
| `config.js` | Environment variable loading |
| `routes/api.js` | Public schedule endpoints |
| `routes/admin.js` | Login/logout/session, then auth + CSRF middleware; mounts `routes/admin/*.js` (one file per area, shared helpers in `admin/shared.js`) |
| `middleware/auth.js` | JWT cookie verification |
| `middleware/csrf.js` | CSRF token generation and validation |
| `utils/date.js` | Week number calculation relative to `semester_start_date` |
| `audit.js` | Audit log writes |
| `access-control.js` | IP allowlist for admin routes |
| `login-rate-limit.js` | Failed login attempt tracking |

### Frontend (`src/`)

Pages: `WelcomePage` → user selects university/group → `SchedulePage` renders the timetable. `AdminLoginPage` and `AdminDashboardPage` are separate flows.

The admin pages keep state and handlers in the page and render through presentational pieces that take every value and handler as a prop of the same name:
- `src/pages/adminDashboard/` — `useAdminApi.js` (every `/api/admin` request: JSON, CSRF token on writes, 401 → login), `BuilderSection.jsx` (the constructor grid and which pairs a cell shows), `GroupPicker.jsx` (searchable group field), `AttestationsSection.jsx` («Сессия», keeps its own state), plus the sidebar, settings, backups, audit and lesson modal.
- `src/pages/adminLoad/` — the load page's `SemesterCard`, `ReferenceCards`, `PlanSection`, `PlanRow` and `format.js`; `AdminLoadSection.jsx` holds their state.

`src/lib/storage.js` persists selection, theme preference, and admin token to `localStorage`.

### Database Schema (key tables)

- `universities`, `groups_` — hierarchy
- `lessons` — schedule entries; the core of the domain
- `semesters` — `start_date` (always a Monday), `weeks_count`, `first_week_parity` (1 нечётная / 2 чётная), `is_active` (at most one: the *working* semester the constructor writes into)
- `settings` — key/value store; `semester_start_date` mirrors the working semester
- `admins`, `audit_logs`, `login_attempts` — auth/security

### Critical Domain: Semesters

Every lesson has `semester_id`; week numbers, parity, slot occupancy and hours are computed inside the lesson's own semester. Three different "which semester" questions — never mix them: the **working** semester (admin writes; `getActiveSemester`), the semester **in effect on a date** (students per day, teachers by default; `getSemesterForDate`), and a semester **being viewed** in the load page (no server state). Parity of week N = strict alternation from `first_week_parity`; ISO-week parity is only the default for a new semester. A pair cannot be placed past `weeks_count`: the server answers `needs_extension` and the constructor offers to extend the semester first, so schedule and hours never disagree. The reverse holds too: shortening a semester below a week that has its own pairs is refused (409 naming the weeks); a change of dates that would move entered pairs under a session record with an end time is refused as well — both already in the impact preview (`blocked`). The schedule answer also carries `own_weeks` per semester, counted over the whole group, so a page filtered to one subgroup still knows a week whose own rows are all the other subgroup's ignores the template. Semesters may not overlap (each starts after the other's last teaching week, `findOverlappingSemester`). The start date is edited only on the semester (Нагрузка, with the impact preview) — Settings refuses it. `tests/yearLifecycle.test.js` drives a whole year with `KAI_FAKE_NOW` (ignored in production).

### Closing a semester

`POST /api/admin/semesters/:id/close` freezes it: every `load_plan.final_hours` is filled from the current calculation, `semesters.closed_at` is set, and every write touching that semester is refused with 409 (`findClosedSemester` in `routes/admin.js` guards lessons, week edits, plan rows and the semester's own dates). Reads then report the stored total instead of recomputing, so a printed report stays true. `POST .../reopen` clears both and hours go live again. See `tests/semesterClose.test.js`.

### Database migrations and one-off data fixes

`initTables()` in `server/db.js` runs on every `getDb()` open. Schema changes there are idempotent and run every boot. Corrections of imported data (joint lectures missing from the second group, rooms lost to merged cells or unlabelled "Ауд." columns) run **once per database** through `runDataFixOnce`, which records `data_fix.<name>` in `settings`. They must not re-run: a restart would otherwise "correct" the specialist's later edits (e.g. re-add a lecture she removed from the template). A test that inserts pre-fix data must delete those settings keys before reopening.

### Critical Domain: Schedule Override Model

Lessons have a `specific_week` column:

- `NULL` — template entry: the draft the constructor shows for a week not yet entered and copies into it when it is entered (materialize-week; `action: 'copy'` = «Внести неделю как в шаблоне»). Never shown to students, never counted.
- `N` (integer) — the week entered for that group; only these rows are shown and counted. When the template is copied in, a pair falling under a session record with an end time comes in already taken out by it (`weekRows.js timedRecordOver`).

`week_type`: `0` = every week, `1` = odd weeks, `2` = even weeks. Removing a week's pair leaves an `is_removed` marker row so the week stays "its own"; markers and tombstones are never deleted (DELETE answers 409). A pair POSTed into a week still run by a non-empty template is refused (the constructor copies such a week first; only a stale tab gets here). Re-editing a template cell supersedes its versions still waiting for their week; a template cell's occupancy is checked at every week a version of that day starts, not only the first (`findTemplateSlotOccupant`). «Очистить неделю» makes the week not entered again (students see «Расписание не внесено») and asks again when hours would be lost. Template rows are versioned by `template_from_week`; edits/removals insert a new version or tombstone from the current week carrying the same `teacher_id`/`discipline_id` (hours match rows by identity — see below).

### Critical Domain: Teaching Load Matching

Hours are never stored — they're computed live from whichever schedule rows currently match a `load_plan` row's identity: `teacher_id`, `discipline_id`, `lesson_type`, `group_id`, `subgroup`, all within the same `semester_id` (`server/utils/planProgress.js`). There is no separate "link this pair to the plan" step or column — a lesson and a plan row are the same teaching assignment purely because they share that five-field identity, both drawn from the same `teachers`/`disciplines` dictionaries the constructor and the load page both read from.

`lessons.teacher_id`/`discipline_id` are nullable FKs into those dictionaries. `lessons.subject`/`teacher` (text) are kept for display, exports, `kind='event'` rows, and untracked one-offs — but whenever an id is supplied, the server always derives the text from the dictionary and ignores client-sent text alongside it (`resolveTeacherDiscipline` in `routes/admin/shared.js`), so text and id can never drift apart. A pair typed free-text with no dictionary match is shown to students like any other pair but doesn't count toward anyone's hours — expected, not a bug: a one-off substitute costs two extra clicks to add to the dictionary if it should count.

**Joined groups.** A group that studies as one with another (23313 with 23303) is set in Settings → «Объединена с» (also offered when adding a group): `groups_.joined_to` points at the leader, the member owns no lessons, and reads go through `scheduleGroupId` in `server/utils/groupJoin.js` — students of 23313 see 23303's pairs under their own number, the constructor lists one group "23303 / 23313", the Excel export prints one block, hours of a plan row naming the member count the leader's pairs. Writes naming the member are refused. Joining requires both timetables to be identical (the member's duplicates are dropped); splitting copies the shared timetable of every semester (closed ones too, so the member keeps its history) back.

**Streams.** In the constructor, «Ещё группы» in the add-pair dialog saves the same new pair for other groups too (`POST /api/admin/lessons/for-groups`: a dry run first, then all groups in one transaction; a group whose week still runs on a non-empty template is refused). One pair taught to several groups at once (a lecture for 23101/23103/23104; 23303 and 23313 share everything) is ONE plan row: `load_plan.group_id` is its first group, the others are in `load_plan_extra_groups` (read and written only through `server/utils/planGroups.js`). Its pairs are resolved per group and joined by date + time, so a shared pair counts once — 2 h, not 2 h per group — and still counts if it was entered for only one of the groups. Planned hours are the stream's own (two rows of 36 h merge into one of 36 h). The load page's «+ группа» builds such a row; `GET /load-plan/unmatched` also returns `streams` — separate rows of the same teacher/discipline/type/subgroup whose pairs fall at the same time — and `POST /load-plan/merge` joins them. In the Excel export a pair that adjacent groups share (same text and room) is one merged cell across their columns.

Matching is exact, so one wrong field (type, subgroup) or a teacher typed by hand instead of picked is enough for a pair to stop counting — silently. `GET /api/admin/load-plan/unmatched` (`routes/admin/loadPlan.js`) names those pairs and the load page lists them; it considers only what the schedule currently shows, skipping retired template versions, removed rows and events.

Because matching is live, editing a past week's identity (e.g., swapping the teacher) immediately moves hours between teachers with no extra step — the old teacher's count drops, the new one's rises, next time either is computed. Deleting a teacher or discipline is refused while **any** lesson (any semester, not just `load_plan` rows) still references it — checked in `routes/admin/references.js`. Renaming in the dictionary keeps every link (lessons reference the row by id) and also rewrites the `teacher`/`subject` text of the lessons linked to it, so students, the builder and exports show the new name too (`routes/admin/references.js`).

### Сессия: exams, credits, consultations

Экзамены, зачёты и консультации live in their own table `attestations` (`kind` = `exam` / `credit` / `consultation`), not in `lessons`: they fall on a real date with a free start time (end optional), mostly after `weeks_count`, and a `specific_week` row would wipe that week's template. `semester_id` is the semester in effect on the date (a June exam is spring's even when autumn is the working semester); a closed semester refuses writes. Teacher and discipline are ids into the dictionaries (text shown via JOIN, so a rename shows everywhere) or `*_text` when nothing matched; deleting a referenced teacher/discipline is refused. A member of a joined group owns none (writes refused, join moves them to the leader, split copies them back).

They never count toward plan hours — the admin «Сессия» section (`AttestationsSection.jsx`, `routes/admin/attestations.js`) counts them per teacher. Students get them in `GET /api/schedule/:groupId` (`attestations`, placed by date in `scheduleResolve.js`, orange tag) — any date, ahead of the open weeks too: their days are the only ones shown after `visible_until` — teachers in `/api/teachers/:id/load`. `GET /api/admin/attestations/export?type=session|consultations` builds the branch's two documents (`server/exportAttestations.js`: «Расписание промежуточной аттестации» with зачет/экзамен date columns, «Расписание консультаций к экзаменам», one sheet per course). They are entered in the app, not imported.

Collisions (`server/utils/attestationConflicts.js`): the same record twice is refused; anything else is a warning the specialist confirms (`confirm: true`) — the group's pair at that time (resolved exactly as the student page resolves the day), the teacher or the room busy with another group's pair or record (a joint exam of two groups at the same time is not a clash), a consultation after the subject's last exam, a Sunday. A start-only record counts as 60 min (consultation) or 90 min. A record **with an end time** is a fixed block: it never overlaps the group's pair — saving it over one is refused (409 `pair_clash`, not confirmable) unless the pair is taken out of that day (`remove_pairs`, only when the record takes it over entirely), and no week's own pair may be placed, edited, moved or dragged onto it (`timedAttestationError`, checked in POST/PUT lessons, for-groups, move-lesson, materialize-week); a template pair is only the draft — copied into a week under such a record, it comes in taken out. The list re-checks on every read, so a pair added later in the constructor flags the record it now covers. With `remove_pairs: true` the covered pairs are taken out of that one date (`utils/weekRows.js hidePairsOnDate`) and marked `lessons.hidden_by_attestation`; moving the record (date, time, group, subgroup) or deleting it brings them back (`restorePairsHiddenBy`) unless their time has been taken since. See `tests/attestations.test.js`, `tests/reviewFixes.test.js`.

### Alice skill

`POST /api/alice` (`server/alice.js`) is the Yandex Dialogs webhook: «какие пары завтра», «что в пятницу», «18 сентября» (a typo in the month or a bare «а 18» after it is understood — the month talked about is kept in `session_state`), «на неделе», «первая/последняя пара», «сколько пар», «какая сейчас/следующая пара», «когда физика», «когда экзамены», a little small talk, and a group number to remember («23 303» from speech is joined; a question asked before the number is answered once it is given). Past days are told in the past tense; a phrase it can't place gets a hint, never a timetable nobody asked for. Read-only — it answers from `utils/dayResolve.js` plus attestations under the same visibility as the student page («расписание ещё не внесено» for a week not entered or not open yet; a joined group hears its leader's pairs). The group is kept in the skill's own storage: `user_state_update` for a logged-in Yandex user, `application_state` per device; nothing is written to our database. Evening with today's pairs over → tomorrow. Answers ≤ 1024 chars. See `tests/alice.test.js`.

### Where schedule edits live

Every pair is entered in the constructor (`routes/admin/lessons.js`); a pair takes one of the branch's usual slots (`BUILDER_TIME_SLOTS`; it counts 2 h whatever its length), only an event may have a time of its own (behind «Своё время»), and the grid adds a row for every other time a pair of the view has, so such a pair can always be opened and removed; week-by-week edits (move, first edit of a week, clear week) live in `routes/admin/scheduleWeek.js`, the Excel export in `routes/admin/schedule.js`. There is no JSON/Excel import into the app (the owner chose «enter in the app, export to Excel»); the official weekly Excel is imported by a one-off script run against the production database (see the private notes) — it writes past the API, so it must itself refuse a closed semester, a joined member group and a week past `weeks_count`, and link every pair to the dictionaries.

### Dark Theme

Toggle in `SchedulePage` header (desktop) and burger menu (mobile). Theme stored in `localStorage` as `kai_schedule_theme`. Applied globally to `document.documentElement` via `data-theme="dark"` attribute before the first paint by `client-public/theme-boot.js` (a plain script in `index.html`'s head — the CSP forbids inline scripts — with the matching `html` background inline, so a dark-theme launch never flashes white), and again on app startup (`src/main.jsx`); it repeats `lib/theme.js`'s key and colours. CSS variables are overridden under `[data-theme="dark"]` in `schedule.css` and `welcome.css`.

### Schedule page: the whole semester

The page loads the **whole semester the chosen day falls in** in one request, but the answer holds only entered weeks up to `visible_until` (see invariant 1); `dayStatus` in `scheduleResolve.js` says per day 'open' / 'not_entered' / 'closed', the strip ends at the last open day (later only session days), not-entered days show «Расписание не внесено», and the calendar greys out closed dates: `GET /api/schedule/:groupId?date=&span=semester` (`semesterSpan` in `routes/api.js`) answers from the semester's first Monday to the day before the next semester — or, with no next semester yet, to the end of its session (teaching weeks + 8, never before the group's last exam). Outside any semester (before the first, a long summer gap) it answers two weeks either side of the date. Every schedule answer carries `range_start`/`range_end` and the header `X-Kai-Range: from/to`; the silent refresh re-asks the same days with `date=&days=` (up to 400). Picking a date inside the loaded semester only scrolls; a date outside loads that one. Browsing is bounded to a year either side of today (`getMinDate`/`getMaxDate` in `SchedulePage.jsx`). `tests/scheduleSpan.test.js` covers the edges.

Offline, the service worker answers a `span=semester` request with the newest saved answer of the same group whose `X-Kai-Range` covers the day (the URL's date moves every morning), and keeps only the last 3 saved schedules per group. `tests/serviceWorker.test.js` runs the real worker against an in-memory Cache Storage. `planInitialWindow` in `src/lib/scheduleWindow.js` remains only as a fallback for an old saved copy without `range_start`.

On a phone the day tabs and the list cover the same semester; the list opens scrolled to the chosen day (`scroll-margin-top` under the sticky header) with every earlier day above it, and the day view draws only the open day (a semester is ~130–180 days). The date picker opens from the burger menu («Выбрать дату») as a bottom sheet. In the day view a horizontal swipe turns the day (`src/lib/useDaySwipe.js`: 1:1 tracking on `transform` only, rubber band at the window's ends, the flick's projected landing decides; `touch-action: pan-y` keeps vertical scrolling native, the tab strip is `data-swipe-ignore`). A new day enters from its side (`--day-from` on `.day-content`).

Motion across the app is one family: the `--ease-spring` curve (critically damped, no overshoot), pages fade in (`#root > *`, opacity only — a transform there would capture every fixed sheet), the theme switch is one View Transition cross-fade (`lib/theme.js`), and `prefers-reduced-motion` turns animations off globally (`styles/base.css`). Animations end on `transform: none`, never a zero translate, so nothing is left as a containing block.

### PWA Auto-Refresh

The app opens like a messenger: the service worker serves the saved page shell at once (the network's copy replaces it for the next launch), stylesheets by the build's version (`?v=` from `vite.config.js`, so a saved copy never pairs new code with old styles), and a saved schedule at once marked `X-Kai-Saved-Copy: instant`. The page then asks again right away with `X-Kai-Wait` and swaps in the fresh answer; only if that takes over 1.5 s does the «показываем сохранённое» notice appear. Other public data (teacher page, group lists) still waits for the network. `SchedulePage` also listens to `visibilitychange` — back after 60+ seconds, it reloads.

### Security Model

- Admin auth: JWT in an httpOnly, SameSite=Strict cookie that only names a server-side session (`admin_sessions`, `server/sessions.js`): logout ends that session, a password change ends all others, «Выйти на всех устройствах» ends every one; 4 h idle / 12 h absolute timeout. A restore from a backup ends all sessions
- Optional second factor (TOTP, `server/utils/totp.js`, `server/secondFactor.js`): turned on in Settings with the password + a code, secret stored AES-GCM-encrypted with a key derived from `JWT_SECRET`, 8 one-time recovery codes (hashed), each app code accepted once. With it on, `/login` returns a 5-minute ticket and `/login/second-factor` opens the session
- Lockout recovery on the server: `node server/admin-tool.js unlock | reset-2fa <login> | set-password <login> | logout-all | list` (run with the service's env; refuses a missing DB_PATH instead of creating one)
- State-changing admin endpoints require CSRF token
- Login is throttled via `login_attempts` per username (5 free) and per address (20 free — the campus shares one), the pause doubling from 30 s to at most 15 min, never permanent; an unknown username answers and is counted the same way; failures go to the journal; a browser that has logged in before carries a signed year-long device mark (`server/trustedDevice.js`, cookie `kai_device`, path `/api/admin/login`) and is throttled only by its own failures, so strangers failing on purpose cannot lock the specialist out of her computer; public reads get a high flood ceiling that skips `/api/admin`, and `/api/admin` a tight one counted per browser (a signed session or device mark) or per address without one (`express-rate-limit`; per-IP budgets can't be per-person when a campus shares one address, so strangers on it must not use up the specialist's)
- `GET /api/health` (before the limiter, no auth) reports process + database state for an uptime monitor; `.github/workflows/uptime.yml` asks it every 5 minutes, and GitHub e-mails a failed run to the account that last changed the schedule
- Optional IP allowlist via `ADMIN_ALLOWED_IPS`
- CSP and security headers set in `app.js`
- Settings → «Вход и безопасность» (`SecuritySection.jsx`): change the password (`PUT /api/admin/account`, current password required, 12+ chars, not containing the login), turn the second factor on/off, new recovery codes, «Выйти на всех устройствах». Headers: CSP, HSTS (production), CORP, nosniff, frame-deny; JSON bodies 16 KB public / 256 KB admin; `/api/client-error` 10/min per address
- Lesson creation derives `template_from_week` from the server clock, never from client input — an edit can only ever take effect from "now" forward, so a client can't retroactively rewrite what a past week showed

### Deployment Note (VPS)

Production runs on a VPS as a systemd service under its own user (`Restart=always`, so a crash means a restart), behind Caddy (HTTPS, compression). **`DB_PATH` and `BACKUPS_DIR` are set to a directory outside the code** (`/opt/kai/data`), which is what lets a deploy replace the code without touching the database or its backups. Without them both default to `data/` inside the code tree, and swapping the code tree would take the live database with it — set them on any new server before the first start. A deploy copies the built `dist/` (and `server/` when it changed), runs `npm ci --omit=dev` when `package.json`/`package-lock.json` changed (a new server dependency otherwise crashes the service on `require`), keeps the previous version alongside, and restarts the service. The databases (`data/*.db`, `seed/*.db`) are not in git: they hold the admin account and real teachers. A missing database is created from the snapshot at `SEED_DB_PATH` (default `seed/schedule.seed.db`) when that file exists; otherwise it starts empty. Backups: automatic snapshot on every boot before migrations and one per day (`server/autoBackup.js`, into `BACKUPS_DIR`, default `backups/` next to the database), manual ones from the panel; restore from a listed backup or an uploaded file in the panel (`POST /api/admin/backups/:file/restore`, `/backups/upload-restore`). Moving local data to production = upload the file via "Восстановить из файла". An encrypted copy of the production database also goes to cloud storage every 6 hours.

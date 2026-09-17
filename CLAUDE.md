# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

КАИ Расписание is a full-stack university schedule management web app. Students browse schedules; admins manage them through a protected dashboard.

**Stack:** React 19 + Vite (frontend), Express 5 (backend), SQLite via better-sqlite3.

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
npm test              # Node.js test runner (tests/server.test.js)
```

## Environment Variables

Required for production (see `.env.example`):
- `JWT_SECRET` — must be set
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin credentials
- `NODE_ENV`, `PORT` (default 3000)

Optional: `ADMIN_COOKIE_NAME`, `TRUST_PROXY`, `ADMIN_ALLOWED_IPS`, `BACKUPS_DIR`, `DB_PATH`, `API_RATE_LIMIT_MAX` (public reads, default 5000/min — a flood ceiling, since the whole campus shares one NAT address), `ADMIN_RATE_LIMIT_MAX` (default 300/min), `API_RATE_LIMIT_WINDOW_MS` (default 60000), `ALERT_WEBHOOK_URL` + `ALERT_CHAT_ID` (Telegram/Discord/Slack webhook for crash and 500 alerts — see `server/alerts.js`)

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
| `routes/admin.js` | Protected admin CRUD (requires JWT cookie + CSRF token) |
| `middleware/auth.js` | JWT cookie verification |
| `middleware/csrf.js` | CSRF token generation and validation |
| `utils/date.js` | Week number calculation relative to `semester_start_date` |
| `audit.js` | Audit log writes |
| `access-control.js` | IP allowlist for admin routes |
| `login-rate-limit.js` | Failed login attempt tracking |

### Frontend (`src/`)

Pages: `WelcomePage` → user selects university/group → `SchedulePage` renders the timetable. `AdminLoginPage` and `AdminDashboardPage` are separate flows.

`src/lib/storage.js` persists selection, theme preference, and admin token to `localStorage`.

### Database Schema (key tables)

- `universities`, `groups_` — hierarchy
- `lessons` — schedule entries; the core of the domain
- `semesters` — `start_date` (always a Monday), `weeks_count`, `first_week_parity` (1 нечётная / 2 чётная), `is_active` (at most one: the *working* semester the constructor and uploads write into)
- `settings` — key/value store; `semester_start_date` mirrors the working semester
- `admins`, `audit_logs`, `login_attempts` — auth/security

### Critical Domain: Semesters

Every lesson has `semester_id`; week numbers, parity, slot occupancy and hours are computed inside the lesson's own semester. Three different "which semester" questions — never mix them: the **working** semester (admin writes; `getActiveSemester`), the semester **in effect on a date** (students per day, teachers by default; `getSemesterForDate`), and a semester **being viewed** in the load page (no server state). Parity of week N = strict alternation from `first_week_parity`; ISO-week parity is only the default for a new semester. Past `weeks_count` the template stops (schedule and hours alike). `tests/yearLifecycle.test.js` drives a whole year with `KAI_FAKE_NOW` (ignored in production).

### Closing a semester

`POST /api/admin/semesters/:id/close` freezes it: every `load_plan.final_hours` is filled from the current calculation, `semesters.closed_at` is set, and every write touching that semester is refused with 409 (`findClosedSemester` in `routes/admin.js` guards lessons, schedule uploads, plan rows and the semester's own dates). Reads then report the stored total instead of recomputing, so a printed report stays true. `POST .../reopen` clears both and hours go live again. See `tests/semesterClose.test.js`.

### Critical Domain: Schedule Override Model

Lessons have a `specific_week` column:

- `NULL` — template entry, applies every semester week matching `week_type`
- `N` (integer) — full week override for that group; **when an override exists for week N, all template entries for that group/week are ignored** (no merging)

`week_type`: `0` = every week, `1` = odd weeks, `2` = even weeks. Removing a week's pair leaves an `is_removed` marker row so the week stays "its own". Template rows are versioned by `template_from_week`; edits/removals insert a new version or tombstone from the current week carrying the same `load_plan_id` (hours select rows by it).

### Bulk Schedule Upload

Admin can upload schedules for multiple groups in one request:

```json
{
  "target_week": "template",
  "groups": [
    { "group": "23113", "university": "КНИТУ-КАИ", "lessons": [...] },
    { "group": "23114", "university": "КНИТУ-КАИ", "lessons": [...] }
  ]
}
```

Endpoint: `POST /api/admin/schedule/upload-bulk`. Atomic — either all groups succeed or none. Frontend auto-detects bulk vs single format by checking for `groups` array vs `group` string.

### Dark Theme

Toggle in `SchedulePage` header (desktop) and burger menu (mobile). Theme stored in `localStorage` as `kai_schedule_theme`. Applied globally to `document.documentElement` via `data-theme="dark"` attribute on app startup (`src/main.jsx`). CSS variables are overridden under `[data-theme="dark"]` in `schedule.css` and `welcome.css`.

### PWA Auto-Refresh

`SchedulePage` listens to `visibilitychange` — when the user returns to the app after 60+ seconds, schedule data is re-fetched from the server. Service worker uses network-first strategy for all `/api/schedule/` requests, so data is always fresh when online.

### Security Model

- Admin auth: JWT stored in httpOnly, SameSite=Strict cookie
- State-changing admin endpoints require CSRF token
- Login is rate-limited via `login_attempts` table; public reads get a high flood ceiling and `/api/admin` a tight one (`express-rate-limit`; per-IP budgets can't be per-person when a campus shares one address)
- `GET /api/health` (before the limiter, no auth) reports process + database state for an uptime monitor
- Optional IP allowlist via `ADMIN_ALLOWED_IPS`
- CSP and security headers set in `app.js`
- `PUT /api/admin/account` changes the admin's username/password (requires current password) — the only account-management path that doesn't require the destructive `npm run seed`
- Lesson creation derives `template_from_week` from the server clock, never from client input — an edit can only ever take effect from "now" forward, so a client can't retroactively rewrite what a past week showed

### Deployment Note (Railway)

Railway mounts a persistent volume at `/app/data`, so the live database survives redeploys and the `data/schedule.db` in git is **not** what production runs on (it only matters locally). A brand-new empty volume is bootstrapped from `seed/schedule.seed.db`. Backups: automatic snapshot on every boot before migrations and one per day (`server/autoBackup.js`, same volume), manual ones from the panel; restore from a listed backup or an uploaded file in the panel (`POST /api/admin/backups/:file/restore`, `/backups/upload-restore`). Moving local data to production = upload the file via "Восстановить из файла".

# AGENTS.md

## Cursor Cloud specific instructions

### Architecture Overview

This is a Telegram EdTech bot platform with 3 dev-relevant services:

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| API (Fastify) | `npm run dev:api` | 3001 | File-based JSON DB, no external deps |
| Web (Vite+React) | `npm run dev:webapp` | 3000 | Proxies `/api` → `localhost:3001` |
| Bot (Telegraf) | `npm run dev:bot` | — | Requires `.env` with `BOT_TOKEN` + YooKassa creds |

### Running services

- **API** starts independently with no env vars required (defaults are fine).
- **Web app** requires the API to be running first (Vite proxy forwards `/api` to `:3001`).
- **Bot** requires a `.env` file in the repo root with `BOT_TOKEN`, `TEST_YOOKASSA_TOKEN`, `TEST_YOOKASSA_SHOP_ID`, `TEST_YOOKASSA_SECRET_KEY`, and `ADMIN_TELEGRAM_ID`. It will not start without these. The `dev:bot` script uses `tsx --env-file=.env`, so secrets must be in the `.env` file (not just exported in the shell).
- The web app binds to `localhost` only (not `127.0.0.1`). Use `http://localhost:3000` when curling or browsing.
- The bot connects via long-polling (no webhook needed). A harmless `punycode` deprecation warning appears at startup — ignore it.

### Lint / Typecheck / Build

- Backend typecheck: `npm run typecheck` (root)
- Web lint: `npm run lint` (in `web/`)
- Web build: `npm run build:webapp` (from root) or `npm run build` (in `web/`)
- Backend build: `npm run build` (root — compiles TS to `dist/`)

### Data

- Test questions are stored in `db/` as JSON files (organized by faculty/course/test-type).
- User data, sessions, statistics stored in `data/` (created at runtime).
- No external database or Redis required.

### Known lint issues

The `web/` ESLint config reports 3 pre-existing errors (react-hooks/set-state-in-effect, react-refresh/only-export-components). These are not blocking.

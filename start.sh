#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Railway.app start script — robust PORT binding + DB readiness
# ─────────────────────────────────────────────────────────────────────────────
#
# Why this script exists
# ───────────────────────
#   Railway's "Application failed to respond" (502 Bad Gateway) with an
#   "Active/Online" deployment status is almost always caused by the server
#   process never actually starting — the most common reasons:
#
#     1. `bun run db:push` fails BEFORE `node .next/standalone/server.js` runs.
#        The `&&` chain breaks → no HTTP server → Railway's proxy 502s.
#        Sub-causes:
#          a. DATABASE_URL env var not set in the Railway dashboard.
#          b. DATABASE_URL points at a directory that doesn't exist (no Volume
#             mounted at /data) → SQLite can't create the DB file.
#     2. The server starts but binds to 127.0.0.1 (localhost) instead of
#        0.0.0.0 → Railway's external proxy can't reach it.
#
#   This script fixes ALL of these:
#     • Sets HOSTNAME=0.0.0.0 explicitly (the server MUST bind to all interfaces).
#     • Defaults DATABASE_URL to an ephemeral path if unset (so the app boots).
#     • Creates the DB file's parent directory (so SQLite can write the file).
#     • Logs a startup banner showing PORT, HOSTNAME, DATABASE_URL, runtimes.
#     • Uses `exec` so node becomes PID 1 (receives Railway's SIGTERM directly).
#
#   Next.js standalone server.js (auto-generated) reads:
#       process.env.PORT     (Railway injects this — dynamic, NOT 3000)
#       process.env.HOSTNAME  (we set to 0.0.0.0 here)
#   and binds to 0.0.0.0:$PORT. Confirmed in .next/standalone/server.js lines 8-9.
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "[start] ─────────── Railway boot ───────────"

# ─── 1. PORT (Railway-injected, dynamic) ─────────────────────────────────────
# Railway auto-injects PORT. If somehow unset, fall back to 3000 (container
# internal). The standalone server.js honors process.env.PORT.
if [ -z "${PORT:-}" ]; then
  echo "[start] WARNING: PORT env var not set — defaulting to 3000 (Railway should inject this)"
  PORT=3000
fi
export PORT

# ─── 2. HOSTNAME (bind to all interfaces — REQUIRED by Railway) ──────────────
# Railway's reverse proxy reaches the container over the external network
# interface. If the app binds to 127.0.0.1/localhost, the proxy gets connection
# refused → 502. Force 0.0.0.0 unless explicitly overridden.
: "${HOSTNAME:=0.0.0.0}"
export HOSTNAME

# ─── 3. NODE_ENV ──────────────────────────────────────────────────────────────
: "${NODE_ENV:=production}"
export NODE_ENV

# ─── 4. DATABASE_URL (Prisma/SQLite) ──────────────────────────────────────────
# On Railway: set DATABASE_URL=file:/data/autotube.db in the dashboard Variables
# tab AND mount a Volume at /data (so the SQLite file persists across redeploys).
# If DATABASE_URL is missing, fall back to an ephemeral /tmp path so the app at
# least boots — data won't persist, but the server responds (a warning is logged).
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start] WARNING: DATABASE_URL is not set — defaulting to ephemeral file:/tmp/autotube.db"
  echo "[start]          Set DATABASE_URL=file:/data/autotube.db in Railway dashboard + mount a Volume at /data"
  DATABASE_URL="file:/tmp/autotube.db"
fi
export DATABASE_URL

# Extract the directory portion from "file:/path/to/db.sqlite" and create it.
# SQLite cannot create the DB file if the parent directory doesn't exist, which
# would make `prisma db push` fail and break the && chain → 502.
DB_PATH="$(echo "$DATABASE_URL" | sed 's|^file:||')"
DB_DIR="$(dirname "$DB_PATH")"
if [ ! -d "$DB_DIR" ]; then
  echo "[start] creating missing DB directory: $DB_DIR"
  mkdir -p "$DB_DIR"
fi

# ─── 5. Startup banner (shows up in Railway → Deploy logs) ────────────────────
echo "[start] PORT=$PORT  HOSTNAME=$HOSTNAME  NODE_ENV=$NODE_ENV"
echo "[start] DATABASE_URL=$DATABASE_URL"
echo "[start] node=$(node -v 2>/dev/null || echo 'unknown')  bun=$(bun -v 2>/dev/null || echo 'unknown')"
echo "[start] ffmpeg=$(ffmpeg -version 2>/dev/null | head -n1 || echo 'NOT FOUND')"

# ─── 6. Push Prisma schema (idempotent — creates tables if missing, no-op otherwise) ──
echo "[start] running prisma db push ..."
bun run db:push

# ─── 7. Start Next.js standalone server ───────────────────────────────────────
# `exec` replaces the shell process with node → node becomes PID 1 and
# receives Railway's SIGTERM directly (graceful shutdown on redeploy).
# server.js logs "▲ Next.js <version>" + "Ready on http://..." at boot — verify
# these lines in Railway deploy logs to confirm the port matches $PORT above.
echo "[start] starting Next.js standalone on ${HOSTNAME}:${PORT} ..."
exec node .next/standalone/server.js

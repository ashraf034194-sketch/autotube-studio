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
#     3. PORT MISMATCH: Railway's Settings → Networking expects the app on a
#        specific port (e.g. 8080 — set automatically when the domain was
#        generated). If the newer Railway UI does NOT inject PORT as an env
#        var, this script's old fallback (3000) made the app listen on 3000
#        while Railway's proxy routed to 8080 → 502.
#
#   This script fixes ALL of these:
#     • FORCES HOSTNAME=0.0.0.0 (unconditional override, NOT a fallback) — Railway
#       injects HOSTNAME=container-id which resolves to loopback 127.0.0.1; if
#       we let it through, node binds to loopback → external proxy 502s even
#       though the server is "ready". The hard `HOSTNAME="0.0.0.0"` assignment
#       overrides Railway's injection so node binds to ALL interfaces.
#     • Falls back to PORT=8080 (NOT 3000) when PORT is unset — matches the
#       port Railway's Networking section expects, so even if the newer UI
#       doesn't inject PORT, the app listens on the right port.
#     • Defaults DATABASE_URL to an ephemeral path if unset (so the app boots).
#     • Creates the DB file's parent directory (so SQLite can write the file).
#     • Logs a startup banner showing PORT (+ source: env-var vs default-8080),
#       HOSTNAME (forced override, shows Railway's original value too),
#       DATABASE_URL, runtimes — so deploy logs make any mismatch diagnosable.
#     • Uses `exec` so node becomes PID 1 (receives Railway's SIGTERM directly).
#
#   Next.js standalone server.js (auto-generated) reads:
#       process.env.PORT     (Railway injects this — dynamic; our fallback 8080)
#       process.env.HOSTNAME  (we FORCE to 0.0.0.0 — overrides Railway's container-id)
#   and binds to 0.0.0.0:$PORT. Confirmed in .next/standalone/server.js lines 8-9.
#
#   VERIFICATION: after deploy, check Railway → Deploy logs for the line
#     [start] PORT=8080 (source: env-var)  HOSTNAME=0.0.0.0 (forced override of Railway's 'df59b36ecff4')  ...
#   - PORT: if source shows 'default-8080', Railway isn't injecting PORT — set
#     PORT=8080 manually in Railway → Variables tab to force it.
#   - HOSTNAME: MUST show 0.0.0.0 (with the original container-id in quotes).
#     If it shows the container-id alone, the override didn't take → still 502.
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "[start] ─────────── Railway boot ───────────"

# ─── 1. PORT (Railway-injected, dynamic) ─────────────────────────────────────
# Railway auto-injects PORT — the value matches the "port" shown in the
# service's Settings → Networking section (for this service: 8080). In the
# newer Railway UI, PORT is sometimes NOT auto-injected (the domain's port is
# configured but the env var isn't propagated). When that happens, falling back
# to 3000 makes the app listen on 3000 while Railway's proxy routes to 8080 →
# PORT MISMATCH → 502 "Application failed to respond".
#
# Fix: fall back to 8080 (NOT 3000) so the app listens on the port Railway's
# proxy expects. Track the source (env-var vs default) so deploy logs make the
# mismatch diagnosable at a glance.
PORT_SOURCE="env-var"
if [ -z "${PORT:-}" ]; then
  echo "[start] WARNING: PORT env var not set — defaulting to 8080 (matches Railway Networking)"
  PORT=8080
  PORT_SOURCE="default-8080"
fi
export PORT

# ─── 2. HOSTNAME (bind to ALL interfaces — REQUIRED by Railway) ──────────────
# *** ROOT CAUSE OF THE RAILWAY 502 ***
# Railway sets HOSTNAME to the container's hostname (e.g. "df59b36ecff4" — a
# random container-ID). Next.js standalone server.js does:
#     const hostname = process.env.HOSTNAME || '0.0.0.0'
#     startServer({ hostname, ... })     // → server.listen(port, hostname)
# When hostname is a container ID, Node resolves it (via /etc/hosts in the
# container) to 127.0.0.1 loopback. The server then binds to loopback ONLY.
#
# Consequence: the server starts fine ("Ready in 45ms"), Railway's health
# check PASSES (it comes from inside the container → can reach loopback),
# BUT the public-facing reverse proxy (external traffic) CANNOT reach
# loopback → "Application failed to respond" (502 Bad Gateway). This is
# exactly why everything looks "successful" in deploy logs yet the public
# URL still 502s.
#
# FIX: FORCE HOSTNAME=0.0.0.0 unconditionally. Do NOT use the
# `${HOSTNAME:=0.0.0.0}` fallback idiom — that only sets when unset/empty,
# but Railway DOES set it (to the container ID), so the fallback never
# triggered. A plain `HOSTNAME="0.0.0.0"` assignment overrides whatever
# Railway injected, making node bind to all interfaces (external-accessible).
HOSTNAME_ORIGINAL="${HOSTNAME:-unset}"
HOSTNAME="0.0.0.0"
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
# CRITICAL: verify PORT here matches the "port" shown in Railway Settings →
# Networking (for this service: 8080). If they differ, Railway's reverse proxy
# will 502. The "(source: …)" tag tells you whether PORT came from Railway's
# injected env-var or our 8080 fallback — so you can tell at a glance if the
# env-var injection is working.
echo "[start] PORT=$PORT (source: $PORT_SOURCE)  HOSTNAME=$HOSTNAME (forced override of Railway's '$HOSTNAME_ORIGINAL')  NODE_ENV=$NODE_ENV"
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

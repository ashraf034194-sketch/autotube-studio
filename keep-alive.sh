#!/bin/bash
# ─── Keep-Alive Watchdog for Next.js Dev Server ─────────────────────────────
# This script runs an infinite loop: every 5 seconds it checks if the dev server
# on port 3000 responds. If it doesn't (crashed, killed, never started), it
# restarts `bun run dev` automatically. This makes the preview panel work
# "permanently" — the server self-heals within ~5 seconds of any failure.
#
# Started detached via setsid so it survives the parent bash command returning.

cd /home/z/my-project || exit 1

LOG=/home/z/my-project/watchdog.log
DEV_LOG=/home/z/my-project/dev.log

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Watchdog started (PID $$)" > "$LOG"

while true; do
  # Check if the dev server responds on port 3000
  if ! curl -sf -o /dev/null --max-time 3 http://localhost:3000/ 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] Server DOWN — starting bun run dev..." >> "$LOG"

    # Kill any stale instances first (avoid port conflicts)
    pkill -f "next dev" 2>/dev/null
    pkill -f "bun run dev" 2>/dev/null
    sleep 1

    # Start the dev server in the background (child of THIS watchdog process)
    bun run dev >> "$DEV_LOG" 2>&1 &
    DEV_PID=$!
    echo "[$(date '+%H:%M:%S')] Started dev server (PID $DEV_PID), waiting for ready..." >> "$LOG"

    # Wait up to 40s for it to be ready
    READY=0
    for i in $(seq 1 40); do
      if curl -sf -o /dev/null --max-time 3 http://localhost:3000/ 2>/dev/null; then
        READY=1
        echo "[$(date '+%H:%M:%S')] Dev server READY after ${i}s (PID $DEV_PID)" >> "$LOG"
        break
      fi
      sleep 1
    done

    if [ "$READY" = "0" ]; then
      echo "[$(date '+%H:%M:%S')] Dev server failed to become ready in 40s — will retry in 5s" >> "$LOG"
    fi
  fi

  # Check again in 5 seconds
  sleep 5
done

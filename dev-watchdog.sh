#!/bin/bash
# Self-healing watchdog for the Next.js dev server.
# Restarts `bun run dev` whenever it dies, so the preview panel
# never goes blank (the "Z favicon only" symptom = server is down).
cd /home/z/my-project

LOG=/home/z/my-project/dev.log

while true; do
  # Truncate log on each restart so we see fresh output
  : > "$LOG"
  echo "[watchdog $(date '+%H:%M:%S')] starting dev server..." >> "$LOG"
  
  # Start dev server in foreground of this loop iteration.
  # `exec` replaces the shell so signals propagate cleanly.
  bun run dev >> "$LOG" 2>&1
  EXIT_CODE=$?
  echo "[watchdog $(date '+%H:%M:%S')] dev server exited (code $EXIT_CODE). Restarting in 3s..." >> "$LOG"
  
  # Clean up any lingering next-server processes before restart
  pkill -f "next-server" 2>/dev/null
  pkill -f "next dev" 2>/dev/null
  sleep 3
done

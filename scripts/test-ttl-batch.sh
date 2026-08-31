#!/bin/bash
# Test: 24-image batch (20-image junction + 4-image partial junction)
# Verifies the job completes within the 3-hour TTL.
# Mix of concrete prompts (→ Pexels stock) and abstract prompts (→ Cloudflare AI).
set -u
cd /home/z/my-project

echo "=========================================="
echo "TTL Batch Test — 24 images"
echo "=========================================="

# Build the 24-prompt JSON body (Branch A: pre-supplied prompts → skips Style DNA + chunking,
# goes straight to junction-gated image generation).
PROMPTS=$(cat <<'JSON'
[
  "a person writing in a notebook at a wooden desk by a sunlit window",
  "a cup of coffee on a rustic table with morning light",
  "hands typing on a laptop keyboard close-up",
  "a person hiking on a forest trail in autumn",
  "waves gently crashing on a sandy beach at golden hour",
  "an open book with reading glasses on a library table",
  "a person meditating on a mountain summit at sunrise",
  "raindrops sliding down a window pane with blurred city lights behind",
  "a chef chopping fresh vegetables on a cutting board",
  "a cyclist riding along a coastal road in the afternoon",
  "the slow transformation of a landscape across the seasons",
  "the feeling of persistence shown through a winding mountain path",
  "personal growth visualized as a sapling growing toward light",
  "the passage of time shown through shifting clouds over a valley",
  "resilience depicted as a lone tree standing in a storm",
  "a person sitting on a park bench feeding pigeons",
  "a steam rising from a teacup in a cozy kitchen",
  "a dog running through a green field carrying a stick",
  "an elderly couple walking hand in hand on a beach",
  "a city skyline at dusk with lights beginning to twinkle",
  "a musician playing acoustic guitar on a street corner",
  "a child blowing dandelion seeds in a meadow",
  "the abstract concept of hope shown through a sunrise over mountains",
  "a single candle flame glowing in a dark room"
]
JSON
)

echo ""
echo "[1/3] POSTing 24-image batch job..."
T0=$(date +%s)
POST_RESP=$(curl -s -X POST http://localhost:3000/api/images \
  -H "Content-Type: application/json" \
  -d "{\"prompts\": $PROMPTS}")
echo "POST response: $POST_RESP"
JOB_ID=$(echo "$POST_RESP" | grep -oE "img-[0-9]+-[a-z0-9]+" | head -1)
if [ -z "$JOB_ID" ]; then
  echo "ERROR: could not parse jobId from response"
  exit 1
fi
echo "Job ID: $JOB_ID"
echo ""

echo "[2/3] Polling job status until done (max 300s)..."
LAST_STATUS=""
MAX_WAIT=300
WAITED=0
while [ "$WAITED" -lt "$MAX_WAIT" ]; do
  STATUS_JSON=$(curl -s "http://localhost:3000/api/images?jobId=$JOB_ID" 2>/dev/null)
  STATUS=$(echo "$STATUS_JSON" | grep -oE '"status":"[^"]+"' | head -1 | cut -d'"' -f4)
  COMPLETED=$(echo "$STATUS_JSON" | grep -oE '"completed":[0-9]+' | head -1 | cut -d':' -f2)
  FAILED=$(echo "$STATUS_JSON" | grep -oE '"failed":[0-9]+' | head -1 | cut -d':' -f2)
  WAITING=$(echo "$STATUS_JSON" | grep -oE '"waiting":[0-9]+' | head -1 | cut -d':' -f2)
  TOTAL=$(echo "$STATUS_JSON" | grep -oE '"total":[0-9]+' | head -1 | cut -d':' -f2)
  CURBATCH=$(echo "$STATUS_JSON" | grep -oE '"currentBatch":[0-9]+' | head -1 | cut -d':' -f2)

  NOW=$(date +%s)
  ELAPSED=$((NOW - T0))
  echo "  [${ELAPSED}s] status=$STATUS completed=$COMPLETED/$TOTAL failed=$FAILED waiting=$WAITING batch=$CURBATCH"

  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then
    echo ""
    echo "Job reached terminal state: $STATUS"
    break
  fi
  if [ "$STATUS" = "$LAST_STATUS" ] && [ "$COMPLETED" = "$LAST_COMPLETED" ]; then
    # no progress — still wait but note it
    :
  fi
  LAST_STATUS="$STATUS"
  LAST_COMPLETED="$COMPLETED"
  sleep 5
  WAITED=$((WAITED + 5))
done

T1=$(date +%s)
DURATION=$((T1 - T0))
echo ""
echo "[3/3] Final results"
echo "=========================================="
echo "Job ID:      $JOB_ID"
echo "Total time:  ${DURATION}s"
echo "Final status JSON (trimmed):"
curl -s "http://localhost:3000/api/images?jobId=$JOB_ID" 2>/dev/null | head -c 2000
echo ""
echo "=========================================="

# Verify images exist on disk
echo ""
echo "=== Images on disk ==="
IMG_DIR="/tmp/autotube-images/$JOB_ID"
if [ -d "$IMG_DIR" ]; then
  ls -la "$IMG_DIR" | head -30
  echo ""
  IMG_COUNT=$(ls "$IMG_DIR"/*.jpg 2>/dev/null | wc -l)
  echo "Total .jpg files: $IMG_COUNT"
  echo ""
  echo "=== Sample image dimensions (ffprobe) ==="
  for f in $(ls "$IMG_DIR"/*.jpg 2>/dev/null | head -4); do
    DIMS=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$f" 2>/dev/null)
    SZ=$(stat -c%s "$f" 2>/dev/null)
    echo "  $(basename $f): ${DIMS} (${SZ} bytes)"
  done
else
  echo "Image dir not found: $IMG_DIR"
fi

echo ""
echo "=== Verdict ==="
if [ "$STATUS" = "done" ]; then
  echo "PASS — job completed in ${DURATION}s (well within 3-hour TTL)"
else
  echo "FAIL/INCOMPLETE — status=$STATUS after ${DURATION}s"
fi

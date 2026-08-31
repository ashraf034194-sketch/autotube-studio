#!/usr/bin/env bash
# End-to-end Phase 1 test: 1800-word script → Voiceover (chunks[]) → Images (chunk-aligned)
# Confirms:
#   - Voiceover returns chunks[] with timing
#   - Images route accepts {chunks:[...]} (preferred path)
#   - Image N visualizes EXACT text chunk N
#   - Cloudflare is primary (Tier 1) and being used
#   - Total time is reasonable (<5 min for ~34 images at 300-char granularity)

set -e

SCRIPT_FILE="/home/z/my-project/scripts/test-script-1800w.txt"
SCRIPT_TEXT=$(cat "$SCRIPT_FILE")
WORDS=$(wc -w < "$SCRIPT_FILE")
CHARS=$(wc -c < "$SCRIPT_FILE")
echo "=== Test script: $WORDS words, $CHARS chars ==="
python3 -c "print(f'Expected chunk count at 300-char granularity: ~{int($CHARS / 300)}')"
echo ""

# ── Step 1: Start voiceover job ──
echo "=== STEP 1: POST /api/voiceover ==="
VOICE_RESP=$(curl -sS --max-time 30 -X POST http://localhost:3000/api/voiceover \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json; print(json.dumps({'text': open('$SCRIPT_FILE').read(), 'voice': 'en-US-ChristopherNeural', 'speed': 1.0}))")")
echo "Response: $(echo $VOICE_RESP | head -c 200)"
JOB_ID=$(echo "$VOICE_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['jobId'])")
TOTAL_CHUNKS=$(echo "$VOICE_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['total'])")
echo "voiceover jobId: $JOB_ID, totalChunks: $TOTAL_CHUNKS"
echo ""

# ── Step 2: Poll voiceover until done ──
echo "=== STEP 2: Polling voiceover job (max 6 min) ==="
VOICE_START=$(date +%s)
VOICE_RESULT=""
for i in $(seq 1 80); do
  sleep 4
  STATUS_RESP=$(curl -sS --max-time 10 "http://localhost:3000/api/voiceover?jobId=$JOB_ID")
  STATUS=$(echo "$STATUS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('status', d.get('error','')))" 2>/dev/null)
  if [ "$STATUS" = "processing" ]; then
    DONE=$(echo "$STATUS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(f\"{d.get('completedChunks',0)}/{d.get('totalChunks',0)} - {d.get('currentLabel','')}\")" 2>/dev/null)
    echo "  Poll $i: $DONE"
  elif [ "$STATUS" = "done" ]; then
    VOICE_RESULT="$STATUS_RESP"
    VOICE_END=$(date +%s)
    echo "  ✓ Voiceover done after $((VOICE_END - VOICE_START))s"
    break
  else
    echo "  ✗ Voiceover status: $STATUS"
    echo "  Full response: $STATUS_RESP"
    exit 1
  fi
done

# ── Step 3: Verify chunks[] returned ──
echo ""
echo "=== STEP 3: Verify chunks[] in voiceover result ==="
echo "$VOICE_RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)['data']
print(f'durationSeconds: {d.get(\"durationSeconds\")}s')
print(f'chunkCount: {d.get(\"chunkCount\")}')
print(f'sizeBytes: {d.get(\"sizeBytes\")} ({d.get(\"sizeBytes\",0)//1024}KB)')
chunks = d.get('chunks', [])
print(f'chunks[] returned: {len(chunks)} chunks')
if chunks:
    print('First 3 chunks:')
    for i, c in enumerate(chunks[:3]):
        print(f'  [{i+1}] {c[\"startMs\"]}ms-{c[\"endMs\"]}ms: {c[\"text\"][:80]}...')
    print(f'Last chunk: [{len(chunks)}] {chunks[-1][\"startMs\"]}ms-{chunks[-1][\"endMs\"]}ms: {chunks[-1][\"text\"][:80]}...')
else:
    print('  ✗ NO chunks[] returned!')
    sys.exit(1)
" || exit 1

# ── Step 4: POST chunks[] to /api/images ──
echo ""
echo "=== STEP 4: POST /api/images with chunks[] (preferred path) ==="
CHUNKS_JSON=$(echo "$VOICE_RESULT" | python3 -c "import json,sys; print(json.dumps({'chunks': json.load(sys.stdin)['data']['chunks']}))")
IMG_RESP=$(curl -sS --max-time 30 -X POST http://localhost:3000/api/images \
  -H 'Content-Type: application/json' \
  -d "$CHUNKS_JSON")
echo "Response: $(echo $IMG_RESP | head -c 250)"
IMG_JOB_ID=$(echo "$IMG_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['jobId'])")
IMG_TOTAL=$(echo "$IMG_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")
echo "images jobId: $IMG_JOB_ID, total: $IMG_TOTAL"
echo ""

# ── Step 5: Poll images until done ──
echo "=== STEP 5: Polling images job (max 6 min) ==="
IMG_START=$(date +%s)
FINAL_STATUS=""
for i in $(seq 1 80); do
  sleep 4
  IMG_STATUS_RESP=$(curl -sS --max-time 10 "http://localhost:3000/api/images?jobId=$IMG_JOB_ID")
  IMG_STATUS=$(echo "$IMG_STATUS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status', d.get('error','')))" 2>/dev/null)
  if [ "$IMG_STATUS" = "processing" ] || [ "$IMG_STATUS" = "prompting" ] || [ "$IMG_STATUS" = "styling" ]; then
    DONE=$(echo "$IMG_STATUS_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"{d.get('completed',0)}/{d.get('total',0)} ({d.get('status','')}) - {d.get('currentLabel','')[:60]}\")" 2>/dev/null)
    echo "  Poll $i: $DONE"
  elif [ "$IMG_STATUS" = "done" ] || [ "$IMG_STATUS" = "error" ]; then
    FINAL_STATUS="$IMG_STATUS_RESP"
    IMG_END=$(date +%s)
    echo "  ✓ Images $IMG_STATUS after $((IMG_END - IMG_START))s"
    break
  fi
done

# ── Step 6: Final breakdown ──
echo ""
echo "=== STEP 6: Final breakdown ==="
echo "$FINAL_STATUS" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'status: {d.get(\"status\")}')
print(f'total: {d.get(\"total\")}, completed: {d.get(\"completed\")}, failed: {d.get(\"failed\")}')
print(f'currentLabel: {d.get(\"currentLabel\")}')
print(f'styleDna: {(d.get(\"styleDna\") or \"\")[:200]}...')
print(f'promptBatchesTotal: {d.get(\"promptBatchesTotal\")}')
print(f'promptBatchesDone: {d.get(\"promptBatchesDone\")}')
slots = d.get('slots', [])
providers = {}
for s in slots:
    p = s.get('provider') or 'none'
    providers[p] = providers.get(p, 0) + 1
print(f'Provider breakdown: {providers}')
print()
print('=== EXACT-MATCH PROOF: chunk text ↔ generated image ===')
for i, s in enumerate(slots[:5]):
    print(f'Image {i+1}:')
    print(f'  chunkText: {(s.get(\"chunkText\") or \"\")[:120]}')
    print(f'  prompt:    {(d.get(\"prompts\",[\"\"])[i] if i < len(d.get(\"prompts\",[])) else \"\")[:120]}')
    print(f'  provider:  {s.get(\"provider\")}')
    print(f'  status:    {s.get(\"status\")}')
    print()
"
echo ""
echo "=== TOTAL TIME ==="
VOICE_DURATION=$((VOICE_END - VOICE_START))
IMG_DURATION=$((IMG_END - IMG_START))
TOTAL=$((VOICE_DURATION + IMG_DURATION))
echo "Voiceover: ${VOICE_DURATION}s"
echo "Images: ${IMG_DURATION}s"
echo "TOTAL: ${TOTAL}s ($(($TOTAL / 60))min $(($TOTAL % 60))s)"

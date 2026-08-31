#!/usr/bin/env bash
# Phase 5B-regression test: AI image generation on a long script targeting
# 108 images. Confirms the job-based pattern: POST returns jobId instantly
# (no 502), GET polling advances through the 'prompting' → 'processing'
# phases, prompts eventually populate, and at least one image completes.
#
# This script intentionally does NOT wait for all 108 images to finish —
# at 2 workers in parallel and 5+ provider fallbacks per image, that can
# take 20+ minutes (especially when Manus Tier 1 is in cooldown). It just
# proves the gateway-timeout regression is fixed and the FSM transitions
# correctly. Pass --full to wait for the whole batch.
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
FULL_RUN=0
[ "${1:-}" = "--full" ] && FULL_RUN=1

# ~580-word script that, paired with durationSeconds=432 (7:12 audio),
# targets Math.ceil(432/4) = 108 images — exactly the user's reported case.
LONG_SCRIPT=$(cat <<'EOF'
Welcome back to the channel everyone. Today we are diving into the science of habits and why they quietly shape everything we do. Every morning you wake up, brush your teeth, make coffee, check your phone. None of these decisions feels like a decision. They feel automatic, almost invisible. And that is the whole point. Habits are the brain's way of conserving energy. When a behavior becomes automatic, the brain stops fully participating in the choice. It chunks the sequence into a single unit and runs it on autopilot. This is why habits are so powerful, and why they are so hard to break. The brain does not distinguish between good habits and bad habits. It just looks for cues, runs routines, and collects rewards.

Let us walk through a typical morning. The alarm sounds. That beep is the cue. You swing your legs out of bed. That is the routine. The relief of silencing the alarm is the reward. You stumble to the kitchen, fill the kettle, light the stove. The smell of coffee becomes its own cue, triggering the next routine. Each step is a tiny loop, cue, routine, reward, repeated so many times that it has worn a groove into your neural pathways. By the time you finish your first cup, you have already executed dozens of habits without consciously deciding any of them.

Now consider what happens when you try to change one. Say you want to stop checking your phone first thing in the morning. The cue is the phone on the nightstand. The routine is reaching for it. The reward is the dopamine hit of new notifications. If you simply try to stop, the cue still fires, the brain still expects the reward, and you have given it nothing. You feel restless. You cave. The habit wins. But if you replace the routine, say you put a book on the nightstand and reach for that instead, the same cue triggers a different behavior. The book can deliver the same escape, just through a healthier channel. Do this enough times and the new pathway starts to form. The old one weakens not because you fought it, but because you outcompeted it.

This is the deeper insight. Habits are not deleted. They are replaced. The brain does not erase neural pathways once they are carved. It just prefers the one that gets used most recently and most often. So the strategy is not willpower, it is design. Design the cue, design the routine, design the reward, and let repetition do the work. Every action you take is a small vote for the kind of person you are becoming. Every time you choose the book over the phone, you are casting a vote for being a reader. Every time you choose the workout over the couch, you are casting a vote for being an athlete.

And the more votes you cast, the more your self-image starts to shift. You stop saying I am trying to read more, and you start saying I am a reader. That shift in language reflects a shift in identity. And once the identity shifts, the habits flow naturally, because the behavior is now consistent with who you believe you are. So do not try to change everything at once. Pick one habit, one cue, one routine, one reward. Design the replacement. Make it small, make it obvious, make it easy to start. Do it for two weeks. Let the loop strengthen. Then add the next one. Remember, you do not rise to the level of your goals. You fall to the level of your systems. Thanks for watching, and I will see you in the next one.
EOF
)

# 432s duration → ceil(432/4) = 108 images
DURATION=432
EXPECTED_IMAGES=$(( (DURATION + 3) / 4 ))
echo "▶ Test script: ~$(wc -w <<< "$LONG_SCRIPT") words, duration=${DURATION}s → expecting ${EXPECTED_IMAGES} images"

# ── 1) POST — must return jobId immediately (the old version 502'd here) ──
echo
echo "▶ POST /api/images ..."
POST_START=$(date +%s%3N)
START_JSON=$(curl -sS -X POST "$BASE/api/images" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg text "$LONG_SCRIPT" --argjson dur "$DURATION" '{text: $text, durationSeconds: $dur}')")
POST_END=$(date +%s%3N)
POST_MS=$((POST_END - POST_START))

JOB_ID=$(jq -r '.jobId // empty' <<< "$START_JSON")
TOTAL=$(jq -r '.total // empty' <<< "$START_JSON")
PROMPTS_LEN=$(jq -r '.prompts | length' <<< "$START_JSON")

echo "  HTTP response time: ${POST_MS} ms  (must be < 5000 — confirms non-blocking)"
echo "  Raw response: $START_JSON"
if [ -z "$JOB_ID" ]; then
  echo "FAIL: no jobId returned"
  exit 1
fi
echo "  jobId=$JOB_ID  total=$TOTAL  prompts.length=$PROMPTS_LEN"

if [ "$POST_MS" -gt 5000 ]; then
  echo "FAIL: POST took ${POST_MS}ms — looks blocking, regression present"
  exit 1
fi
if [ "$PROMPTS_LEN" -ne 0 ]; then
  echo "WARN: POST returned prompts (length=$PROMPTS_LEN) — expected empty (prompts should be generated in background)"
fi

# ── 2) Poll GET — confirm phase transitions prompting → processing → done ──
echo
echo "▶ Polling GET /api/images?jobId=..."
DEADLINE=$(( (POST_END / 1000) + 1800 ))   # 30-minute hard cap
LAST_PHASE=""
LAST_DONE=-1
FIRST_PROCESSING_TS=""
FIRST_IMAGE_DONE=0

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 2
  POLL_JSON=$(curl -sS "$BASE/api/images?jobId=$JOB_ID")
  STATUS=$(jq -r '.status // "unknown"' <<< "$POLL_JSON")
  TOTAL_Q=$(jq -r '.total // 0' <<< "$POLL_JSON")
  COMPLETED=$(jq -r '.completed // 0' <<< "$POLL_JSON")
  PROMPTS_Q_LEN=$(jq -r '.prompts | length' <<< "$POLL_JSON")
  LABEL=$(jq -r '.currentLabel // ""' <<< "$POLL_JSON")
  SLOTS_LEN=$(jq -r '.slots | length' <<< "$POLL_JSON")

  if [ "$STATUS" != "$LAST_PHASE" ] || [ "$COMPLETED" -ne "$LAST_DONE" ]; then
    echo "  [$(date +%T)] status=$STATUS  total=$TOTAL_Q  completed=$COMPLETED  prompts.len=$PROMPTS_Q_LEN  slots.len=$SLOTS_LEN  label=$LABEL"
    LAST_PHASE=$STATUS
    LAST_DONE=$COMPLETED
  fi

  # Phase transition: prompting → processing
  if [ "$STATUS" = "processing" ] && [ -z "$FIRST_PROCESSING_TS" ]; then
    FIRST_PROCESSING_TS=$(date +%s)
    if [ "$PROMPTS_Q_LEN" -lt 1 ]; then
      echo "FAIL: entered 'processing' phase but prompts array is still empty"
      exit 1
    fi
    if [ "$SLOTS_LEN" -lt 1 ]; then
      echo "FAIL: entered 'processing' phase but slots array is still empty"
      exit 1
    fi
    echo "  ✓ Phase transition prompting → processing confirmed"
    echo "    prompts populated: $PROMPTS_Q_LEN, slots: $SLOTS_LEN"
    if [ "$FULL_RUN" -eq 0 ]; then
      # Wait until at least one image completes, then exit successfully.
      echo "  --full not set; waiting for first image to complete..."
    fi
  fi

  if [ "$STATUS" = "done" ]; then
    echo
    echo "PASS — image batch completed:"
    echo "  completed=$COMPLETED / $TOTAL_Q"
    exit 0
  fi

  if [ "$STATUS" = "error" ]; then
    ERR=$(jq -r '.error // "unknown error"' <<< "$POLL_JSON")
    echo "FAIL — job errored: $ERR"
    exit 1
  fi

  if [ "$FULL_RUN" -eq 0 ] && [ "$FIRST_IMAGE_DONE" -eq 0 ] && [ "$COMPLETED" -ge 1 ]; then
    FIRST_IMAGE_DONE=1
    echo "  ✓ First image completed — regression is FIXED, full-batch run skipped"
    echo "  (pass --full to wait for all $TOTAL_Q images)"
    exit 0
  fi
done

echo "FAIL — job did not complete within 30 minutes"
exit 1

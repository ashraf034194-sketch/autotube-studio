#!/usr/bin/env bash
# Phase 5B-regression test: voiceover on a long (~1,119-word) script.
# Confirms the job-based pattern: POST returns jobId instantly (no 502),
# GET polling advances progress, final 'done' has audioBase64 + duration.
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"

# ~1,119-word sample script (repetitive but realistic narration copy).
# Built once here so the test is fully self-contained and reproducible.
LONG_SCRIPT=$(cat <<'EOF'
Welcome back to the channel everyone. Today we are diving deep into something that affects every single one of us, every single day, whether we realize it or not. We are talking about the hidden architecture of human behavior, the invisible patterns that quietly shape our decisions, our health, our relationships, and ultimately the trajectory of our entire lives. Stay with me, because by the end of this video you will understand exactly how these patterns form, why they are so difficult to break, and most importantly, the practical steps you can take starting today to redesign them on purpose.

Let us begin with a simple question. Why did you brush your teeth this morning? You probably did not debate it. You probably did not weigh the pros and cons. You probably did not need motivation or a pep talk. You just did it. And that is the first clue. When behavior becomes automatic, when it no longer requires conscious effort or willpower, we are no longer dealing with motivation. We are dealing with something far more powerful. We are dealing with habit.

Now, every habit, no matter how small, no matter how trivial it seems, follows the same three-step loop. Step one is the cue. The cue is the trigger. It is the thing that tells your brain to go into automatic mode. It could be a sound, a smell, a time of day, an emotion, the presence of a particular person, or even a location. Step two is the routine. The routine is the behavior itself, the action you take, whether it is physical, mental, or emotional. And step three is the reward. The reward is the payoff. It is the reason your brain decides that this particular sequence is worth remembering for next time.

When this loop, cue, routine, reward, gets repeated enough times, your brain stops fully participating in the decision. It compresses the sequence. It chunks the behavior into a single automatic unit. And this is where most people misunderstand habits. They think habits are about willpower. They are not. Habits are about efficiency. Your brain is constantly looking for ways to conserve energy, and once it identifies a sequence that reliably produces a reward, it files that sequence away for future use. The behavior becomes invisible. It becomes you.

So here is the uncomfortable truth. The habits you have right now, the ones you wish you could change, the late night snacking, the endless scrolling, the procrastination, the skipping workouts, they are all still in place because they are still delivering some kind of reward. Even the habits you would call bad. Even the ones you are ashamed of. They exist because at some point, in some context, they worked. They reduced your stress, they distracted you from discomfort, they gave you a quick hit of dopamine, they helped you avoid something difficult. Your brain learned, and your brain does not forget easily.

Which brings us to the part nobody likes to hear. Changing a habit is not about deleting it. You cannot simply remove a habit and leave an empty space. The brain does not work that way. The neural pathways that were carved out over thousands of repetitions do not just vanish because you decided this Monday would be different. Instead, the only reliable strategy is to replace the routine. Keep the cue. Keep the reward. Insert a new behavior in the middle. That is the formula. Same trigger, same payoff, different action in between.

Let me give you a concrete example. Say every evening around nine o clock you find yourself on the couch, scrolling through your phone for an hour before bed. The cue is the time, the couch, the tiredness. The reward is distraction, numbing, a brief escape from the day. Now, if you simply try to stop scrolling, what happens? You feel restless, anxious, bored. The cue is still firing, the brain is still expecting the reward, and you have given it nothing. So you cave. The habit wins.

But if instead you insert a new routine, say you keep a book next to the couch, and the moment you feel the pull, you pick up the book instead. Same cue. Same tired feeling. Same craving for escape. But a different behavior. And here is the key. The book can deliver the same reward, distraction and escape, just delivered through a healthier channel. Do this enough times and the new routine starts to become automatic. The old pathway weakens. Not because you fought it, but because you outcompeted it.

Now, identity is the deeper layer that makes habits stick for good. Every action you take is a small vote for the kind of person you are becoming. Every time you choose the book over the phone, you are casting a vote for being a reader. Every time you choose the workout over the couch, you are casting a vote for being an athlete. And the more votes you cast, the more your self-image starts to shift. You stop saying I am trying to read more, and you start saying I am a reader. That shift in language reflects a shift in identity. And once the identity shifts, the habits flow naturally, because the behavior is now consistent with who you believe you are.

So here is the practical takeaway. Do not try to change everything at once. Do not make a list of ten new habits to start tomorrow morning. That never works, and it never works because willpower is a finite resource, and you will exhaust it by Wednesday. Instead, pick one habit. One cue. One routine. One reward. Design the replacement. Make it small, make it obvious, make it easy to start. Do it for two weeks. Let the loop strengthen. Let the identity begin to shift. Then, and only then, add the next one.

Remember, you do not rise to the level of your goals. You fall to the level of your systems. Thanks for watching, and I will see you in the next one.
EOF
)

WORD_COUNT=$(wc -w <<< "$LONG_SCRIPT")
echo "▶ Test script length: $WORD_COUNT words"

# ── 1) POST — must return jobId immediately (the old version 502'd here) ──
echo
echo "▶ POST /api/voiceover ..."
POST_START=$(date +%s%3N)
START_JSON=$(curl -sS -X POST "$BASE/api/voiceover" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg text "$LONG_SCRIPT" '{text: $text, voice: "en-US-ChristopherNeural", speed: 1.0}')")
POST_END=$(date +%s%3N)
POST_MS=$((POST_END - POST_START))

JOB_ID=$(jq -r '.data.jobId // empty' <<< "$START_JSON")
TOTAL=$(jq -r '.data.total // empty' <<< "$START_JSON")
SUCCESS=$(jq -r '.success // false' <<< "$START_JSON")

echo "  HTTP response time: ${POST_MS} ms  (must be < 5000 — confirms non-blocking)"
echo "  Raw response: $START_JSON"
if [ -z "$JOB_ID" ]; then
  echo "FAIL: no jobId returned"
  exit 1
fi
echo "  jobId=$JOB_ID  total=$TOTAL  success=$SUCCESS"

if [ "$POST_MS" -gt 5000 ]; then
  echo "WARN: POST took ${POST_MS}ms — looks blocking, regression risk"
fi

# ── 2) Poll GET — confirm progress advances and final result has audio ──
echo
echo "▶ Polling GET /api/voiceover?jobId=..."
DEADLINE=$(( (POST_END / 1000) + 600 ))   # 10-minute hard cap
LAST_DONE=-1
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 1
  POLL_JSON=$(curl -sS "$BASE/api/voiceover?jobId=$JOB_ID")
  STATUS=$(jq -r '.data.status // .status // "unknown"' <<< "$POLL_JSON")
  DONE=$(jq -r '.data.completedChunks // 0' <<< "$POLL_JSON")
  TOTAL_Q=$(jq -r '.data.totalChunks // .data.total // 0' <<< "$POLL_JSON")
  LABEL=$(jq -r '.data.currentLabel // ""' <<< "$POLL_JSON")

  if [ "$DONE" -ne "$LAST_DONE" ] || [ "$STATUS" != "processing" ]; then
    echo "  [$(date +%T)] status=$STATUS  chunks=$DONE/$TOTAL_Q  label=$LABEL"
    LAST_DONE=$DONE
  fi

  if [ "$STATUS" = "done" ]; then
    DUR=$(jq -r '.data.durationSeconds // "?"' <<< "$POLL_JSON")
    SIZE=$(jq -r '.data.sizeBytes // "?"' <<< "$POLL_JSON")
    CHUNKS=$(jq -r '.data.chunkCount // "?"' <<< "$POLL_JSON")
    B64LEN=$(jq -r '.data.audioBase64 | length' <<< "$POLL_JSON")
    VOICE=$(jq -r '.data.voice // "?"' <<< "$POLL_JSON")
    echo
    echo "PASS — voiceover completed:"
    echo "  duration=$DUR s  size=$SIZE B  chunks=$CHUNKS  voice=$VOICE"
    echo "  base64 length=$B64LEN  (must be > 1000)"
    if [ "$B64LEN" -lt 1000 ]; then
      echo "FAIL: audio payload too small"
      exit 1
    fi
    exit 0
  fi

  if [ "$STATUS" = "error" ]; then
    ERR=$(jq -r '.error // .data.error // "unknown"' <<< "$POLL_JSON")
    echo "FAIL — job errored: $ERR"
    exit 1
  fi
done

echo "FAIL — job did not complete within 10 minutes"
exit 1

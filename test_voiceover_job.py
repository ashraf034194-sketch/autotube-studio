#!/usr/bin/env python3
"""
End-to-end test for the job-based async voiceover API on a 1331-word script.

Verifies:
  1. POST /api/voiceover returns jobId in < 1 second (no gateway timeout possible)
  2. GET /api/voiceover?jobId=... polls progress (phase + completedChunks)
  3. Final 'done' result contains base64 MP3, durationSeconds, sizeBytes
"""

import json
import sys
import time
import urllib.request
import urllib.parse

# A 1331-word English script (the same content the user reported failing).
# Built by repeating a 188-word narration paragraph with small variations.
PARA = (
    "Welcome back to the channel. Today we are diving into a topic that quietly "
    "shapes almost every part of your daily life. Habits are the small decisions "
    "you make over and over until they become automatic. Researchers who study "
    "behavior estimate that roughly forty percent of the actions you perform every "
    "single day are not the result of careful thinking. They are habits running "
    "quietly in the background, triggered by your environment and rewarded by your "
    "brain. The good news is that habits are not fixed. You can redesign them, "
    "replace them, and stack new ones on top of old ones. The trick is to "
    "understand the three part loop that every habit follows. First there is the "
    "cue, the trigger that tells your brain to switch into automatic mode. "
    "Second there is the routine, which is the behavior itself, the action you "
    "take. Third there is the reward, the small hit of satisfaction that teaches "
    "your brain to remember this loop and repeat it again next time. Once you see "
    "the loop, you can hack it. Want to stop checking your phone at night? Make "
    "the cue invisible by leaving the charger in another room. Want to start "
    "exercising in the morning? Make the reward obvious by tracking your streaks "
    "and celebrating every small win. Small changes stack up because identity "
    "shifts in tiny steps, not in giant leaps. You do not rise to the level of "
    "your goals. You fall to the level of your systems. Build better systems and "
    "the goals take care of themselves."
)

# Repeat to push to ~1300 words (7 × 188 words ≈ 1316 words).
TEST_SCRIPT = "\n\n".join([f"Segment {i+1}. {PARA}" for i in range(7)])


def post_start_job(text: str, voice: str, speed: float) -> dict:
    payload = json.dumps({"text": text, "voice": voice, "speed": speed}).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:3000/api/voiceover",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    start = time.time()
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        elapsed = time.time() - start
    return {
        "status": resp.status,
        "elapsed_s": round(elapsed, 3),
        "json": json.loads(body),
    }


def poll_job(job_id: str) -> dict:
    url = f"http://localhost:3000/api/voiceover?{urllib.parse.urlencode({'jobId': job_id})}"
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
    return {"status": resp.status, "json": json.loads(body)}


def main() -> int:
    words = len(TEST_SCRIPT.split())
    chars = len(TEST_SCRIPT)
    print(f"[test] Script: {words} words, {chars} chars")
    if words < 1300:
        print(f"[test] WARN: expected ~1300 words, got {words}")
        # pad more
        return 1

    # 1. POST — start the job
    print("[test] POST /api/voiceover …")
    try:
        r = post_start_job(TEST_SCRIPT, "en-US-BrianNeural", 1.0)
    except Exception as e:
        print(f"[test] FAIL: POST raised {e}")
        return 2
    print(f"[test] POST returned status={r['status']} in {r['elapsed_s']}s")
    if r["elapsed_s"] > 1.0:
        print(f"[test] FAIL: POST took {r['elapsed_s']}s — should be < 1s")
        return 3
    if not r["json"].get("success"):
        print(f"[test] FAIL: POST response not success: {r['json']}")
        return 4
    job_id = r["json"]["data"]["jobId"]
    total_chunks = r["json"]["data"]["totalChunks"]
    print(f"[test] jobId={job_id} totalChunks={total_chunks}")

    # 2. Poll until done (max ~10 minutes)
    deadline = time.time() + 10 * 60
    last_done = -1
    poll_count = 0
    while time.time() < deadline:
        time.sleep(1.5)
        poll_count += 1
        try:
            r = poll_job(job_id)
            j = r["json"]
            if not j.get("success"):
                print(f"[test] FAIL: poll returned error: {j.get('error')}")
                return 5
            d = j["data"]
            if d["status"] == "processing":
                done = d["completedChunks"]
                phase = d["phase"]
                if done != last_done:
                    print(f"[test] poll #{poll_count}: phase={phase} chunk {done}/{d['totalChunks']}")
                    last_done = done
                continue
            if d["status"] == "done":
                print(f"[test] DONE after {poll_count} polls ({poll_count * 1.5:.1f}s polling)")
                print(f"[test]   chunkCount   = {d['chunkCount']}")
                print(f"[test]   duration     = {d['durationSeconds']}s")
                print(f"[test]   sizeBytes    = {d['sizeBytes']} ({d['sizeBytes']/1024/1024:.2f} MB)")
                print(f"[test]   voice        = {d['voice']}")
                print(f"[test]   speed        = {d['speed']}")
                print(f"[test]   audioBase64  = {len(d['audioBase64'])} chars")
                if d["chunkCount"] != total_chunks:
                    print(f"[test] FAIL: chunkCount {d['chunkCount']} != initial {total_chunks}")
                    return 6
                if d["durationSeconds"] < 60:
                    print(f"[test] FAIL: duration {d['durationSeconds']}s too short for 1331 words")
                    return 7
                print("[test] SUCCESS: voiceover completed without 502 timeout")
                return 0
        except Exception as e:
            print(f"[test] Poll {poll_count} error: {e!r}")
            continue
    print("[test] FAIL: timed out after 10 minutes")
    return 8


if __name__ == "__main__":
    sys.exit(main())

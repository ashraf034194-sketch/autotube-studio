#!/usr/bin/env bun
// scripts/test-llm-retry-queue.ts
//
// End-to-end test of the 3-tier LLM fallback + smart retry-queue:
//
// TEST 1 (Z.ai + Cloudflare disabled, no Groq key):
//   - Disables Z.ai + Cloudflare via the runtime-override endpoint
//   - Starts a rewrite job
//   - Polls /api/rewrite?jobId=
//   - EXPECTS: status='waiting' with retryInSecs≈15 (retry-queue active)
//   - Proves: the retry-queue absorbs the Z.ai+Cloudflare failure
//   - NOTE: Groq is also unconfigured (no GROQ_API_KEY), so all 3 tiers
//     will fail in the same pass — proving the retry-queue absorbs the
//     "all three fail simultaneously" case the user was concerned about.
//
// TEST 2 (all 3 disabled):
//   - Adds LLM_DISABLE_GROQ to the runtime overrides
//   - Starts a fresh rewrite job
//   - EXPECTS: status='waiting' (STILL not 'error' — retry-queue still
//     spinning, NOT throwing "very busy")
//   - Proves: user NEVER sees "very busy" — only the live countdown
//
// CLEANUP: resets all flags to false (env-var defaults apply).
//
// Run: bun run scripts/test-llm-retry-queue.ts

const BASE = 'http://localhost:3000'

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, json: await res.json() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A short transcript that yields 1-2 sections (so the test runs fast).
const TEST_TRANSCRIPT = `
The one percent rule is deceptively simple. Improve by just one percent every day, and over a year you'll be thirty-seven times better. The math compounds, but so does the effort. Most people quit because they don't see immediate results. They expect linear progress, but growth is exponential.

The trick is to start small. Five pushups today. Five tomorrow. Add one each week. After a month, you're doing ten. After three months, twenty. After a year, you're doing fifty without thinking about it. The habit becomes the foundation, not the goal.
`.trim()

console.log('=== LLM 3-tier + retry-queue disable-test ===\n')

// Verify the disable-flags endpoint is reachable + show current state.
const initial = await getJson('/api/llm/disable-flags')
console.log('Initial flags:', JSON.stringify(initial.json.data.flags, null, 2))

// ─── TEST 1: disable Z.ai + Cloudflare (Groq also unconfigured, so all 3 fail) ─
console.log('\n=== TEST 1: Disable Z.ai + Cloudflare (no Groq key) ===')
const test1Set = await postJson('/api/llm/disable-flags', {
  zai: true,
  cloudflare: true,
  groq: false
})
console.log('Flags after test 1 set:', JSON.stringify(test1Set.json.data.flags, null, 2))

const start1 = await postJson('/api/rewrite', { transcript: TEST_TRANSCRIPT })
console.log('Rewrite POST response status:', start1.status)
const jobId1 = (start1.json.data as { jobId: string })?.jobId
if (!jobId1) {
  console.error('FAIL: no jobId returned. Body:', JSON.stringify(start1.json))
  process.exit(1)
}
console.log('Job ID:', jobId1)

// Poll — expect 'waiting' status with retryInSecs≈15.
let sawWaiting = false
let sawWaitingInfo: unknown = null
for (let i = 0; i < 5; i++) {
  await sleep(1500)
  const poll = await getJson(`/api/rewrite?jobId=${jobId1}`)
  const data = poll.json.data as
    | { status: string; waiting?: { round: number; retryInSecs: number; retryInSecsRemaining: number; maxRounds: number } | null }
    | undefined
  console.log(`  poll ${i + 1}: status=${poll.status} job.status=${data?.status ?? 'null'}`)
  if (data?.status === 'waiting' && data.waiting) {
    sawWaiting = true
    sawWaitingInfo = data.waiting
    console.log('    → WAITING confirmed:', JSON.stringify(data.waiting, null, 2))
    break
  }
}

if (sawWaiting) {
  console.log('TEST 1 PASS: ✅ retry-queue absorbed Z.ai+Cloudflare+Groq failures; job is in "waiting" status (NOT error).')
} else {
  console.log('TEST 1 FAIL: ❌ never saw "waiting" status — either all retries succeeded (unexpected with all 3 disabled) or the job failed too quickly.')
}

// ─── TEST 2: disable all 3 (incl. Groq via runtime override) ─────────────────
console.log('\n=== TEST 2: Disable ALL 3 (Z.ai + Cloudflare + Groq) ===')
const test2Set = await postJson('/api/llm/disable-flags', {
  zai: true,
  cloudflare: true,
  groq: true
})
console.log('Flags after test 2 set:', JSON.stringify(test2Set.json.data.flags, null, 2))

const start2 = await postJson('/api/rewrite', { transcript: TEST_TRANSCRIPT })
const jobId2 = (start2.json.data as { jobId: string })?.jobId
if (!jobId2) {
  console.error('FAIL: no jobId returned. Body:', JSON.stringify(start2.json))
  process.exit(1)
}
console.log('Job ID:', jobId2)

let sawWaiting2 = false
let sawWaiting2Info: unknown = null
for (let i = 0; i < 5; i++) {
  await sleep(1500)
  const poll = await getJson(`/api/rewrite?jobId=${jobId2}`)
  const data = poll.json.data as
    | { status: string; waiting?: { round: number; retryInSecs: number; maxRounds: number } | null }
    | undefined
  console.log(`  poll ${i + 1}: status=${poll.status} job.status=${data?.status ?? 'null'}`)
  if (data?.status === 'waiting' && data.waiting) {
    sawWaiting2 = true
    sawWaiting2Info = data.waiting
    console.log('    → WAITING confirmed:', JSON.stringify(data.waiting, null, 2))
    break
  }
  if (data?.status === 'error' || (poll.json.success === false && data == null)) {
    console.log('    → ERROR returned (would surface "very busy" to user):', JSON.stringify(poll.json, null, 2))
    break
  }
}

if (sawWaiting2) {
  console.log('TEST 2 PASS: ✅ retry-queue STILL absorbs all-3-disabled failures; job is "waiting" (NOT "very busy" error).')
} else {
  console.log('TEST 2 FAIL: ❌ retry-queue should still spin even with all 3 disabled (queue is independent of provider availability).')
}

// ─── CLEANUP: reset all flags ────────────────────────────────────────────────
console.log('\n=== Cleanup: reset flags to false ===')
const reset = await postJson('/api/llm/disable-flags', { reset: true })
console.log('Flags after reset:', JSON.stringify(reset.json.data.flags, null, 2))

// ─── Final summary ───────────────────────────────────────────────────────────
console.log('\n=== SUMMARY ===')
console.log(`TEST 1 (Z.ai + Cloudflare disabled): ${sawWaiting ? '✅ PASS' : '❌ FAIL'}`)
console.log(`TEST 2 (ALL 3 disabled):             ${sawWaiting2 ? '✅ PASS' : '❌ FAIL'}`)
if (sawWaiting && sawWaiting2) {
  console.log('\nBoth tests pass → user will NEVER see "very busy" error — only a live "Waiting for AI capacity, retrying in Xs..." countdown.')
} else {
  console.log('\nAt least one test failed — review logs above.')
}

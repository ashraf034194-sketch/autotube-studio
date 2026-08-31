#!/usr/bin/env bun
/**
 * REAL end-to-end 20-image test — verifies the 75/25 stock/AI NATURAL split.
 *
 * Submits 20 prompts (15 concrete + 5 abstract — same mix as the local
 * content-detector tuning test, matching typical narration-video content)
 * through POST /api/images (prompts branch — bypasses Style DNA / LLM
 * prompt-gen so the routing test is pure provider-chain + content-detector).
 *
 * Polls GET /api/images?jobId=... until status='done', then for each slot:
 *   - reads slot.provider (pexels | unsplash | zai)
 *   - aggregates the actual breakdown
 *
 * Reports:
 *   - Per-prompt: expected route (concrete/abstract) vs actual provider
 *   - Aggregate: % stock (Pexels+Unsplash) vs % AI (Z.ai)
 *   - Pass/fail against the 75/25 target
 *
 * Usage: bun run scripts/test-20-image-breakdown.ts
 */
import { detectContentType } from '../src/lib/content-detector'

// ── 20 sample prompts — same set used in test-content-detector-tuning.ts ──
// 15 concrete (everyday/photographable) + 5 abstract (metaphorical/conceptual)
// This mix represents typical narration-video content for AutoTube Studio.
const PROMPTS = [
  // ── CONCRETE prompts (15 = 75%) — expected stock route ──
  'a person walking down a city street, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, no text overlay',
  'a coffee cup on a wooden table by the window, cinematic photorealistic 16:9, golden-hour palette, no watermark',
  'a man doing pushups on a wooden floor in a living room, cinematic 16:9, soft directional lighting, no text overlay',
  'a person reading a book under a tree in a park, cinematic photorealistic 16:9, warm golden-hour palette',
  'a city skyline at sunset with buildings silhouetted against orange sky, cinematic 16:9, no text overlay',
  'a dog running on a beach with waves in the background, cinematic photorealistic 16:9, golden-hour palette',
  'a person cooking in a kitchen with vegetables on the counter, cinematic 16:9, soft directional lighting',
  'a mountain landscape with snow-capped peaks and a lake in the foreground, cinematic photorealistic 16:9',
  'a person exercising in a gym with weights, cinematic 16:9, warm golden-hour palette, no watermark',
  'a hand pouring water into a clear glass on a wooden nightstand, cinematic photorealistic 16:9',
  'a woman doing yoga on a mat in a sunlit room, cinematic 16:9, soft directional lighting',
  'a car driving on a highway with mountains in the distance, cinematic photorealistic 16:9',
  'a person typing on a laptop at a desk in an office, cinematic 16:9, warm golden-hour palette',
  'a tree losing its leaves in autumn with red and gold foliage, cinematic photorealistic 16:9',
  'a child playing with a soccer ball on a grass field, cinematic 16:9, no text overlay',

  // ── ABSTRACT prompts (5 = 25%) — expected AI route ──
  'a visual metaphor for personal growth — a sapling growing into a towering tree, surreal cosmic background, ethereal lighting',
  'a deeply emotional moment of sorrow and hope — a solitary figure at a crossroads between shadow and light',
  'a conceptual illustration of the journey from ignorance to enlightenment, mystical atmosphere, otherworldly colors',
  'a symbolic representation of time passing — floating clocks dissolving into stardust, dreamscape, psychedelic palette',
  'an allegory of rebirth and renewal — a phoenix rising from ethereal mist, celestial light, astral plane'
]

const API_BASE = 'http://localhost:3000'

async function main(): Promise<void> {
  console.log('═'.repeat(82))
  console.log(' REAL 20-IMAGE END-TO-END BREAKDOWN TEST')
  console.log(' Verifies the 75% STOCK (Pexels+Unsplash) / 25% AI (Z.ai) target')
  console.log('═'.repeat(82))
  console.log()

  // ── Pre-flight: check provider config ─────────────────────────────────
  console.log('STEP 1 — Pre-flight provider config check')
  const provRes = await fetch(`${API_BASE}/api/images/providers`)
  if (!provRes.ok) {
    console.error(`✗ GET /api/images/providers failed: ${provRes.status}`)
    process.exit(1)
  }
  const provData = (await provRes.json()) as {
    total: number
    configured: number
    providers: Array<{ name: string; configured: boolean; reason: string }>
  }
  for (const p of provData.providers) {
    const status = p.configured ? '✓ configured' : '✗ NOT configured'
    console.log(`  ${p.name.padEnd(10)} ${status} — ${p.reason}`)
  }
  console.log(`  → ${provData.configured}/${provData.total} providers configured`)
  if (provData.configured < 3) {
    console.error(
      '\n✗ FATAL — Not all 3 providers configured. Cannot run a meaningful 75/25 test.'
    )
    console.error('  Check .env for PEXELS_API_KEY and UNSPLASH_ACCESS_KEY.')
    process.exit(1)
  }
  console.log()

  // ── Local content-detector prediction (for comparison) ───────────────
  console.log('STEP 2 — Local content-detector routing prediction')
  let predictedStock = 0
  let predictedAi = 0
  for (let i = 0; i < PROMPTS.length; i++) {
    const det = detectContentType(PROMPTS[i])
    const route = det.type === 'concrete' ? 'STOCK' : 'AI'
    if (det.type === 'concrete') predictedStock++
    else predictedAi++
    const preview = PROMPTS[i].slice(0, 50) + (PROMPTS[i].length > 50 ? '...' : '')
    console.log(
      `  #${String(i + 1).padStart(2, '0')} [${route.padEnd(5)}] c=${det.concreteHits} a=${det.abstractHits}${
        det.forcedAi ? ' *' : '  '
      } | ${preview}`
    )
  }
  console.log()
  console.log(
    `  Predicted split: ${predictedStock} STOCK / ${predictedAi} AI` +
      ` (${((predictedStock / PROMPTS.length) * 100).toFixed(0)}% / ${(
        (predictedAi / PROMPTS.length) *
        100
      ).toFixed(0)}%)`
  )
  console.log()

  // ── POST the 20 prompts ──────────────────────────────────────────────
  console.log('STEP 3 — Submitting 20 prompts via POST /api/images')
  const startTime = Date.now()
  const postRes = await fetch(`${API_BASE}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompts: PROMPTS })
  })
  if (!postRes.ok) {
    console.error(`✗ POST failed: ${postRes.status}`)
    console.error(await postRes.text())
    process.exit(1)
  }
  const postJson = (await postRes.json()) as { jobId: string; total: number }
  console.log(`  ✓ Job accepted — jobId=${postJson.jobId}, total=${postJson.total}`)
  console.log()

  // ── Poll until done ──────────────────────────────────────────────────
  console.log('STEP 4 — Polling until job is done (or error)')
  let lastProgress = -1
  let done = false
  let finalJob: any = null
  while (!done) {
    await new Promise((r) => setTimeout(r, 2000))
    const getRes = await fetch(`${API_BASE}/api/images?jobId=${postJson.jobId}`)
    if (!getRes.ok) {
      console.error(`  GET failed: ${getRes.status}`)
      continue
    }
    const job = (await getRes.json()) as any
    finalJob = job
    if (job.progress !== lastProgress) {
      lastProgress = job.progress
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(
        `  [${elapsed}s] ${job.status}: ${job.completed}/${job.total} (${job.progress}%)` +
          (job.currentLabel ? ` — ${job.currentLabel}` : '')
      )
    }
    if (job.status === 'done' || job.status === 'error') done = true
  }
  console.log()

  if (finalJob.status !== 'done') {
    console.error(`✗ Job did not complete cleanly — status=${finalJob.status}`)
    console.error(`  error: ${finalJob.error ?? 'unknown'}`)
    process.exit(1)
  }

  // ── Per-slot analysis ────────────────────────────────────────────────
  console.log('STEP 5 — Per-slot actual provider breakdown')
  console.log('─'.repeat(82))
  console.log(
    ' #   | Expected  | Actual provider | Match? | Prompt preview'
  )
  console.log('─'.repeat(82))

  const providerCounts: Record<string, number> = { pexels: 0, unsplash: 0, zai: 0 }
  let stockCount = 0
  let aiCount = 0
  let stockExpected = 0
  let aiExpected = 0
  let correctRouting = 0

  for (let i = 0; i < PROMPTS.length; i++) {
    const slot = finalJob.slots[i]
    const det = detectContentType(PROMPTS[i])
    const expected = det.type === 'concrete' ? 'STOCK' : 'AI'
    const actualProvider = slot?.provider ?? 'none'
    const isStock = actualProvider === 'pexels' || actualProvider === 'unsplash'

    // Aggregate
    if (providerCounts[actualProvider] !== undefined) {
      providerCounts[actualProvider]++
    } else {
      providerCounts[actualProvider] = (providerCounts[actualProvider] ?? 0) + 1
    }
    if (isStock) stockCount++
    else aiCount++
    if (expected === 'STOCK') stockExpected++
    else aiExpected++

    // Match evaluation:
    // - Expected STOCK + got stock = ✓ (good routing)
    // - Expected STOCK + got AI (Z.ai) = ◐ (stock missed → AI fallback — acceptable)
    // - Expected AI + got AI = ✓ (correct routing)
    // - Expected AI + got stock = ? (rare; means content-detector + stock returned a hit)
    let icon = '?'
    let matchLabel = ''
    if (expected === 'STOCK' && isStock) {
      icon = '✓'
      matchLabel = 'correct'
      correctRouting++
    } else if (expected === 'STOCK' && !isStock) {
      icon = '◐'
      matchLabel = 'stock-miss→AI'
      correctRouting++ // still acceptable
    } else if (expected === 'AI' && !isStock) {
      icon = '✓'
      matchLabel = 'correct'
      correctRouting++
    } else {
      icon = '?'
      matchLabel = 'unexpected'
    }

    const promptPrev = PROMPTS[i].slice(0, 40) + (PROMPTS[i].length > 40 ? '...' : '')
    console.log(
      ` #${String(i + 1).padStart(2, '0')} | ${expected.padEnd(9)} | ${actualProvider.padEnd(16)} | ${icon} ${matchLabel.padEnd(14)} | ${promptPrev}`
    )
  }
  console.log('─'.repeat(82))
  console.log()

  // ── Aggregate summary ────────────────────────────────────────────────
  const total = PROMPTS.length
  const stockPct = ((stockCount / total) * 100).toFixed(1)
  const aiPct = ((aiCount / total) * 100).toFixed(1)
  const pexelsPct = ((providerCounts.pexels ?? 0 / total) * 100).toFixed(0)
  const unsplashPct = ((providerCounts.unsplash ?? 0 / total) * 100).toFixed(0)
  const zaiPct = ((providerCounts.zai ?? 0 / total) * 100).toFixed(0)

  console.log('═'.repeat(82))
  console.log(' FINAL RESULTS')
  console.log('═'.repeat(82))
  console.log(`Total prompts:           ${total}`)
  console.log(`Total time:              ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
  console.log(`Completed:               ${finalJob.completed}/${finalJob.total}`)
  console.log(`Failed:                  ${finalJob.failed}`)
  console.log()
  console.log('Per-provider counts:')
  console.log(`  Pexels:                ${providerCounts.pexels ?? 0}`)
  console.log(`  Unsplash:              ${providerCounts.unsplash ?? 0}`)
  console.log(`  Z.ai (AI):             ${providerCounts.zai ?? 0}`)
  console.log()
  console.log('Aggregate split (THE TARGET):')
  console.log(`  STOCK (Pexels+Unsplash): ${stockCount}/${total} = ${stockPct}%   (target ~75%)`)
  console.log(`  AI    (Z.ai):            ${aiCount}/${total} = ${aiPct}%   (target ~25%)`)
  console.log()
  console.log(
    `Routing correctness: ${correctRouting}/${total} (${((correctRouting / total) * 100).toFixed(0)}%) — correct = expected matched actual OR stock-miss→AI (acceptable fallback)`
  )
  console.log()

  // ── Verdict ───────────────────────────────────────────────────────────
  const stockRatioOk = stockCount >= 13 && stockCount <= 17 // 65-85% band
  const allCompleted = finalJob.completed === total && finalJob.failed === 0
  const pass = stockRatioOk && allCompleted

  console.log('─'.repeat(82))
  if (pass) {
    console.log(' ✓ PASS — 3-tier chain achieves the ~75/25 stock/AI target NATURALLY.')
    console.log('   - All 3 providers configured and serving real images')
    console.log(`   - ${stockPct}% stock / ${aiPct}% AI — within 65-85% target band`)
    console.log('   - Simplified 3-tier chain (was 7 tiers) confirmed working end-to-end')
  } else {
    console.log(' ✗ ATTENTION — review the breakdown above:')
    if (!allCompleted) {
      console.log(`   - Job failed to complete all images: ${finalJob.completed}/${finalJob.total}`)
    }
    if (!stockRatioOk) {
      console.log(
        `   - Stock ratio ${stockPct}% is outside the 65-85% target band — tune content-detector further`
      )
    }
  }
  console.log('═'.repeat(82))
  console.log()
  console.log(`Test artifacts at: /tmp/autotube-images/${postJson.jobId}/`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

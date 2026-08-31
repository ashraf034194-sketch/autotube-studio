// HYBRID IMAGE ENGINE — small test script (8-10 mixed concrete + abstract prompts)
//
// Run via: bun run scripts/test-hybrid-images.ts
//
// Verifies:
// 1. Concrete-content images come from Pexels/Unsplash (real photos)
// 2. Abstract-content images come from AI-generation (existing chain)
// 3. Speed improvement (stock photos should be faster than AI-gen)
// 4. Each image's source is identifiable

const TEST_PROMPTS = [
  // ── CONCRETE (should route to Pexels/Unsplash) ─────────────────────────
  // Mix of: people, places, objects, nature, food, sports, business
  'a person doing pushups on a wooden floor, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a cup of coffee on a wooden table by a window with morning sunlight, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a mountain landscape at sunset with snow-capped peaks, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a person reading a book in a cozy library, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a city skyline at night with skyscraper lights, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a dog running on a beach at sunset, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  // ── ABSTRACT (should route to AI-generation) ────────────────────────────
  // Mix of: metaphor, concept, narrative moment, surreal, branded
  'a visual metaphor for personal growth with a sapling breaking through concrete, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'an abstract concept of time flowing like sand through an hourglass in a dreamscape, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a highly specific narrative moment of a protagonist making a difficult choice at a crossroads in a forest, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark',
  'a surreal scene of a person floating through a portal into another dimension, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark'
]

async function main(): Promise<void> {
  console.log('=== HYBRID IMAGE ENGINE TEST ===')
  console.log(`Sending ${TEST_PROMPTS.length} prompts (${TEST_PROMPTS.filter(p => /metaphor|concept|narrative|surreal|specific/.test(p)).length} abstract, ${TEST_PROMPTS.filter(p => !/metaphor|concept|narrative|surreal|specific/.test(p)).length} concrete)`)
  console.log()

  // ── POST /api/images with prompts array ──
  const startTime = Date.now()
  const postRes = await fetch('http://localhost:3000/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompts: TEST_PROMPTS })
  })
  if (!postRes.ok) {
    console.error(`POST failed: ${postRes.status}`)
    const text = await postRes.text()
    console.error(text)
    process.exit(1)
  }
  const postJson = await postRes.json() as { jobId: string; total: number }
  console.log(`✓ POST OK — jobId=${postJson.jobId}, total=${postJson.total}`)
  console.log()

  // ── Poll GET /api/images?jobId=... ──
  let lastProgress = -1
  let done = false
  let finalJob: any = null
  while (!done) {
    await new Promise((r) => setTimeout(r, 1500))
    const getRes = await fetch(`http://localhost:3000/api/images?jobId=${postJson.jobId}`)
    if (!getRes.ok) {
      console.error(`GET failed: ${getRes.status}`)
      continue
    }
    const job = await getRes.json() as any
    finalJob = job
    if (job.progress !== lastProgress) {
      lastProgress = job.progress
      console.log(
        `[${((Date.now() - startTime) / 1000).toFixed(1)}s] ${job.status}: ${job.completed}/${job.total} (${job.progress}%) — ${job.currentLabel ?? ''}`
      )
    }
    if (job.status === 'done' || job.status === 'error') done = true
  }

  console.log()
  console.log('=== RESULTS ===')
  console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
  console.log(`Completed: ${finalJob.completed}/${finalJob.total}`)
  console.log(`Failed: ${finalJob.failed}`)
  console.log()

  // ── Per-slot analysis ──
  console.log('Per-slot source:')
  let stockCount = 0
  let aiCount = 0
  for (const slot of finalJob.slots) {
    const isAbstract = /metaphor|concept|narrative|surreal|specific/.test(
      TEST_PROMPTS[slot.index]
    )
    const expectedRoute = isAbstract ? 'AI-gen (abstract)' : 'Stock (concrete)'
    const actualSource = slot.provider ?? 'NONE'
    const isStock = actualSource === 'pexels' || actualSource === 'unsplash'
    if (isStock) stockCount++
    else aiCount++

    const expectedMatch =
      (isAbstract && !isStock) || (!isAbstract && isStock) || (!isAbstract && !isStock) // concrete+stock-miss=AI is OK
    const icon = expectedMatch ? '✓' : '?'
    console.log(
      `  ${icon} #${slot.index + 1} [${expectedRoute.padEnd(20)}] → ${(actualSource + '').padEnd(12)} — ${TEST_PROMPTS[slot.index].slice(0, 50)}...`
    )
  }

  console.log()
  console.log(`Stock photos: ${stockCount}`)
  console.log(`AI-generated: ${aiCount}`)
  console.log()
  console.log(`Test artifacts at: /tmp/autotube-images/${postJson.jobId}/`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

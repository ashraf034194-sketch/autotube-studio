#!/usr/bin/env bun
/**
 * Test the content-detector tuning — verifies the 75/25 stock/AI bias.
 *
 * Runs detectContentType on 20 sample prompts (mix of concrete + abstract)
 * and reports:
 *   - Per-prompt routing decision (concrete=stock, abstract=AI)
 *   - Aggregate count: X concrete / Y abstract
 *   - Actual ratio vs the 75/25 target
 *
 * Usage: bun run scripts/test-content-detector-tuning.ts
 */
import { detectContentType, buildStockQuery } from '../src/lib/content-detector'

// 20 sample prompts — mix of CONCRETE (everyday, photographable) + ABSTRACT
// (metaphorical, conceptual, surreal). The mix reflects typical narration
// video content (Phase 6 of AutoTube Studio).
const SAMPLE_PROMPTS = [
  // ── CONCRETE prompts (should route to STOCK — Pexels/Unsplash) ──
  // 15 of 20 = 75% target
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

  // ── ABSTRACT prompts (should route to AI — Z.ai) ──
  // 5 of 20 = 25% target
  'a visual metaphor for personal growth — a sapling growing into a towering tree, surreal cosmic background, ethereal lighting',
  'a deeply emotional moment of sorrow and hope — a solitary figure at a crossroads between shadow and light',
  'a conceptual illustration of the journey from ignorance to enlightenment, mystical atmosphere, otherworldly colors',
  'a symbolic representation of time passing — floating clocks dissolving into stardust, dreamscape, psychedelic palette',
  'an allegory of rebirth and renewal — a phoenix rising from ethereal mist, celestial light, astral plane'
]

console.log('═'.repeat(80))
console.log('CONTENT-DETECTOR TUNING TEST — 75/25 STOCK/AI BIAS VERIFICATION')
console.log('═'.repeat(80))
console.log()
console.log('Target: ~75% concrete (stock route — Pexels/Unsplash)')
console.log('Target: ~25% abstract (AI route — Z.ai)')
console.log()
console.log('─'.repeat(80))

let concreteCount = 0
let abstractCount = 0

SAMPLE_PROMPTS.forEach((prompt, i) => {
  const detection = detectContentType(prompt)
  const query = buildStockQuery(prompt)
  const route = detection.type === 'concrete' ? 'STOCK' : 'AI'
  if (detection.type === 'concrete') concreteCount++
  else abstractCount++

  const promptPreview = prompt.slice(0, 65) + (prompt.length > 65 ? '...' : '')
  console.log(
    `#${String(i + 1).padStart(2, '0')} [${route.padEnd(5)}] ` +
      `c=${detection.concreteHits} a=${detection.abstractHits}${detection.forcedAi ? ' *' : '  '} ` +
      `q="${query.slice(0, 30).padEnd(30)}" | ${promptPreview}`
  )
})

console.log('─'.repeat(80))
console.log()
console.log('SUMMARY')
console.log('─'.repeat(80))
console.log(`Total prompts:        ${SAMPLE_PROMPTS.length}`)
console.log(`Routed to STOCK:      ${concreteCount}  (target ~15 = 75%)`)
console.log(`Routed to AI (Z.ai):  ${abstractCount}  (target ~5  = 25%)`)
console.log()
const stockPct = ((concreteCount / SAMPLE_PROMPTS.length) * 100).toFixed(1)
const aiPct = ((abstractCount / SAMPLE_PROMPTS.length) * 100).toFixed(1)
console.log(`Stock split:          ${stockPct}% (target 75%)`)
console.log(`AI split:             ${aiPct}%  (target 25%)`)
console.log()

const meetsTarget = concreteCount >= 14 && concreteCount <= 16
console.log(
  meetsTarget
    ? '✓ PASS — content-detector tuning achieves the 75/25 stock/AI target.'
    : '✗ ADJUST — count is outside the 14-16 range; tune thresholds further.'
)
console.log('═'.repeat(80))

import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'
import path from 'path'
import {
  searchStockPhoto,
  isAnyStockConfigured,
  getStockProviderStatuses
} from './stock-photos'
import { detectContentType, buildStockQuery, type ContentType } from './content-detector'

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Provider name — SIMPLIFIED 3-tier chain.
 *
 *   • pexels    — Stock photo library (Tier 0, ~75% of images expected here)
 *   • unsplash  — Stock photo library (Tier 0, shares load with Pexels)
 *   • zai       — AI-generation (Tier 1, fallback for abstract + stock misses)
 *
 * Previously this file had 11 providers (Stability, HuggingFace, Cloudflare,
 * Pollinations, Google, Manus/Custom, nanoBanana2, grok + the 3 above). The
 * 2025-09 simplification removed all of them — most were permanently "skip"
 * because their keys were never configured, and they just added visual noise
 * to the provider-chain card. Z.ai (bundled SDK, always available) is the
 * only AI-generation fallback the system actually needs.
 */
export type ProviderName = 'pexels' | 'unsplash' | 'zai'

export interface ProviderOutcome {
  ok: true
  provider: ProviderName
  /** File path the image was saved to (absolute). */
  outPath: string
  /** Optional diagnostic info (model used, attempts, qualityTier, etc.) */
  meta?: Record<string, string | number | boolean>
}

export interface ProviderFailure {
  ok: false
  provider: ProviderName
  error: string
}

export interface ProviderStatus {
  name: ProviderName
  label: string
  configured: boolean
  /** Why the provider is/ isn't available (for transparency in the UI). */
  reason: string
}

/** A single provider attempt in the fallback trail. */
export interface TrailEntry {
  provider: ProviderName
  ok: boolean
  error?: string
}

// ─── Configuration (env-driven) ──────────────────────────────────────────────

/**
 * Z.ai (bundled SDK). The ONLY AI-generation provider in the simplified chain.
 * Always available unless explicitly disabled via env (ZAI_IMAGE_DISABLED=true).
 *
 * Used as the final fallback when:
 *   - The content-type detector routes to AI (abstract / metaphorical prompts)
 *   - Both Pexels + Unsplash miss (no stock photo for the query)
 *   - The stock route is disabled via env (HYBRID_IMAGES_ENABLED=false)
 */
export const ZAI_DISABLED = process.env.ZAI_IMAGE_DISABLED === 'true'

// ─── Target image size ───────────────────────────────────────────────────────

/** 16:9 cinematic frame. Z.ai honors explicit width/height. */
export const IMAGE_WIDTH = 1344
export const IMAGE_HEIGHT = 768

// ─── Provider interface ─────────────────────────────────────────────────────

interface Provider {
  name: ProviderName
  label: string
  configured: boolean
  reason: string
  generate(prompt: string, outPath: string): Promise<ProviderOutcome | ProviderFailure>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeImageBuffer(buf: Buffer, outPath: string, source: string): void {
  const dir = path.dirname(outPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(outPath, buf)
  if (process.env.DEBUG_IMAGE_PROVIDERS === 'true') {
    console.log(`[images] Wrote ${buf.length} bytes from ${source} to ${outPath}`)
  }
}

// ─── Z.ai cooldown (rate-limit back-pressure) ────────────────────────────────
//
// When Z.ai returns 429 (rate-limited), retries waste ~10s per image (3
// attempts with backoff). For a 32-image batch, this can total 5+ minutes
// of wasted time. Setting a 2-minute cooldown when 429 occurs means
// subsequent images skip Z.ai retries entirely and the retry-queue handles
// the wait + retry pattern at the chain level (Pexels → Unsplash → Z.ai →
// retry-queue wait → re-attempt full chain).
//
// The cooldown duration is shorter than the per-image back-off because Z.ai
// rate limits typically clear within minutes.

let zaiCooldownUntil = 0
let zaiCooldownReason = ''

/** Set the Z.ai cooldown. durationMs clamped to a 5-minute ceiling. */
export function setZaiCooldown(durationMs: number, reason: string): void {
  const clamped = Math.min(Math.max(durationMs, 0), 5 * 60_000)
  const until = Date.now() + clamped
  if (until > zaiCooldownUntil) {
    zaiCooldownUntil = until
    zaiCooldownReason = reason
    console.warn(
      `[images] Z.ai cooldown set for ${(clamped / 1000).toFixed(0)}s — ${reason.slice(0, 100)}`
    )
  }
}

/** Returns true if Z.ai is currently in cooldown (should be skipped). */
export function isZaiInCooldown(): boolean {
  return Date.now() < zaiCooldownUntil
}

/** Returns the Z.ai cooldown reason or empty string if not in cooldown. */
export function getZaiCooldownReason(): string {
  return isZaiInCooldown() ? zaiCooldownReason : ''
}

// ─── Tier 1: Z.ai (bundled SDK) — the only AI-generation provider ─────────────

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>
let zaiSingleton: ZaiClient | null = null
async function getZai(): Promise<ZaiClient> {
  if (!zaiSingleton) zaiSingleton = await ZAI.create()
  return zaiSingleton
}

async function generateWithZai(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  if (ZAI_DISABLED) return { ok: false, provider: 'zai', error: 'disabled via env' }
  // Cooldown short-circuit: if a prior 429 put Z.ai in cooldown, skip the
  // retries entirely — let the retry-queue handle the wait + re-attempt
  // pattern at the chain level.
  if (isZaiInCooldown()) {
    return {
      ok: false,
      provider: 'zai',
      error: `Z.ai in cooldown — ${getZaiCooldownReason().slice(0, 100)}`
    }
  }
  const MAX_ATTEMPTS = 3
  let lastError = ''
  let hitRateLimit = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const zai = await getZai()
      const res = await zai.images.generations.create({
        prompt,
        size: `${IMAGE_WIDTH}x${IMAGE_HEIGHT}` as never
      })
      const b64 = res?.data?.[0]?.base64
      if (!b64) throw new Error('No image data in Z.ai response.')
      const buf = Buffer.from(b64, 'base64')
      if (buf.length < 1000) throw new Error(`Z.ai buffer too small (${buf.length} bytes).`)
      writeImageBuffer(buf, outPath, 'zai')
      return { ok: true, provider: 'zai', outPath, meta: { bytes: buf.length, attempt } }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      const rateLimited = lastError.includes('429') || /too many requests/i.test(lastError)
      if (rateLimited) hitRateLimit = true
      console.error(`[images] Z.ai attempt ${attempt}/${MAX_ATTEMPTS} failed${rateLimited ? ' (rate-limited)' : ''}: ${lastError.slice(0, 120)}`)
      if (attempt < MAX_ATTEMPTS) {
        const backoff = rateLimited ? 3000 * attempt : 1500 * attempt
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }
  // If the failures were due to rate-limiting, set a 2-minute cooldown so
  // subsequent images in this batch (and concurrent jobs) skip Z.ai retries
  // entirely. The retry-queue will still re-attempt the full chain after
  // its own back-off, so Z.ai will be retried naturally once the cooldown
  // clears.
  if (hitRateLimit) {
    setZaiCooldown(2 * 60_000, `rate-limited (429) — Z.ai quota exceeded, skipping retries for batch`)
  }
  return { ok: false, provider: 'zai', error: lastError || 'Z.ai failed after retries.' }
}

const zaiProvider: Provider = {
  name: 'zai',
  label: 'Z.ai (AI image generation)',
  configured: !ZAI_DISABLED,
  reason: ZAI_DISABLED ? 'disabled via env' : 'always available (bundled SDK) · AI-generation fallback',
  generate: generateWithZai
}

// ─── The provider chain ──────────────────────────────────────────────────────
//
// SIMPLIFIED 3-TIER CHAIN (2025-09 refactor):
//
//   Tier 0 (stock, concrete content):  Pexels → Unsplash
//   Tier 1 (AI-generation, fallback):  Z.ai
//
// LOAD DISTRIBUTION TARGET (~75/25):
//   • ~75% of images should come from Pexels + Unsplash (stock photos — fast,
//     free, commercial-use-licensed, ~0.3s per image)
//   • ~25% from Z.ai (AI-generation — for abstract / metaphorical content
//     that has no literal stock photo match)
//
// This 75/25 split is achieved NATURALLY by the content-detector: it routes
// generic, photographable subjects (person walking, coffee cup, city street,
// person exercising) to the stock route, and only genuinely abstract /
// metaphorical / unique-narrative prompts to AI-generation. The threshold
// was tuned in content-detector.ts to bias borderline cases toward stock
// (the safer, cheaper bet — Pexels/Unsplash usually have SOMETHING for any
// common noun).
//
// REMOVED providers (kept out of the chain for simplicity — they were all
// permanently "skip" because their keys were never configured):
//   ❌ Stability AI     — paid API, user opted out
//   ❌ HuggingFace      — paid API, user opted out
//   ❌ Cloudflare       — paid API, user opted out
//   ❌ Pollinations     — free but unreliable (frequent timeouts)
//   ❌ Google / Nano Banana — paid API, never configured
//   ❌ Manus (Custom)   — external service, removed from chain
//   ❌ nanoBanana2      — composite of removed engines
//   ❌ GROK             — paid API, user opted out
//
const CHAIN: Provider[] = [zaiProvider]

/**
 * HYBRID IMAGE ENGINE — Stock Photo Route (Tier 0, before the AI chain).
 *
 * For CONCRETE content (person reading a book, city skyline, cup of coffee,
 * mountain landscape, person exercising), this tries LEGAL STOCK PHOTOS
 * first (Pexels → Unsplash). Both are genuinely free + commercial-use-
 * licensed. This is the path that ~75% of images take.
 *
 * For ABSTRACT content (visual metaphor for growth, specific branded scene,
 * highly specific narrative moment), this returns ok:false immediately so
 * the caller falls through to Z.ai. This is the path that ~25% of images
 * take.
 *
 * Returns the same shape as a ProviderOutcome/ProviderFailure so it slots
 * into the existing trail-based fallback chain transparently.
 *
 * The route is automatically bypassed when:
 *   - HYBRID_IMAGES_ENABLED=false (master toggle in .env)
 *   - STOCK_PHOTOS_DISABLED=true
 *   - No stock API keys are configured (PEXELS_API_KEY + UNSPLASH_ACCESS_KEY)
 *   - The prompt's content-type is detected as abstract
 */
async function tryStockRoute(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure | null> {
  // Master toggle + provider configuration gates.
  if (process.env.HYBRID_IMAGES_ENABLED === 'false' || process.env.STOCK_PHOTOS_DISABLED === 'true') {
    return null
  }
  if (!isAnyStockConfigured()) return null

  // Detect content-type (concrete vs abstract). Cheap heuristic, ~1ms.
  // The detector has been tuned to bias toward "concrete" for borderline
  // cases so that ~75% of typical narration content routes to stock photos.
  const detection = detectContentType(prompt)
  if (detection.type === 'abstract') {
    if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
      console.log(
        `[stock] Routing to AI-gen (abstract: hits=${detection.abstractHits} concrete=${detection.concreteHits} forced=${detection.forcedAi}) — prompt: ${prompt.slice(0, 80)}`
      )
    }
    return null // caller falls through to Z.ai
  }

  // Build a 2-4 keyword search phrase from the prompt (strip Style DNA wrapping).
  const query = buildStockQuery(prompt)
  if (!query || query.length < 3) return null // nothing searchable — let Z.ai try

  if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
    console.log(
      `[stock] Routing to Stock (concrete: hits=${detection.concreteHits}) — query: "${query}" (from prompt: ${prompt.slice(0, 80)})`
    )
  }

  try {
    const result = await searchStockPhoto(query, outPath)
    if (result.ok && result.source && result.outPath) {
      const provider: ProviderName = result.source // 'pexels' | 'unsplash'
      return {
        ok: true,
        provider,
        outPath: result.outPath,
        meta: {
          source: result.source,
          query: result.query ?? query,
          photographer: result.photographer ?? '',
          photoUrl: result.photoUrl ?? '',
          stockWidth: result.width ?? 0,
          stockHeight: result.height ?? 0,
          contentType: 'concrete' as ContentType,
          concreteHits: detection.concreteHits
        }
      }
    }
    // Both stock sources missed → return null so Z.ai runs as fallback.
    if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
      console.log(
        `[stock] Both Pexels + Unsplash missed for "${query}" → falling through to Z.ai`
      )
    }
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[stock] Stock route errored for "${query.slice(0, 40)}" → Z.ai will try. Error: ${msg.slice(0, 100)}`
    )
    return null
  }
}

/**
 * Try each provider in order. Returns the first success, OR the last failure.
 * Also reports which providers were tried (for telemetry / trail display).
 *
 * HYBRID ENGINE: this starts with the Stock Photo Route (Pexels → Unsplash)
 * for CONCRETE content before falling through to Z.ai. For ABSTRACT content,
 * the stock route is bypassed entirely.
 *
 * NOTE: This function returns failure if ALL tiers fail in one round. For
 * the "never permanently fail" behavior, use `generateImageWithRetryQueue`
 * which wraps this in an exponential-backoff retry loop.
 */
export async function generateImageWithFallback(
  prompt: string,
  outPath: string
): Promise<{ outcome: ProviderOutcome | ProviderFailure; trail: TrailEntry[] }> {
  const trail: TrailEntry[] = []

  // ── Tier 0: HYBRID Stock Photo Route (Pexels → Unsplash) ──
  // For concrete content, try legal stock photos first. If both stock sources
  // miss or the content is abstract, this returns null and we fall through to
  // Z.ai (the only AI-generation provider).
  const stockResult = await tryStockRoute(prompt, outPath)
  if (stockResult && stockResult.ok) {
    const outcome = stockResult as ProviderOutcome
    trail.push({ provider: outcome.provider, ok: true })
    if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
      console.log(
        `[stock] ✓ ${outcome.provider} hit — saved to ${outcome.outPath} (${outcome.meta?.query ?? ''})`
      )
    }
    return { outcome, trail }
  }
  // If stock route returned a non-null failure (shouldn't happen — it returns
  // null on failure), record it in the trail.
  if (stockResult && !stockResult.ok) {
    const failure = stockResult as ProviderFailure
    trail.push({ provider: failure.provider, ok: false, error: failure.error })
  }

  // ── Tier 1: Z.ai (AI-generation, the only fallback) ──
  for (const provider of CHAIN) {
    if (!provider.configured) {
      trail.push({ provider: provider.name, ok: false, error: 'not configured' })
      continue
    }
    const result = await provider.generate(prompt, outPath)
    if (result.ok) {
      trail.push({ provider: provider.name, ok: true })
      return { outcome: result, trail }
    }
    trail.push({ provider: provider.name, ok: false, error: result.error })
    console.error(`[images] Provider "${provider.name}" failed → next tier: ${result.error.slice(0, 120)}`)
  }

  // ── LAST-RESORT STOCK FALLBACK (for abstract content where Z.ai failed) ──
  // If we got here, the content was originally routed to AI (either because
  // it was abstract OR the original stock route missed) AND Z.ai also failed.
  // Before giving up + entering the retry-queue, try stock photos ONE MORE
  // TIME with a forced concrete-query extraction — even abstract prompts
  // usually contain a concrete noun we can search for. This is the
  // difference between "stuck job" and "job completes with a less-perfect
  // but real photo". (e.g., "transformation of a landscape" → "landscape scene"
  // → real landscape photo via Pexels.)
  if (isAnyStockConfigured()) {
    const fallbackQuery = buildStockQuery(prompt) // ignores abstract routing — pure keyword extract
    if (fallbackQuery && fallbackQuery.length >= 3) {
      if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
        console.log(
          `[stock] LAST-RESORT fallback after Z.ai exhausted — trying stock with relaxed query: "${fallbackQuery}"`
        )
      }
      try {
        const result = await searchStockPhoto(fallbackQuery, outPath)
        if (result.ok && result.source && result.outPath) {
          const provider: ProviderName = result.source
          trail.push({ provider, ok: true })
          if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
            console.log(
              `[stock] ✓ LAST-RESORT ${provider} hit — saved to ${result.outPath} (query: ${fallbackQuery})`
            )
          }
          return {
            outcome: {
              ok: true,
              provider,
              outPath: result.outPath,
              meta: {
                source: result.source,
                query: fallbackQuery,
                photographer: result.photographer ?? '',
                photoUrl: result.photoUrl ?? '',
                stockWidth: result.width ?? 0,
                stockHeight: result.height ?? 0,
                fallbackRoute: true,
                contentType: 'abstract-fallback-to-stock' as ContentType
              }
            },
            trail
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[stock] LAST-RESORT fallback errored for "${fallbackQuery.slice(0, 40)}": ${msg.slice(0, 100)}`
        )
      }
    }
  }

  const lastFailure = trail.length
    ? trail[trail.length - 1]
    : { provider: 'zai' as ProviderName, ok: false, error: 'no providers configured' }
  return {
    outcome: { ok: false, provider: lastFailure.provider, error: lastFailure.error || 'all providers failed' },
    trail
  }
}

// ─── Smart Retry-Queue (never permanently fail) ──────────────────────────────

export interface RetryQueueProgress {
  retryCount: number
  waitMs: number
  nextRetryAt: number
  lastTrail: TrailEntry[]
}

export interface RetryQueueOptions {
  /** Called when entering a wait (all tiers failed this round). */
  onWait?: (info: RetryQueueProgress) => void
  /** Called just before retrying the full chain. */
  onRetry?: (info: { retryCount: number }) => void
  /** Optional abort signal to cancel the retry loop. */
  signal?: AbortSignal
}

/**
 * Exponential backoff schedule for the retry-queue.
 * Round 1 failure → wait 30s, Round 2 → 60s, Round 3 → 2min, Round 4+ → 5min (capped).
 */
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]

/**
 * CIRCUIT BREAKER — max retry rounds before the queue gives up permanently.
 *
 * Without this, a job whose AI providers are ALL permanently down (e.g. Z.ai
 * daily quota exhausted + no stock keys configured) would spin forever in
 * 5-min wait loops, presenting to the user as a permanent "waiting" state
 * with no path forward.
 *
 * 8 rounds × ~5min each (capped) = ~40min total. That's plenty of time for:
 *   - Z.ai's hourly rate-limit window to reset (60min) — partially overlaps.
 *   - The user to notice and decide to abort.
 *
 * After MAX_RETRY_ROUNDS, the queue throws a clear "all providers exhausted"
 * error so the slot is marked as 'error' (not 'waiting' forever) and the job
 * can complete with a clear "X images failed" status instead of hanging.
 *
 * The number is env-overridable for users who want longer patience.
 */
const MAX_RETRY_ROUNDS = (() => {
  const parsed = parseInt(process.env.IMAGE_MAX_RETRY_ROUNDS || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8
})()

/**
 * SMART RETRY-QUEUE — the heart of the "never permanently fail" guarantee.
 *
 * If ALL tiers fail for an image in a single round (Pexels + Unsplash + Z.ai
 * all failed), this function does NOT give up immediately. It puts the image
 * in a "waiting queue", waits 30s, then retries the FULL chain. If that
 * fails too, the wait grows: 60s → 2min → 5min (capped). The loop continues
 * until EITHER the image succeeds OR MAX_RETRY_ROUNDS is reached (circuit
 * breaker — see above).
 *
 * Progress is reported via the onWait / onRetry callbacks so the job worker
 * can show "Image 45: waiting for provider capacity (retry in 30s)..." to
 * the user.
 *
 * After MAX_RETRY_ROUNDS rounds, throws an Error so the caller can mark the
 * slot as permanently failed (no more "waiting forever" UX).
 */
export async function generateImageWithRetryQueue(
  prompt: string,
  outPath: string,
  opts?: RetryQueueOptions
): Promise<ProviderOutcome> {
  let retryCount = 0
  let lastTrail: TrailEntry[] = []
  let lastError = 'unknown error'

  for (;;) {
    if (opts?.signal?.aborted) {
      throw new Error('Retry queue aborted by caller.')
    }
    const { outcome, trail } = await generateImageWithFallback(prompt, outPath)
    lastTrail = trail
    if (outcome.ok) return outcome
    lastError = outcome.error || lastError

    // ── CIRCUIT BREAKER ──
    // After MAX_RETRY_ROUNDS rounds of all-tiers-failed, give up permanently.
    // This prevents the queue from spinning in 5-min loops forever when the
    // underlying provider issue is permanent (e.g. daily quota exhausted).
    if (retryCount + 1 > MAX_RETRY_ROUNDS) {
      const exhaustedProviders = trail
        .filter((t) => !t.ok)
        .map((t) => t.provider)
        .filter((v, i, a) => a.indexOf(v) === i) // de-dup
        .join(', ')
      const msg =
        `All image providers exhausted after ${MAX_RETRY_ROUNDS} retry rounds ` +
        `(tried: ${exhaustedProviders || 'none configured'}). ` +
        `Last error: ${lastError.slice(0, 200)}. ` +
        `Suggestion: add API keys for Pexels + Unsplash in .env, or wait for ` +
        `Z.ai daily quota to reset, or regenerate this image after the ` +
        `underlying provider recovers.`
      console.error(`[images] Retry-queue: CIRCUIT BREAKER tripped after ${MAX_RETRY_ROUNDS} rounds. ${msg.slice(0, 200)}`)
      throw new Error(msg)
    }

    // All tiers failed this round → enter the retry-queue.
    const waitMs = RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)]
    const nextRetryAt = Date.now() + waitMs
    retryCount++

    console.warn(
      `[images] Retry-queue: all tiers failed (round ${retryCount}/${MAX_RETRY_ROUNDS}). ` +
        `Waiting ${waitMs / 1000}s before retrying full chain. ` +
        `Last error: ${lastError.slice(0, 100)}`
    )

    opts?.onWait?.({ retryCount, waitMs, nextRetryAt, lastTrail: lastTrail })

    // Sleep, but wake early if aborted.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs)
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      }
    })

    if (opts?.signal?.aborted) {
      throw new Error('Retry queue aborted during wait.')
    }
    opts?.onRetry?.({ retryCount })
  }
}

// ─── Status endpoint helper ──────────────────────────────────────────────────

/**
 * Returns the FULL 3-tier chain status — stock providers (Pexels, Unsplash)
 * at the top, then Z.ai (the only AI-generation provider). This is the
 * user-facing "Image Generation Chain" badge list (N/3 tiers live).
 *
 * Stock providers come from src/lib/stock-photos.ts and have their own
 * cooldown logic (Pexels 5-min on 429, Unsplash 10-min on 429).
 */
export function getProviderStatuses(): ProviderStatus[] {
  // Stock providers (Tier 0 in the hybrid chain) — sourced from stock-photos.ts
  // so cooldown logic stays co-located with the search functions.
  const stockStatuses: ProviderStatus[] = getStockProviderStatuses().map((s) => ({
    name: s.name as ProviderName,
    label: s.label,
    configured: s.configured,
    reason: s.reason
  }))

  // AI-generation provider (Tier 1 — Z.ai only).
  const aiStatuses: ProviderStatus[] = CHAIN.map((p) => {
    // Z.ai runtime cooldown (429 rate-limit) — show as not-configured so the
    // UI badge shows "skip" (not a misleading "live") and the user understands
    // WHY it's being skipped.
    if (p.name === 'zai' && isZaiInCooldown()) {
      return {
        name: p.name,
        label: p.label,
        configured: false,
        reason: `RATE-LIMIT COOLDOWN — ${getZaiCooldownReason()}`
      }
    }
    return {
      name: p.name,
      label: p.label,
      configured: p.configured,
      reason: p.reason
    }
  })

  return [...stockStatuses, ...aiStatuses]
}

/** Count of configured tiers (for the UI badge "N/total tiers live").
 * Excludes providers in runtime billing/rate-limit cooldown. */
export function getConfiguredTierCount(): number {
  return getProviderStatuses().filter((p) => p.configured).length
}

/**
 * Total tiers in the SIMPLIFIED chain (stock + AI).
 *
 * After the 2025-09 simplification: Pexels + Unsplash (stock) + Z.ai (AI) =
 * 3 tiers total. (Previously 7 tiers — Stability, HuggingFace, Cloudflare,
 * Pollinations all removed.)
 */
export const TOTAL_TIERS = 2 + CHAIN.length // Pexels + Unsplash + 1 AI tier (Z.ai) = 3

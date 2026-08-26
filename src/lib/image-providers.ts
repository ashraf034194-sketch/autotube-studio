import ZAI from 'z-ai-web-dev-sdk'
import { GoogleGenAI } from '@google/genai'
import fs from 'fs'
import path from 'path'

// ─── Public types ────────────────────────────────────────────────────────────

export type ProviderName = 'custom' | 'google' | 'zai' | 'cloudflare' | 'pollinations'

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
 * Tier 2: Google AI Studio (Gemini) API key. Get it from:
 *   https://aistudio.google.com/apikey
 * Free tier includes generous quota for `gemini-2.5-flash-image` (Nano Banana).
 * If unset, Google tier is skipped → falls to next tier.
 */
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ''
export const GOOGLE_IMAGE_MODEL = process.env.GOOGLE_IMAGE_MODEL || 'gemini-2.5-flash-image'
export const GOOGLE_IMAGEN_MODEL = process.env.GOOGLE_IMAGEN_MODEL || 'imagen-3.0-generate-002'
export const GOOGLE_IMAGE_DISABLED = process.env.GOOGLE_IMAGE_DISABLED === 'true'

/**
 * Tier 3: Z.ai (bundled SDK). Always available unless explicitly disabled.
 */
export const ZAI_DISABLED = process.env.ZAI_IMAGE_DISABLED === 'true'

/**
 * Tier 1: Manus (Custom Tool) — synchronous image generation API.
 * Override base URL via env if Manus deploys to a new host.
 */
export const CUSTOM_IMAGE_API_BASE =
  process.env.CUSTOM_IMAGE_API_BASE || 'https://aiimagegen-3x5xzxc5.manus.space'
export const CUSTOM_IMAGE_DISABLED = process.env.CUSTOM_IMAGE_DISABLED === 'true'

/**
 * Tier 4: Cloudflare Workers AI.
 * Credentials MUST stay server-side only (never expose to frontend).
 * Uses FLUX.1-schnell — fastest + best quality text-to-image model in the
 * Cloudflare catalog (verified: 1.6s avg, returns base64 JPEG via JSON).
 */
export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || ''
export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || ''
export const CF_IMAGE_MODEL =
  process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell'
export const CLOUDFLARE_IMAGE_DISABLED = process.env.CLOUDFLARE_IMAGE_DISABLED === 'true'

/**
 * Tier 5: Pollinations.ai — absolute last resort. No API key, always available.
 * URL format: https://image.pollinations.ai/prompt/{encoded_prompt}?width=W&height=H
 * Concurrency = 1 (safe limit discovered earlier — Pollinations throttles bursts).
 */
export const POLLINATIONS_IMAGE_DISABLED = process.env.POLLINATIONS_IMAGE_DISABLED === 'true'
export const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt'

// ─── Target image size ───────────────────────────────────────────────────────

/** 16:9 cinematic frame. Manus respects aspectRatio, Google Imagen respects '16:9',
 *  Z.ai + Cloudflare + Pollinations take explicit width/height. */
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

/**
 * Per-provider concurrency=1 mutex. Used by Manus AND Pollinations (both
 * throttle concurrent requests). Each gets its OWN independent chain so
 * they don't block each other.
 */
function makeLock() {
  let tail: Promise<unknown> = Promise.resolve()
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

// ─── Tier 1: Manus (Custom Tool) — with v1.2 recovery-quality handling ───────

interface ManusGenerateResponse {
  imageUrl?: string
  model?: string
  aspectRatio?: string
  quality?: string
  expectedSeconds?: { minimum?: number; maximum?: number }
  error?: string
  fallbackUsed?: boolean
  qualityTier?: string
  recoveryReason?: string
  attempts?: number
}

interface ManusHealthResponse {
  service?: string
  status?: 'ready' | 'busy' | 'degraded' | string
  activeGenerations?: number
  maxConcurrentGenerations?: number
}

const withManusLock = makeLock()

interface ManusHealthCache {
  status: 'ready' | 'busy' | 'degraded' | 'unknown'
  checkedAt: number
}
let manusHealthCache: ManusHealthCache | null = null
const MANUS_HEALTH_TTL_MS = 10_000

async function getManusHealth(force = false): Promise<ManusHealthCache> {
  if (!force && manusHealthCache && Date.now() - manusHealthCache.checkedAt < MANUS_HEALTH_TTL_MS) {
    return manusHealthCache
  }
  const url = `${CUSTOM_IMAGE_API_BASE}/api/v1/images/health`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) {
      manusHealthCache = { status: 'unknown', checkedAt: Date.now() }
      return manusHealthCache
    }
    const json = (await res.json()) as ManusHealthResponse
    manusHealthCache = {
      status: (json.status as ManusHealthCache['status']) || 'unknown',
      checkedAt: Date.now()
    }
    return manusHealthCache
  } catch {
    manusHealthCache = { status: 'unknown', checkedAt: Date.now() }
    return manusHealthCache
  }
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10)
    if (!Number.isNaN(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  }
  const date = Date.parse(headerValue)
  if (!Number.isNaN(date)) {
    const ms = date - Date.now()
    if (ms > 0) return Math.min(ms, 60_000)
    return 0
  }
  return null
}

async function callManusGenerate(
  prompt: string
): Promise<
  | { ok: true; data: ManusGenerateResponse }
  | {
      ok: false
      status: number
      error: string
      transient: boolean
      retryAfterMs?: number
      reason?: 'HIGH_QUALITY_UNAVAILABLE' | 'RECOVERY_QUALITY'
    }
> {
  const url = `${CUSTOM_IMAGE_API_BASE}/api/v1/images/generate`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        aspectRatio: '16:9',
        quality: 'high',
        allowFallback: false,
        negativePrompt: 'text overlays, logo, watermark'
      }),
      signal: controller.signal
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      // 503 = HIGH_QUALITY_UNAVAILABLE — skip to next tier, do NOT retry within Manus.
      if (res.status === 503) {
        const parsed = parseRetryAfter(res.headers.get('retry-after'))
        console.warn(
          `[images] Manus 503 HIGH_QUALITY_UNAVAILABLE` +
            `${parsed !== null ? ` (Retry-After=${(parsed / 1000).toFixed(1)}s)` : ''} ` +
            `— skipping to next tier. Body: ${bodyText.slice(0, 120)}`
        )
        return {
          ok: false,
          status: 503,
          error: `Manus 503 HIGH_QUALITY_UNAVAILABLE${
            parsed !== null ? ` (Retry-After=${(parsed / 1000).toFixed(1)}s)` : ''
          }`,
          transient: false,
          retryAfterMs: parsed ?? undefined,
          reason: 'HIGH_QUALITY_UNAVAILABLE'
        }
      }
      const transient = res.status === 429 || res.status === 502 || res.status === 504
      let retryAfterMs: number | undefined
      if (res.status === 429) {
        const parsed = parseRetryAfter(res.headers.get('retry-after'))
        if (parsed !== null) retryAfterMs = parsed
      }
      return {
        ok: false,
        status: res.status,
        error: `Manus API HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
        transient,
        retryAfterMs
      }
    }

    let json: ManusGenerateResponse
    try {
      json = (await res.json()) as ManusGenerateResponse
    } catch (err) {
      return {
        ok: false,
        status: 200,
        error: `Manus API returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        transient: false
      }
    }

    if (!json.imageUrl) {
      return {
        ok: false,
        status: 200,
        error: `Manus API response missing imageUrl. Body: ${JSON.stringify(json).slice(0, 200)}`,
        transient: false
      }
    }

    // SAFETY CHECK: reject silent "recovery" quality (200 with weak image).
    const isRecovery = json.fallbackUsed === true || json.qualityTier !== 'requested'
    if (isRecovery) {
      console.warn(
        `[images] Manus 200 RECOVERY_QUALITY rejected — ` +
          `fallbackUsed=${json.fallbackUsed ?? 'n/a'}, ` +
          `qualityTier=${JSON.stringify(json.qualityTier) ?? 'missing'}. ` +
          `Skipping to next tier.`
      )
      return {
        ok: false,
        status: 200,
        error: `Manus returned recovery/fallback quality — rejected per spec, skipping to next tier`,
        transient: false,
        reason: 'RECOVERY_QUALITY'
      }
    }
    console.log(
      `[images] Manus 200 OK accepted — qualityTier=${JSON.stringify(json.qualityTier)}, ` +
        `fallbackUsed=${json.fallbackUsed ?? 'n/a'}`
    )
    return { ok: true, data: json }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      error: aborted
        ? 'Manus API request timed out (120s).'
        : `Manus API network error: ${err instanceof Error ? err.message : String(err)}`,
      transient: true
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function downloadManusImage(
  imageUrl: string,
  outPath: string
): Promise<{ ok: true; bytes: number } | { ok: false; error: string; transient: boolean }> {
  const fullUrl = imageUrl.startsWith('http') ? imageUrl : `${CUSTOM_IMAGE_API_BASE}${imageUrl}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(fullUrl, { signal: controller.signal })
    if (!res.ok) {
      return {
        ok: false,
        error: `Image download HTTP ${res.status}`,
        transient: res.status === 502 || res.status === 503 || res.status === 504
      }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) return { ok: false, error: `Too small (${buf.length} bytes)`, transient: false }
    writeImageBuffer(buf, outPath, 'manus')
    return { ok: true, bytes: buf.length }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      error: aborted ? 'Download timed out (60s).' : `Network: ${err instanceof Error ? err.message : String(err)}`,
      transient: true
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function runManusGeneration(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  const BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000]
  const MAX_ATTEMPTS = BACKOFFS_MS.length + 1
  let lastError = ''
  let lastModel = 'manus'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const genResult = await callManusGenerate(prompt)
    if (!genResult.ok) {
      lastError = genResult.error
      const shouldRetry = genResult.transient && attempt < MAX_ATTEMPTS
      if (genResult.reason) {
        console.warn(
          `[images] Manus bail reason=${genResult.reason} attempt ${attempt}/${MAX_ATTEMPTS} — skipping to next tier. ${genResult.error.slice(0, 120)}`
        )
      } else {
        console.error(
          `[images] Manus attempt ${attempt}/${MAX_ATTEMPTS} failed (HTTP ${genResult.status}): ${genResult.error.slice(0, 150)}`
        )
      }
      if (!shouldRetry) return { ok: false, provider: 'custom', error: lastError }
      const waitMs = genResult.retryAfterMs !== undefined ? genResult.retryAfterMs : BACKOFFS_MS[attempt - 1]
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }
    lastModel = genResult.data.model || 'manus'
    const dlResult = await downloadManusImage(genResult.data.imageUrl!, outPath)
    if (dlResult.ok) {
      return {
        ok: true,
        provider: 'custom',
        outPath,
        meta: {
          model: lastModel,
          bytes: dlResult.bytes,
          attempt,
          source: 'manus-sync-api',
          qualityTier: genResult.data.qualityTier ?? 'unknown',
          fallbackUsed: genResult.data.fallbackUsed === true,
          recoveryReason: genResult.data.recoveryReason ?? 'none',
          manusAttempts: genResult.data.attempts ?? 0
        }
      }
    }
    lastError = dlResult.error
    const shouldRetry = dlResult.transient && attempt < MAX_ATTEMPTS
    if (!shouldRetry) return { ok: false, provider: 'custom', error: lastError }
    await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt - 1]))
  }
  return { ok: false, provider: 'custom', error: lastError || 'Manus failed after retries.' }
}

async function generateWithCustom(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  if (CUSTOM_IMAGE_DISABLED) return { ok: false, provider: 'custom', error: 'disabled via env' }
  const health = await getManusHealth()
  if (health.status === 'busy') {
    await new Promise((r) => setTimeout(r, 5_000))
  } else if (health.status === 'degraded') {
    await new Promise((r) => setTimeout(r, 10_000))
  }
  return withManusLock(() => runManusGeneration(prompt, outPath))
}

const customProvider: Provider = {
  name: 'custom',
  label: 'Manus (Custom Tool)',
  configured: !CUSTOM_IMAGE_DISABLED,
  reason: CUSTOM_IMAGE_DISABLED
    ? 'disabled via env'
    : `Manus sync API @ ${CUSTOM_IMAGE_API_BASE} (concurrency=1, health-check, v1.2 recovery-handling)`,
  generate: generateWithCustom
}

// ─── Tier 2: Google AI Studio (Nano Banana + Imagen fallback) ───────────────

interface GoogleClient { ai: GoogleGenAI }
let googleClient: GoogleClient | null = null
function getGoogleClient(): GoogleClient | null {
  if (!GOOGLE_API_KEY) return null
  if (!googleClient) googleClient = { ai: new GoogleGenAI({ apiKey: GOOGLE_API_KEY }) }
  return googleClient
}

async function generateWithGoogle(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  if (GOOGLE_IMAGE_DISABLED) return { ok: false, provider: 'google', error: 'disabled via env' }
  const client = getGoogleClient()
  if (!client) return { ok: false, provider: 'google', error: 'GOOGLE_API_KEY not set' }

  // Attempt 1: Nano Banana
  try {
    const response = await client.ai.models.generateContent({
      model: GOOGLE_IMAGE_MODEL,
      contents: prompt,
      config: { responseModalities: ['IMAGE'] }
    })
    const parts = response.candidates?.[0]?.content?.parts ?? []
    for (const part of parts) {
      const b64 = (part as { inlineData?: { data?: string } }).inlineData?.data
      if (b64) {
        const buf = Buffer.from(b64, 'base64')
        if (buf.length < 1000) continue
        writeImageBuffer(buf, outPath, 'google-nano-banana')
        return { ok: true, provider: 'google', outPath, meta: { model: GOOGLE_IMAGE_MODEL, bytes: buf.length } }
      }
    }
  } catch (err) {
    console.error(`[images] Google Nano Banana failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}`)
  }

  // Attempt 2: Imagen 3
  try {
    const response = await client.ai.models.generateImages({
      model: GOOGLE_IMAGEN_MODEL,
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '16:9',
        outputOptions: { mimeType: 'image/jpeg' },
        safetyFilterLevel: 'block_only_high'
      } as never
    })
    const b64 = response.generatedImages?.[0]?.image?.bytes
    if (!b64) return { ok: false, provider: 'google', error: 'Imagen returned no image bytes.' }
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 1000) return { ok: false, provider: 'google', error: `Too small (${buf.length} bytes)` }
    writeImageBuffer(buf, outPath, 'google-imagen')
    return { ok: true, provider: 'google', outPath, meta: { model: GOOGLE_IMAGEN_MODEL, bytes: buf.length } }
  } catch (err) {
    return { ok: false, provider: 'google', error: `Imagen failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}` }
  }
}

const googleProvider: Provider = {
  name: 'google',
  label: 'Google AI Studio (Nano Banana)',
  configured: !!GOOGLE_API_KEY && !GOOGLE_IMAGE_DISABLED,
  reason: GOOGLE_IMAGE_DISABLED
    ? 'disabled via env'
    : GOOGLE_API_KEY
      ? `model=${GOOGLE_IMAGE_MODEL}`
      : 'GOOGLE_API_KEY env var not set — get one at https://aistudio.google.com/apikey',
  generate: generateWithGoogle
}

// ─── Tier 3: Z.ai (bundled SDK) ──────────────────────────────────────────────

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
  const MAX_ATTEMPTS = 3
  let lastError = ''
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
      console.error(`[images] Z.ai attempt ${attempt}/${MAX_ATTEMPTS} failed${rateLimited ? ' (rate-limited)' : ''}: ${lastError.slice(0, 120)}`)
      if (attempt < MAX_ATTEMPTS) {
        const backoff = rateLimited ? 3000 * attempt : 1500 * attempt
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }
  return { ok: false, provider: 'zai', error: lastError || 'Z.ai failed after retries.' }
}

const zaiProvider: Provider = {
  name: 'zai',
  label: 'Z.ai (bundled SDK)',
  configured: !ZAI_DISABLED,
  reason: ZAI_DISABLED ? 'disabled via env' : 'always available (bundled SDK)',
  generate: generateWithZai
}

// ─── Tier 4: Cloudflare Workers AI (FLUX.1-schnell) ──────────────────────────

/**
 * Cloudflare Workers AI text-to-image. Uses FLUX.1-schnell — the fastest +
 * highest-quality model in their catalog (verified: ~1.6s per image, returns
 * base64 JPEG via JSON `result.image`).
 *
 * Credentials (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) are server-side
 * ONLY — never exposed to the frontend. The provider status endpoint returns
 * only a redacted "configured: true/false", never the token itself.
 *
 * Retry: 3 attempts with backoff on transient errors (429, 5xx, network).
 */
async function callCloudflareGenerate(
  prompt: string
): Promise<
  | { ok: true; buf: Buffer; model: string }
  | { ok: false; status: number; error: string; transient: boolean }
> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_IMAGE_MODEL}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt }),
      signal: controller.signal
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const transient = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504
      return { ok: false, status: res.status, error: `Cloudflare HTTP ${res.status}: ${bodyText.slice(0, 200)}`, transient }
    }

    // FLUX returns JSON with base64 image string in result.image.
    const ct = res.headers.get('content-type') || ''
    let buf: Buffer
    if (ct.includes('application/json')) {
      const json = (await res.json()) as { success?: boolean; result?: { image?: string | number[] }; errors?: { message?: string }[] }
      if (!json.success) {
        const errMsg = json.errors?.[0]?.message || JSON.stringify(json).slice(0, 200)
        return { ok: false, status: 200, error: `Cloudflare success=false: ${errMsg}`, transient: false }
      }
      const img = json.result?.image
      if (!img) return { ok: false, status: 200, error: 'Cloudflare response missing result.image', transient: false }
      if (typeof img === 'string') {
        buf = Buffer.from(img, 'base64')
      } else if (Array.isArray(img)) {
        buf = Buffer.from(img)
      } else {
        return { ok: false, status: 200, error: 'Cloudflare result.image has unexpected type', transient: false }
      }
    } else {
      // Raw image bytes (some models return PNG directly).
      buf = Buffer.from(await res.arrayBuffer())
    }

    if (buf.length < 1000) return { ok: false, status: 200, error: `Cloudflare image too small (${buf.length} bytes)`, transient: false }
    return { ok: true, buf, model: CF_IMAGE_MODEL }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      error: aborted ? 'Cloudflare timed out (60s).' : `Cloudflare network: ${err instanceof Error ? err.message : String(err)}`,
      transient: true
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function generateWithCloudflare(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  if (CLOUDFLARE_IMAGE_DISABLED) return { ok: false, provider: 'cloudflare', error: 'disabled via env' }
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    return { ok: false, provider: 'cloudflare', error: 'CLOUDFLARE_ACCOUNT_ID/API_TOKEN not set' }
  }
  const MAX_ATTEMPTS = 3
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await callCloudflareGenerate(prompt)
    if (result.ok) {
      writeImageBuffer(result.buf, outPath, 'cloudflare-flux')
      return {
        ok: true,
        provider: 'cloudflare',
        outPath,
        meta: { model: result.model, bytes: result.buf.length, attempt }
      }
    }
    lastError = result.error
    const shouldRetry = result.transient && attempt < MAX_ATTEMPTS
    console.error(`[images] Cloudflare attempt ${attempt}/${MAX_ATTEMPTS} failed (HTTP ${result.status}): ${result.error.slice(0, 120)}`)
    if (!shouldRetry) return { ok: false, provider: 'cloudflare', error: lastError }
    await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
  return { ok: false, provider: 'cloudflare', error: lastError || 'Cloudflare failed after retries.' }
}

const cloudflareProvider: Provider = {
  name: 'cloudflare',
  label: 'Cloudflare Workers AI (FLUX.1-schnell)',
  configured: !!CLOUDFLARE_ACCOUNT_ID && !!CLOUDFLARE_API_TOKEN && !CLOUDFLARE_IMAGE_DISABLED,
  reason: CLOUDFLARE_IMAGE_DISABLED
    ? 'disabled via env'
    : !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN
      ? 'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN not set'
      : `model=${CF_IMAGE_MODEL} (credentials server-side only)`,
  generate: generateWithCloudflare
}

// ─── Tier 5: Pollinations.ai (last resort, no key, concurrency=1) ───────────

const withPollinationsLock = makeLock()

async function generateWithPollinations(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  if (POLLINATIONS_IMAGE_DISABLED) return { ok: false, provider: 'pollinations', error: 'disabled via env' }
  // Serialize via lock (concurrency=1 — Pollinations throttles bursts).
  return withPollinationsLock(() => runPollinations(prompt, outPath))
}

async function runPollinations(
  prompt: string,
  outPath: string
): Promise<ProviderOutcome | ProviderFailure> {
  const MAX_ATTEMPTS = 3
  let lastError = ''
  const encoded = encodeURIComponent(prompt.slice(0, 1500))
  const url = `${POLLINATIONS_BASE}/${encoded}?width=${IMAGE_WIDTH}&height=${IMAGE_HEIGHT}&nologo=true`

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000) // Pollinations can be slow
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const transient = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503
        lastError = `Pollinations HTTP ${res.status}`
        console.error(`[images] Pollinations attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError}`)
        if (attempt < MAX_ATTEMPTS && transient) {
          await new Promise((r) => setTimeout(r, 3000 * attempt))
          continue
        }
        return { ok: false, provider: 'pollinations', error: lastError }
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1000) {
        lastError = `Pollinations image too small (${buf.length} bytes)`
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 3000 * attempt))
          continue
        }
        return { ok: false, provider: 'pollinations', error: lastError }
      }
      writeImageBuffer(buf, outPath, 'pollinations')
      return { ok: true, provider: 'pollinations', outPath, meta: { bytes: buf.length, attempt } }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      lastError = aborted ? 'Pollinations timed out (90s).' : `Pollinations network: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[images] Pollinations attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.slice(0, 120)}`)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 3000 * attempt))
        continue
      }
      return { ok: false, provider: 'pollinations', error: lastError }
    } finally {
      clearTimeout(timeout)
    }
  }
  return { ok: false, provider: 'pollinations', error: lastError || 'Pollinations failed after retries.' }
}

const pollinationsProvider: Provider = {
  name: 'pollinations',
  label: 'Pollinations.ai (last resort)',
  configured: !POLLINATIONS_IMAGE_DISABLED,
  reason: POLLINATIONS_IMAGE_DISABLED ? 'disabled via env' : 'always available (no API key, concurrency=1)',
  generate: generateWithPollinations
}

// ─── The 5-tier chain ────────────────────────────────────────────────────────

/**
 * 5-TIER RESILIENT CHAIN:
 *   Tier 1 = Manus (Custom)       — preferred primary, v1.2 recovery handling
 *   Tier 2 = Google (Nano Banana) — fallback when Manus fails
 *   Tier 3 = Z.ai                 — bundled SDK fallback
 *   Tier 4 = Cloudflare (FLUX)    — Workers AI, fast + cheap
 *   Tier 5 = Pollinations         — absolute last resort, no key, always up
 *
 * Each provider keeps its OWN concurrency ceiling (Manus=1, Pollinations=1,
 * others uncapped) and retry/health-check settings — only the order changes.
 */
const CHAIN: Provider[] = [
  customProvider,
  googleProvider,
  zaiProvider,
  cloudflareProvider,
  pollinationsProvider
]

/**
 * Try each provider in order. Returns the first success, OR the last failure.
 * Also reports which providers were tried (for telemetry / trail display).
 *
 * NOTE: This function returns failure if ALL 5 tiers fail in one round. For
 * the "never permanently fail" behavior, use `generateImageWithRetryQueue`
 * which wraps this in an exponential-backoff retry loop.
 */
export async function generateImageWithFallback(
  prompt: string,
  outPath: string
): Promise<{ outcome: ProviderOutcome | ProviderFailure; trail: TrailEntry[] }> {
  const trail: TrailEntry[] = []
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
  const lastFailure = trail.length
    ? trail[trail.length - 1]
    : { provider: 'custom' as ProviderName, ok: false, error: 'no providers configured' }
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
  /** Called when entering a wait (all 5 tiers failed this round). */
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
 * SMART RETRY-QUEUE — the heart of the "never permanently fail" guarantee.
 *
 * If ALL 5 tiers fail for an image in a single round, this function does NOT
 * give up. It puts the image in a "waiting queue", waits 30s, then retries the
 * FULL chain from Tier 1 (Manus). If that fails too, the wait grows: 60s → 2min
 * → 5min (capped). The loop continues indefinitely until the image succeeds.
 *
 * Progress is reported via the onWait / onRetry callbacks so the job worker can
 * show "Image 45: waiting for provider capacity (retry in 30s)..." to the user.
 */
export async function generateImageWithRetryQueue(
  prompt: string,
  outPath: string,
  opts?: RetryQueueOptions
): Promise<ProviderOutcome> {
  let retryCount = 0
  let lastTrail: TrailEntry[] = []

  for (;;) {
    if (opts?.signal?.aborted) {
      throw new Error('Retry queue aborted by caller.')
    }
    const { outcome, trail } = await generateImageWithFallback(prompt, outPath)
    lastTrail = trail
    if (outcome.ok) return outcome

    // All 5 tiers failed this round → enter the retry-queue.
    const waitMs = RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)]
    const nextRetryAt = Date.now() + waitMs
    retryCount++

    console.warn(
      `[images] Retry-queue: all 5 tiers failed (round ${retryCount}). ` +
        `Waiting ${waitMs / 1000}s before retrying full chain. ` +
        `Last error: ${outcome.error.slice(0, 100)}`
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

export function getProviderStatuses(): ProviderStatus[] {
  return CHAIN.map((p) => ({
    name: p.name,
    label: p.label,
    configured: p.configured,
    reason: p.reason
  }))
}

/** Count of configured tiers (for the UI badge "N/5 tiers live"). */
export function getConfiguredTierCount(): number {
  return CHAIN.filter((p) => p.configured).length
}

export const TOTAL_TIERS = CHAIN.length

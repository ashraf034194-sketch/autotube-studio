import fs from 'fs'
import path from 'path'
import { IMAGE_WIDTH, IMAGE_HEIGHT } from './image-providers'
import {
  CREDENTIAL_BACKUP,
  resolveCredential,
  logCredentialStatusAtStartup
} from './credential-backup'

// ─── Configuration (env-driven + backup fallback) ─────────────────────────

/**
 * HYBRID IMAGE ENGINE — Stock Photo Sources (Pexels + Unsplash)
 *
 * Both are genuinely free, commercial-use-licensed photo libraries:
 *
 *  • Pexels — 200 requests/hour, 20,000 requests/month, no attribution required
 *    (though appreciated). License: Pexels License (free for commercial + personal).
 *    Endpoint: https://api.pexels.com/v1/search?query={q}&per_page=1&orientation=landscape
 *    Auth: the access key goes in the Authorization header (no "Bearer " prefix).
 *
 *  • Unsplash — 50 requests/hour (demo rate), free for commercial use under the
 *    Unsplash License (https://unsplash.com/license). Attribution recommended.
 *    Endpoint: https://api.unsplash.com/search/photos?query={q}&per_page=1&orientation=landscape
 *    Auth: "Client-ID {access_key}" in the Authorization header.
 *
 * The hybrid engine tries Pexels first (higher rate limit), then Unsplash. If both
 * stock sources fail (no result, network error, or rate-limited), the caller falls
 * through to the existing 3-tier AI-generation chain (Stability → HuggingFace → Z.ai).
 *
 * PERMANENT FIX (2026-08-31): credentials resolve from process.env first; if env
 * is empty (which happens at every sandbox session start — .env is reset to a
 * DATABASE_URL-only baseline by the sandbox boot "Project initialization check"
 * step), fall back to the hardcoded values in src/lib/credential-backup.ts.
 * That file lives under src/lib/ which IS preserved by the snapshot, so the
 * credentials survive every session reset. See credential-backup.ts for the
 * full root-cause analysis + diagnostic checklist.
 */
const _pexels = resolveCredential(process.env.PEXELS_API_KEY, CREDENTIAL_BACKUP.PEXELS_API_KEY)
const _unsplash = resolveCredential(process.env.UNSPLASH_ACCESS_KEY, CREDENTIAL_BACKUP.UNSPLASH_ACCESS_KEY)
export const PEXELS_API_KEY = _pexels.value
export const UNSPLASH_ACCESS_KEY = _unsplash.value
// Export the source labels so image-providers.ts can surface "live (from backup)"
// vs "live" vs "skip" in the /api/images/providers status UI.
export const PEXELS_SOURCE: 'env' | 'backup' | 'missing' = _pexels.source
export const UNSPLASH_SOURCE: 'env' | 'backup' | 'missing' = _unsplash.source

// Startup self-check — logs a clear WARNING to dev.log/console at server start
// if any required credential is missing in BOTH env AND backup. This surfaces
// the issue immediately, without needing to check the UI endpoint manually.
logCredentialStatusAtStartup(_pexels, _unsplash)

export const STOCK_PHOTOS_DISABLED =
  process.env.STOCK_PHOTOS_DISABLED === 'true' || process.env.HYBRID_IMAGES_ENABLED === 'false'

/** Master toggle for the whole hybrid engine (concrete-content stock routing). */
export const HYBRID_IMAGES_ENABLED = process.env.HYBRID_IMAGES_ENABLED !== 'false'

// ─── Cooldowns (same pattern as the AI-provider chain) ──────────────────────

let pexelsCooldownUntil = 0
let pexelsCooldownReason = ''
let unsplashCooldownUntil = 0
let unsplashCooldownReason = ''

/** Set Pexels cooldown (e.g. when 429 rate-limited). Clamped to a 1-hour ceiling. */
export function setPexelsCooldown(durationMs: number, reason: string): void {
  const clamped = Math.min(Math.max(durationMs, 0), 60 * 60_000)
  const until = Date.now() + clamped
  if (until > pexelsCooldownUntil) {
    pexelsCooldownUntil = until
    pexelsCooldownReason = reason
    console.warn(
      `[stock] Pexels cooldown set for ${(clamped / 1000).toFixed(0)}s — ${reason.slice(0, 120)}`
    )
  }
}

/** Returns true if Pexels is in cooldown (should be skipped). */
export function isPexelsInCooldown(): boolean {
  return Date.now() < pexelsCooldownUntil
}

/** Returns the Pexels cooldown reason or empty string if not in cooldown. */
export function getPexelsCooldownReason(): string {
  return isPexelsInCooldown() ? pexelsCooldownReason : ''
}

/** Set Unsplash cooldown. Clamped to a 1-hour ceiling. */
export function setUnsplashCooldown(durationMs: number, reason: string): void {
  const clamped = Math.min(Math.max(durationMs, 0), 60 * 60_000)
  const until = Date.now() + clamped
  if (until > unsplashCooldownUntil) {
    unsplashCooldownUntil = until
    unsplashCooldownReason = reason
    console.warn(
      `[stock] Unsplash cooldown set for ${(clamped / 1000).toFixed(0)}s — ${reason.slice(0, 120)}`
    )
  }
}

/** Returns true if Unsplash is in cooldown (should be skipped). */
export function isUnsplashInCooldown(): boolean {
  return Date.now() < unsplashCooldownUntil
}

/** Returns the Unsplash cooldown reason or empty string if not in cooldown. */
export function getUnsplashCooldownReason(): string {
  return isUnsplashInCooldown() ? unsplashCooldownReason : ''
}

// ─── Public types ──────────────────────────────────────────────────────────

export type StockSource = 'pexels' | 'unsplash'

export interface StockPhotoResult {
  ok: boolean
  source?: StockSource
  /** Absolute file path the photo was saved to. */
  outPath?: string
  /** The original photo URL (for attribution / debugging). */
  photoUrl?: string
  /** Photographer credit (Unsplash requests attribution). */
  photographer?: string
  /** Search-query actually sent to the API (after content-extraction). */
  query?: string
  /** Width × height of the downloaded photo (may differ from target — caller resizes if needed). */
  width?: number
  height?: number
  error?: string
}

export interface StockProviderStatus {
  name: StockSource
  label: string
  configured: boolean
  reason: string
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

interface PexelsSearchResponse {
  total_results?: number
  photos?: Array<{
    id: number
    width: number
    height: number
    url: string
    photographer: string
    src: {
      original: string
      large2x: string
      large: string
      medium: string
    }
    alt?: string
  }>
}

interface UnsplashSearchResponse {
  total?: number
  results?: Array<{
    id: string
    width: number
    height: number
    urls: {
      raw: string
      full: string
      regular: string
      small: string
    }
    user: {
      name: string
      username: string
    }
    links: {
      html: string
    }
    description?: string | null
    alt_description?: string | null
  }>
}

// ─── Typography / text-heavy image filter ───────────────────────────────────
//
// PROBLEM: Stock libraries like Pexels have a LOT of motivational typography
// posters — search for "impact", "growth", "success", "transformation",
// "gratitude" and the #1 result is often a wooden-letters-on-colored-background
// poster spelling the word out (e.g., alt: "Wooden letters spelling 'IMPACT'
// against a textured pink watercolor backdrop, symbolizing influence and
// change."). These are useless as B-roll for narration videos.
//
// FIX: After fetching multiple candidates (per_page=5), we skip any result
// whose alt/description text contains typography markers. We also prefer
// candidates whose aspect ratio is genuinely landscape (close to 1.4-1.8:1);
// typography posters are often square or 4:5.
const TYPOGRAPHY_MARKERS = [
  'letters spelling',
  'wooden letters',
  'spelling',
  'typography',
  'poster',
  'lettering',
  'hand lettering',
  'chalkboard writing',
  'white text',
  'black text',
  'word "',
  "word '",
  'quote',
  'motivational text',
  'text overlay',
  'sign that says',
  'banner with text',
  'card with word',
  'marquee',
  'graffiti',
  'font',
  'printed text',
  'sheet of paper with writing'
]

/** Returns true if the candidate's description text indicates a typography poster. */
function looksLikeTypography(altText: string | null | undefined): boolean {
  if (!altText) return false
  const lower = altText.toLowerCase()
  return TYPOGRAPHY_MARKERS.some((m) => lower.includes(m))
}

/**
 * Returns a "landscape-ness" score. Higher = more landscape (good for our use).
 * Square images (1:1) score ~1.0; portrait <1.0; landscape 1.5-1.8:1 = ideal.
 * Penalizes typography-poster aspect ratios (square / portrait).
 */
function landscapeScore(width: number, height: number): number {
  if (!width || !height) return 1.0 // unknown — neutral
  return width / height
}

/** Returns true if the candidate's aspect ratio is at least mildly landscape. */
function isReasonablyLandscape(width: number, height: number): boolean {
  const ratio = landscapeScore(width, height)
  // 1.2:1 minimum — anything squarer than 6:5 is suspect for our 16:9 use case.
  return ratio >= 1.2
}

/** Quick GET that follows redirects + reads body as ArrayBuffer. */
async function fetchArrayBuffer(
  url: string,
  init?: RequestInit
): Promise<ArrayBuffer> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    return await res.arrayBuffer()
  } finally {
    clearTimeout(timeout)
  }
}

/** Fetch JSON with timeout + standard headers. */
async function fetchJson<T>(
  url: string,
  init: RequestInit
): Promise<{ status: number; json: T | null; rateLimited: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow'
    })
    const rateLimited = res.status === 429
    if (!res.ok) {
      return { status: res.status, json: null, rateLimited }
    }
    const json = (await res.json()) as T
    return { status: res.status, json, rateLimited }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Pexels search ─────────────────────────────────────────────────────────

/**
 * Search Pexels for one landscape photo matching the query.
 *
 * NEW (2025-08-30): fetches 5 candidates and filters out typography/text-heavy
 * stock posters that commonly pollute single-keyword searches like "impact",
 * "growth", "success", "transformation". Picks the first non-typography
 * candidate whose aspect ratio is reasonably landscape. Falls back to the
 * first non-typography candidate if none have a great aspect ratio.
 *
 * Returns the `large2x` URL (1880×1255 max — closest to our 1344×768 target).
 */
export async function searchPexels(
  query: string
): Promise<{
  ok: boolean
  photoUrl?: string
  photographer?: string
  width?: number
  height?: number
  alt?: string
  error?: string
}> {
  if (STOCK_PHOTOS_DISABLED || !PEXELS_API_KEY) {
    return { ok: false, error: 'Pexels not configured' }
  }
  if (isPexelsInCooldown()) {
    return { ok: false, error: `Pexels cooldown: ${pexelsCooldownReason.slice(0, 80)}` }
  }
  // per_page=5 — we want multiple candidates so we can filter out typography
  // posters and pick the best landscape aspect ratio.
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
    query
  )}&per_page=5&orientation=landscape`
  try {
    const { status, json, rateLimited } = await fetchJson<PexelsSearchResponse>(url, {
      method: 'GET',
      headers: {
        Authorization: PEXELS_API_KEY,
        'Accept': 'application/json'
      }
    })
    if (rateLimited) {
      // 200 req/hour — 5-min cooldown is enough to recover naturally.
      setPexelsCooldown(5 * 60_000, 'rate-limited (429)')
      return { ok: false, error: 'Pexels rate-limited (429)' }
    }
    if (status !== 200 || !json) {
      return { ok: false, error: `Pexels HTTP ${status}` }
    }
    const photos = json.photos ?? []
    if (photos.length === 0 || (json.total_results ?? 0) === 0) {
      return { ok: false, error: 'no results' }
    }

    // ── Two-pass candidate selection ──
    // Pass 1: pick the first candidate that is NOT a typography poster AND has
    //         a reasonably landscape aspect ratio.
    // Pass 2: if none qualified (rare — all 5 were typography or square), pick
    //         the first candidate that's just NOT a typography poster.
    // Pass 3: last resort — use the very first candidate (caller will decide
    //         whether to fall through to Unsplash or AI-generation).
    let best = photos.find(
      (p) => !looksLikeTypography(p.alt) && isReasonablyLandscape(p.width, p.height)
    )
    if (!best) {
      best = photos.find((p) => !looksLikeTypography(p.alt))
    }
    if (!best) {
      // All 5 look like typography — give the caller the first one + a flag so
      // they can fall through to Unsplash or AI if they want. We still return
      // ok:true because Pexels DID return results; the caller decides.
      best = photos[0]
    }
    const photo = best
    const photoUrl = photo.src.large2x || photo.src.large || photo.src.original
    return {
      ok: true,
      photoUrl,
      photographer: photo.photographer,
      width: photo.width,
      height: photo.height,
      alt: photo.alt
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Network errors — short cooldown so we don't hammer a flaky connection.
    if (/abort|timeout|fetch/i.test(msg)) {
      setPexelsCooldown(30_000, `network error: ${msg.slice(0, 80)}`)
    }
    return { ok: false, error: msg }
  }
}

// ─── Unsplash search ────────────────────────────────────────────────────────

/**
 * Search Unsplash for one landscape photo matching the query.
 *
 * NEW (2025-08-30): same typography-poster filter as Pexels — fetch 5
 * candidates, skip any whose description/alt_description contains typography
 * markers, prefer landscape aspect ratio.
 *
 * Returns the `regular` URL (1080×1350 max — Unsplash recommends "regular"
 * for most web use; we still downscale/letterbox to 1344×768 target downstream).
 */
export async function searchUnsplash(
  query: string
): Promise<{
  ok: boolean
  photoUrl?: string
  photographer?: string
  width?: number
  height?: number
  alt?: string
  error?: string
}> {
  if (STOCK_PHOTOS_DISABLED || !UNSPLASH_ACCESS_KEY) {
    return { ok: false, error: 'Unsplash not configured' }
  }
  if (isUnsplashInCooldown()) {
    return { ok: false, error: `Unsplash cooldown: ${unsplashCooldownReason.slice(0, 80)}` }
  }
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
    query
  )}&per_page=5&orientation=landscape`
  try {
    const { status, json, rateLimited } = await fetchJson<UnsplashSearchResponse>(url, {
      method: 'GET',
      headers: {
        Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
        'Accept': 'application/json'
      }
    })
    if (rateLimited) {
      // 50 req/hour — 10-min cooldown to recover within an hour.
      setUnsplashCooldown(10 * 60_000, 'rate-limited (429)')
      return { ok: false, error: 'Unsplash rate-limited (429)' }
    }
    if (status !== 200 || !json) {
      return { ok: false, error: `Unsplash HTTP ${status}` }
    }
    const results = json.results ?? []
    if (results.length === 0 || (json.total ?? 0) === 0) {
      return { ok: false, error: 'no results' }
    }

    // Same two-pass selection as Pexels — but Unsplash's alt_description field
    // is the most reliable signal (it's auto-generated from the actual image).
    let best = results.find(
      (r) =>
        !looksLikeTypography(r.alt_description) &&
        !looksLikeTypography(r.description) &&
        isReasonablyLandscape(r.width, r.height)
    )
    if (!best) {
      best = results.find(
        (r) => !looksLikeTypography(r.alt_description) && !looksLikeTypography(r.description)
      )
    }
    if (!best) {
      best = results[0]
    }
    const photo = best
    return {
      ok: true,
      photoUrl: photo.urls.regular || photo.urls.full,
      photographer: photo.user?.name,
      width: photo.width,
      height: photo.height,
      alt: photo.alt_description || photo.description || undefined
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort|timeout|fetch/i.test(msg)) {
      setUnsplashCooldown(30_000, `network error: ${msg.slice(0, 80)}`)
    }
    return { ok: false, error: msg }
  }
}

// ─── searchStockPhoto — the main public helper ─────────────────────────────

/**
 * Hybrid helper used by the image-generation flow:
 *   1. Try Pexels (higher rate limit, ~200 req/hour).
 *      - If Pexels returns a typography poster (alt text contains "letters
 *        spelling", "typography", etc.), DON'T use it — fall through to
 *        Unsplash instead. This is the fix for the "IMPACT" poster bug.
 *   2. If Pexels has no result, fails, or only has typography → try Unsplash.
 *   3. If both fail → return ok:false so the caller falls through to AI-generation.
 *
 * Downloads the photo and writes it to `outPath`. Returns metadata about which
 * source succeeded (so the UI can show a "Stock (Pexels)" or "Stock (Unsplash)"
 * badge instead of an "AI-generated" badge).
 *
 * @param query 2-4 keyword search phrase (already extracted from the prompt)
 * @param outPath absolute file path to save the downloaded JPEG to
 */
export async function searchStockPhoto(
  query: string,
  outPath: string
): Promise<StockPhotoResult> {
  // PEXELS — first try (higher quota)
  if (PEXELS_API_KEY && !isPexelsInCooldown()) {
    const pexels = await searchPexels(query)
    if (pexels.ok && pexels.photoUrl) {
      // Typography check: if the BEST candidate Pexels returned still looks
      // like a typography/text poster, don't use it — fall through to Unsplash
      // (which has different ranking and likely a real photo). This is the
      // direct fix for the user-reported "IMPACT" poster on image #18.
      if (looksLikeTypography(pexels.alt)) {
        if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
          console.log(
            `[stock] Pexels only returned typography poster for "${query.slice(0, 40)}" (alt: "${pexels.alt?.slice(0, 80)}") → trying Unsplash`
          )
        }
        // Fall through to Unsplash below (don't return).
      } else {
        try {
          const buf = await fetchArrayBuffer(pexels.photoUrl)
          writeStockImage(Buffer.from(buf), outPath, 'Pexels')
          return {
            ok: true,
            source: 'pexels',
            outPath,
            photoUrl: pexels.photoUrl,
            photographer: pexels.photographer,
            query,
            width: pexels.width,
            height: pexels.height
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[stock] Pexels photo download failed for "${query.slice(0, 40)}" → ${msg.slice(0, 80)}`
          )
        }
      }
    } else if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
      console.log(
        `[stock] Pexels miss for "${query.slice(0, 40)}" → ${pexels.error?.slice(0, 80) ?? 'no result'}`
      )
    }
  }

  // UNSPLASH — second try
  if (UNSPLASH_ACCESS_KEY && !isUnsplashInCooldown()) {
    const unsplash = await searchUnsplash(query)
    if (unsplash.ok && unsplash.photoUrl) {
      // Same typography guard as Pexels — if Unsplash ALSO only returned a
      // typography poster, fall through to AI-generation instead of using it.
      if (looksLikeTypography(unsplash.alt)) {
        if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
          console.log(
            `[stock] Unsplash only returned typography poster for "${query.slice(0, 40)}" (alt: "${unsplash.alt?.slice(0, 80)}") → falling through to AI`
          )
        }
        // Fall through to AI-generation (don't return).
      } else {
        try {
          const buf = await fetchArrayBuffer(unsplash.photoUrl)
          writeStockImage(Buffer.from(buf), outPath, 'Unsplash')
          return {
            ok: true,
            source: 'unsplash',
            outPath,
            photoUrl: unsplash.photoUrl,
            photographer: unsplash.photographer,
            query,
            width: unsplash.width,
            height: unsplash.height
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[stock] Unsplash photo download failed for "${query.slice(0, 40)}" → ${msg.slice(0, 80)}`
          )
        }
      }
    } else if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
      console.log(
        `[stock] Unsplash miss for "${query.slice(0, 40)}" → ${unsplash.error?.slice(0, 80) ?? 'no result'}`
      )
    }
  }

  // Both stock sources failed (or both only had typography) → caller will
  // fall through to AI-generation.
  return {
    ok: false,
    query,
    error: 'no usable stock photo from Pexels or Unsplash (filtered out typography or no results)'
  }
}

function writeStockImage(buf: Buffer, outPath: string, source: string): void {
  const dir = path.dirname(outPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(outPath, buf)
  if (process.env.DEBUG_STOCK_PHOTOS === 'true') {
    console.log(
      `[stock] Wrote ${buf.length} bytes from ${source} to ${outPath} (target ${IMAGE_WIDTH}×${IMAGE_HEIGHT})`
    )
  }
}

// ─── Status helpers (mirrors getProviderStatuses from image-providers.ts) ──

export function getStockProviderStatuses(): StockProviderStatus[] {
  return [
    {
      name: 'pexels',
      label: 'Pexels',
      configured:
        !STOCK_PHOTOS_DISABLED &&
        !!PEXELS_API_KEY &&
        !isPexelsInCooldown(),
      reason: isPexelsInCooldown()
        ? `COOLDOWN — ${getPexelsCooldownReason().slice(0, 100)}`
        : PEXELS_API_KEY
          ? // Surface the credential SOURCE so the user can tell whether the
            // value came from .env (preferred) or the credential-backup.ts
            // fallback (active after a sandbox .env reset).
            `Stock photo library · 200 req/hour · free + commercial-use license` +
            (PEXELS_SOURCE === 'backup' ? ' · (key from credential-backup.ts — .env was reset by sandbox)' : '')
          : 'PEXELS_API_KEY not set in .env OR credential-backup.ts (both empty — see startup WARNING in dev.log)'
    },
    {
      name: 'unsplash',
      label: 'Unsplash',
      configured:
        !STOCK_PHOTOS_DISABLED &&
        !!UNSPLASH_ACCESS_KEY &&
        !isUnsplashInCooldown(),
      reason: isUnsplashInCooldown()
        ? `COOLDOWN — ${getUnsplashCooldownReason().slice(0, 100)}`
        : UNSPLASH_ACCESS_KEY
          ? `Stock photo library · 50 req/hour · free + commercial-use license` +
            (UNSPLASH_SOURCE === 'backup' ? ' · (key from credential-backup.ts — .env was reset by sandbox)' : '')
          : 'UNSPLASH_ACCESS_KEY not set in .env OR credential-backup.ts (both empty — see startup WARNING in dev.log)'
    }
  ]
}

/** Convenience: are ANY stock sources configured? */
export function isAnyStockConfigured(): boolean {
  return getStockProviderStatuses().some((s) => s.configured)
}

/** Convenience: how many stock sources are live right now? */
export function getStockTierCount(): number {
  return getStockProviderStatuses().filter((s) => s.configured).length
}

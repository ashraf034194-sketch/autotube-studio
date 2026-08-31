import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// ─── Shared LLM Wrapper (3-tier fallback + smart retry-queue) ───────────────
//
// Architecture:
//   TIER 1: Z.ai (bundled SDK config)         — primary
//   TIER 2: Cloudflare Workers AI             — fallback when Z.ai fails
//           (@cf/meta/llama-3.3-70b-instruct-fp8-fast — 70B params, fp8
//            quantized, 24k context; 10k neurons/day free, no card)
//   TIER 3: Groq (OpenAI-compatible API)      — fallback when both above fail
//           (llama-3.3-70b-versatile default; 14,400 req/day free, no card;
//            independent infrastructure from Z.ai/Cloudflare so simultaneous
//            rate-limit collisions are rare)
//
// SMART RETRY-QUEUE: when ALL 3 tiers fail in a single pass, the wrapper does
// NOT throw "very busy" — it enters an exponential-backoff retry-queue that
// re-runs the WHOLE chain (Z.ai → Cloudflare → Groq) starting from tier 1.
// Backoff schedule: 15s → 30s → 60s → 2min → 2min → 2min (max 6 rounds,
// ~6min total). Callers can subscribe to a per-call `onWait` callback to
// surface "Waiting for AI capacity, retrying in Xs..." to the UI instead of
// surfacing an error.
//
// This wrapper is shared by every LLM-driven feature:
//   - Script Rewrite (/api/rewrite)
//   - Title Card + Text Highlights + Outro CTA (src/lib/video-script-llm.ts)
//   - Style DNA + batched image-prompt generation (src/app/api/images/route.ts)
//
// TEST TOGGLES (env): set LLM_DISABLE_ZAI=1 / LLM_DISABLE_CLOUDFLARE=1 /
// LLM_DISABLE_GROQ=1 to skip a tier for testing the fallback chain. These
// bypass the provider entirely so the next tier is exercised immediately.
//
// We bypass the Z.ai SDK and call the chat-completions endpoint directly so we
// can READ the rate-limit RESPONSE HEADERS (the SDK throws them away). The
// headers distinguish "daily quota exhausted, do NOT retry" from "transient
// qps/10-min limit, do retry" — critical for not wasting user-daily quota on
// futile retries.

// ─── Z.ai config loader (mirrors the SDK's loadConfig) ─────────────────────

interface ZaiConfig {
  baseUrl: string
  apiKey: string
  token?: string
  userId?: string
  chatId?: string
}

const CONFIG_PATHS = [
  path.join(process.cwd(), '.z-ai-config'),
  path.join(os.homedir(), '.z-ai-config'),
  '/etc/.z-ai-config'
]

let cachedZaiConfig: ZaiConfig | null = null
let cachedZaiConfigAt = 0
const ZAI_CONFIG_TTL_MS = 60_000

async function loadZaiConfig(): Promise<ZaiConfig> {
  // Cache for 60s so we don't re-read the file on every call (perf only —
  // the file rarely changes during a session).
  const now = Date.now()
  if (cachedZaiConfig && now - cachedZaiConfigAt < ZAI_CONFIG_TTL_MS) {
    return cachedZaiConfig
  }
  for (const p of CONFIG_PATHS) {
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const cfg = JSON.parse(raw) as ZaiConfig
      if (cfg.baseUrl && cfg.apiKey) {
        cachedZaiConfig = cfg
        cachedZaiConfigAt = now
        return cfg
      }
    } catch {
      // try next candidate path
    }
  }
  throw new Error('Z.ai configuration file not found. Please create .z-ai-config.')
}

// ─── Cloudflare Workers AI config (reads same env vars as image-gen) ────────

export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || ''
export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || ''

/**
 * Best writing-quality text model in Cloudflare's catalog (verified by
 * probing /accounts/{id}/ai/models/search?task=Text Generation). This is the
 * model the user requested — the URI suffix `-fp8-fast` is the correct name
 * (the bare `@cf/meta/llama-3.3-70b-instruct` returns "No route for that
 * URI").
 *
 * Catalog alternatives also available on this account (for future swaps):
 *   - @cf/openai/gpt-oss-120b (128k ctx, reasoning) — stronger but slower
 *   - @cf/moonshotai/kimi-k2.7-code (262k ctx, 1T param, reasoning)
 *   - @cf/zai-org/glm-5.3-flash (1.3M ctx, multimodal, reasoning)
 *   - @cf/deepseek-ai/deepseek-v4-flash-0731 (1.3M ctx, reasoning)
 *
 * GLM-4.7-Flash was tested and returned an empty response — skip it.
 */
export const CF_TEXT_MODEL =
  process.env.CF_TEXT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export function isCloudflareConfigured(): boolean {
  return !!CLOUDFLARE_ACCOUNT_ID && !!CLOUDFLARE_API_TOKEN
}

// ─── Groq (OpenAI-compatible) config — third tier ───────────────────────────
//
// Groq offers a generous free tier (14,400 requests/day at the time of
// writing) and runs on completely independent infrastructure from Z.ai and
// Cloudflare, so simultaneous rate-limit collisions are rare. The endpoint
// is OpenAI-compatible (https://api.groq.com/openai/v1/chat/completions) so
// we can reuse the standard chat-completions request/response shape.
//
// Default model: llama-3.3-70b-versatile — 70B params, 128k context, fast
// inference on Groq's LPU hardware. Override via GROQ_MODEL env var if you
// want to switch (e.g. 'llama-3.1-8b-instant' for cheaper/faster, or
// 'openai/gpt-oss-120b' for higher quality).
//
// Get a free API key (no card) at: https://console.groq.com/keys
// Set it in .env as: GROQ_API_KEY=gsk_...

export const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
export const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
export const GROQ_BASE_URL =
  process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions'

export function isGroqConfigured(): boolean {
  return !!GROQ_API_KEY
}

// ─── Test toggles (env + runtime override) — bypass a tier for testing ──────
//
// Setting LLM_DISABLE_ZAI=1 / LLM_DISABLE_CLOUDFLARE=1 / LLM_DISABLE_GROQ=1
// (env vars OR runtime overrides via setLlmDisableFlags()) makes the wrapper
// skip that provider's path completely — so the next tier is exercised
// immediately. Used by the disable-test scripts to prove Groq absorbs Z.ai+
// Cloudflare failures and the retry-queue absorbs all-three failures.
//
// Runtime overrides (via setLlmDisableFlags) take PRECEDENCE over env vars.
// This lets a test script flip flags in the live dev server WITHOUT
// restarting it (restarting would kill the persistent server). The
// /api/llm/disable-flags endpoint exposes this for testing.
//
// IMPLEMENTATION NOTE: stored on `globalThis` (NOT module-level `let`)
// because Turbopack/Next.js may load MULTIPLE INSTANCES of this module
// across different route handlers. A module-level `let` would create a
// per-instance state that the disable-flags endpoint sets but the rewrite
// route can't see (each route gets its own copy of the variable).
// globalThis is the JS runtime's true singleton — same across all module
// instances loaded in the same Node.js process. This is the same pattern
// Prisma uses for its client singleton (see lib/db.ts).
const envFlag = (v: string | undefined): boolean => v === '1' || v === 'true'

type LlmRuntimeFlags = { zai: boolean; cloudflare: boolean; groq: boolean }
const GLOBAL_FLAGS_KEY = '__llmWrapperRuntimeDisableFlags'

function getGlobalFlags(): LlmRuntimeFlags {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_FLAGS_KEY]) {
    g[GLOBAL_FLAGS_KEY] = {
      zai: envFlag(process.env.LLM_DISABLE_ZAI),
      cloudflare: envFlag(process.env.LLM_DISABLE_CLOUDFLARE),
      groq: envFlag(process.env.LLM_DISABLE_GROQ)
    } as LlmRuntimeFlags
  }
  return g[GLOBAL_FLAGS_KEY] as LlmRuntimeFlags
}

/**
 * Runtime override for the test disable flags. Called by the
 * /api/llm/disable-flags endpoint to flip flags in the live dev server
 * WITHOUT restarting it. Pass `undefined` for a flag to leave it unchanged;
 * pass `true`/`false` to set it explicitly.
 *
 * Returns the new flag state so the caller can verify it took effect.
 *
 * NOTE: stored on `globalThis` so all Turbopack-loaded module instances
 * see the same state.
 */
export function setLlmDisableFlags(opts: {
  zai?: boolean
  cloudflare?: boolean
  groq?: boolean
}): LlmRuntimeFlags {
  const f = getGlobalFlags()
  if (typeof opts.zai === 'boolean') f.zai = opts.zai
  if (typeof opts.cloudflare === 'boolean') f.cloudflare = opts.cloudflare
  if (typeof opts.groq === 'boolean') f.groq = opts.groq
  return { ...f }
}

// Exported getters (used by the wrapper internals + by llmProviderStatus).
// Functions so they read the globalThis-backed state at CALL TIME.
export const DISABLE_ZAI_GET = (): boolean => getGlobalFlags().zai
export const DISABLE_CLOUDFLARE_GET = (): boolean => getGlobalFlags().cloudflare
export const DISABLE_GROQ_GET = (): boolean => getGlobalFlags().groq

// Backward-compat constants (read at module-load time — for callers that
// imported them as `DISABLE_ZAI` etc. before the runtime-override refactor).
// These are now snapshots; use the *_GET functions above for current values.
export const DISABLE_ZAI = envFlag(process.env.LLM_DISABLE_ZAI)
export const DISABLE_CLOUDFLARE = envFlag(process.env.LLM_DISABLE_CLOUDFLARE)
export const DISABLE_GROQ = envFlag(process.env.LLM_DISABLE_GROQ)

// ─── Retry-queue schedule (exponential backoff, max 6 rounds ~6min) ──────────
//
// When ALL 3 tiers (Z.ai → Cloudflare → Groq) fail in a single pass, the
// wrapper enters the retry-queue: re-runs the WHOLE chain from tier 1, after
// the backoff delay shown below. Cap is 2min/round so a stuck request still
// surfaces as a real error to the user (after ~6min total) instead of hanging
// forever — but in practice, ANY single tier recovering during the queue is
// enough to unblock the request.
//
// Worst-case timing: 15 + 30 + 60 + 120 + 120 + 120 = 465s ≈ 7.75 min
// (plus the per-tier call latency). Well within the rewrite job's 10min TTL
// for normal scripts; image/video jobs have 3h/2h TTLs respectively.
export const RETRY_QUEUE_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 120_000, 120_000]
export const RETRY_QUEUE_MAX_ROUNDS = RETRY_QUEUE_BACKOFF_MS.length // 6

/** Returns a quick health summary used by /api/llm/status (debugging UI). */
export function llmProviderStatus(): {
  zai: { live: boolean; reason?: string }
  cloudflare: { live: boolean; model: string; reason?: string }
  groq: { live: boolean; model: string; reason?: string }
  retryQueue: { maxRounds: number; backoffSecs: number[] }
} {
  // Read the current runtime-overridable values (call-time evaluation).
  const dz = DISABLE_ZAI_GET()
  const dcf = DISABLE_CLOUDFLARE_GET()
  const dg = DISABLE_GROQ_GET()
  return {
    zai: {
      live: !dz,
      reason: dz ? 'disabled via LLM_DISABLE_ZAI (or runtime override)' : undefined
    },
    cloudflare: {
      live: isCloudflareConfigured() && !dcf,
      model: CF_TEXT_MODEL,
      reason:
        dcf
          ? 'disabled via LLM_DISABLE_CLOUDFLARE (or runtime override)'
          : !isCloudflareConfigured()
            ? 'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN not set'
            : undefined
    },
    groq: {
      live: isGroqConfigured() && !dg,
      model: GROQ_MODEL,
      reason:
        dg
          ? 'disabled via LLM_DISABLE_GROQ (or runtime override)'
          : !isGroqConfigured()
            ? 'GROQ_API_KEY not set'
            : undefined
    },
    retryQueue: {
      maxRounds: RETRY_QUEUE_MAX_ROUNDS,
      backoffSecs: RETRY_QUEUE_BACKOFF_MS.map((ms) => Math.round(ms / 1000))
    }
  }
}

// ─── Rate-limit taxonomy (for Z.ai primary path) ───────────────────────────

interface RateLimitInfo {
  status: number
  remainingDaily: number | null
  limitDaily: number | null
  resetEpoch: number | null
  retryAfterSec: number | null
}

/**
 * Thrown when the Z.ai token's DAILY quota is hard-exhausted (remaining-daily
 * === 0). Retrying is FUTILE until the daily window resets — worse, rejected
 * 429 calls still consume the separate user-daily bucket, so the wrapper
 * ABORTS the Z.ai path immediately and falls back to Cloudflare.
 */
export class DailyQuotaExhaustedError extends Error {
  readonly rateLimit: RateLimitInfo
  constructor(rateLimit: RateLimitInfo) {
    super('daily quota exhausted')
    this.name = 'DailyQuotaExhaustedError'
    this.rateLimit = rateLimit
  }
}

/** Thrown for TRANSIENT Z.ai rate limits (qps / 10-min bucket) — safe to retry. */
export class TransientRateLimitError extends Error {
  readonly rateLimit: RateLimitInfo
  constructor(rateLimit: RateLimitInfo, message: string) {
    super(message)
    this.name = 'TransientRateLimitError'
    this.rateLimit = rateLimit
  }
}

function parseRateLimit(res: Response): RateLimitInfo {
  const h = res.headers
  const num = (k: string): number | null => {
    const v = h.get(k)
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    status: res.status,
    remainingDaily: num('x-ratelimit-remaining-daily'),
    limitDaily: num('x-ratelimit-limit-daily'),
    resetEpoch: num('x-ratelimit-reset'),
    retryAfterSec: num('retry-after')
  }
}

// ─── Rate-limit safety (proactive 429 prevention on the Z.ai path) ──────────

/** Minimum gap between consecutive Z.ai calls, shared across all workers. */
const MIN_CALL_GAP_MS = 3000

/** Hard cap: at most this many Z.ai calls per rolling 60s window. */
const RATE_LIMIT_MAX_PER_WINDOW = 10
const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * Sliding-window rate limiter. Tracks call timestamps and blocks (via await)
 * until a slot is free. PROACTIVELY keeps us under the upstream limit so 429s
 * become rare; the reactive backoff below handles the few that slip through.
 */
class SlidingWindowLimiter {
  private timestamps: number[] = []
  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now()
      while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.windowMs) {
        this.timestamps.shift()
      }
      if (this.timestamps.length < this.max) {
        this.timestamps.push(now)
        return
      }
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 50
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

const zaiLimiter = new SlidingWindowLimiter(RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MS)

/** When a Z.ai 429 occurs, we set a global cooldown until this timestamp. */
let zaiRateLimitCooldownUntil = 0

/** Simple mutex so concurrent workers don't read/update the gap timestamp at once. */
let callGatePromise: Promise<void> | null = null
let lastZaiCallAt = 0

async function waitForZaiCallGate() {
  while (callGatePromise) await callGatePromise
  let releaseGate!: () => void
  callGatePromise = new Promise<void>((r) => {
    releaseGate = r
  })
  try {
    const cooldownLeft = zaiRateLimitCooldownUntil - Date.now()
    if (cooldownLeft > 0) {
      await new Promise((r) => setTimeout(r, cooldownLeft))
    }
    const gap = Math.max(0, MIN_CALL_GAP_MS - (Date.now() - lastZaiCallAt))
    if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    lastZaiCallAt = Date.now()
  } finally {
    callGatePromise = null
    releaseGate!()
  }
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof DailyQuotaExhaustedError || err instanceof TransientRateLimitError) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('429') ||
    /too many requests/i.test(msg) ||
    /rate[\s_-]?limit/i.test(msg)
  )
}

// ─── Z.ai primary call (direct fetch — bypasses SDK to read headers) ───────

interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Direct call to the Z.ai chat-completions endpoint. Captures the rate-limit
 * headers so we can classify a 429 as daily-exhausted (terminal → fallback)
 * vs transient (retryable). Returns the raw completion string.
 */
async function callZaiDirect(
  config: ZaiConfig,
  messages: LLMMessage[]
): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    'X-Z-AI-From': 'Z'
  }
  if (config.chatId) headers['X-Chat-Id'] = config.chatId
  if (config.userId) headers['X-User-Id'] = config.userId
  if (config.token) headers['X-Token'] = config.token

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, thinking: { type: 'disabled' } })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const rl = parseRateLimit(res)
    if (res.status === 429) {
      if (rl.remainingDaily === 0) {
        throw new DailyQuotaExhaustedError(rl)
      }
      throw new TransientRateLimitError(
        rl,
        `API request failed with status 429: ${body.slice(0, 120)}`
      )
    }
    throw new Error(`Z.ai API request failed with status ${res.status}: ${body.slice(0, 180)}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data?.choices?.[0]?.message?.content
  if (!content || !content.trim()) {
    throw new Error('Z.ai returned an empty response.')
  }
  return content
}

// ─── Cloudflare Workers AI fallback call ────────────────────────────────────

interface CloudflareFailure {
  ok: false
  status: number
  error: string
  transient: boolean
}
interface CloudflareSuccess {
  ok: true
  text: string
  model: string
}

/**
 * Call Cloudflare Workers AI text-generation endpoint.
 *
 * Response format (from the catalog/docs):
 *   { "success": true, "result": { "response": "<text>" }, "errors": [] }
 *
 * The `response` field contains the generated text. For chat-format models
 * (Llama 3.3 Instruct), the messages array is the standard OpenAI chat
 * format and the model returns a single completion string.
 *
 * Retry: 3 attempts with backoff on transient errors (429, 5xx, network).
 */
async function callCloudflareDirect(
  messages: LLMMessage[],
  opts?: { maxTokens?: number; temperature?: number; signalAbortMs?: number }
): Promise<CloudflareSuccess | CloudflareFailure> {
  if (!isCloudflareConfigured()) {
    return {
      ok: false,
      status: 0,
      error: 'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN not set',
      transient: false
    }
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_TEXT_MODEL}`
  const body: Record<string, unknown> = { messages }
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens
  if (typeof opts?.temperature === 'number') body.temperature = opts.temperature

  const controller = new AbortController()
  const timeoutMs = opts?.signalAbortMs ?? 90_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const transient =
        res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504
      return {
        ok: false,
        status: res.status,
        error: `Cloudflare HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
        transient
      }
    }

    const json = (await res.json()) as {
      success?: boolean
      result?: {
        response?: string | unknown[] | Record<string, unknown>
        choices?: Array<{ message?: { content?: string } }>
      }
      errors?: { message?: string }[]
    }
    if (!json.success) {
      const errMsg = json.errors?.[0]?.message || JSON.stringify(json).slice(0, 200)
      return { ok: false, status: 200, error: `Cloudflare success=false: ${errMsg}`, transient: false }
    }
    // Cloudflare's response shape varies by model + output type:
    //  - Plain text completion: result.response = "<string>"
    //  - Chat completion:       result.choices[0].message.content = "<string>"
    //                            (result.response MAY also exist as a PARSED
    //                             ARRAY/OBJECT when the model outputs JSON —
    //                             in that case result.response is NOT a string
    //                             and we must NOT use it; use choices[].message.content instead)
    // Prefer choices[0].message.content (the raw model output string, always
    // available for chat-format models like Llama 3.3 Instruct). Fall back to
    // result.response ONLY when it's a string (the plain-completion shape).
    const msgContent = json.result?.choices?.[0]?.message?.content
    const rawResponse = json.result?.response
    let text: string
    if (typeof msgContent === 'string' && msgContent.trim()) {
      text = msgContent
    } else if (typeof rawResponse === 'string') {
      text = rawResponse
    } else {
      // result.response is an array/object (parsed JSON output) — fall back to
      // JSON.stringify so the caller can still parse it themselves. This is
      // rare (we prefer choices[].message.content above) but defensive.
      text =
        rawResponse == null
          ? ''
          : typeof rawResponse === 'string'
            ? rawResponse
            : JSON.stringify(rawResponse)
    }
    if (!text.trim()) {
      return {
        ok: false,
        status: 200,
        error: 'Cloudflare returned an empty response',
        transient: true // Empty responses are often transient (cold start, etc.) — retry.
      }
    }
    return { ok: true, text: text.trim(), model: CF_TEXT_MODEL }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      error: aborted
        ? `Cloudflare timed out (${Math.round(timeoutMs / 1000)}s)`
        : `Cloudflare network: ${err instanceof Error ? err.message : String(err)}`,
      transient: true
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Groq (OpenAI-compatible) fallback call — third tier ────────────────────

interface GroqFailure {
  ok: false
  status: number
  error: string
  transient: boolean
}
interface GroqSuccess {
  ok: true
  text: string
  model: string
}

/**
 * Call Groq's OpenAI-compatible chat-completions endpoint.
 *
 * Endpoint: POST https://api.groq.com/openai/v1/chat/completions
 * Headers: Authorization: Bearer ${GROQ_API_KEY}
 * Body:    { model, messages, max_tokens?, temperature? }
 * Response: standard OpenAI shape:
 *   { choices: [{ message: { content: "<text>" } }] }
 *
 * Retry: 3 attempts with 2s*attempt backoff on transient errors (429, 5xx,
 * network). Groq's free tier (14,400 req/day) rarely rate-limits, and even
 * when it does, the wrapper's retry-queue (which wraps THIS call) re-runs
 * the whole chain — so a single Groq failure here does NOT fail the request.
 */
async function callGroqDirect(
  messages: LLMMessage[],
  opts?: { maxTokens?: number; temperature?: number; signalAbortMs?: number }
): Promise<GroqSuccess | GroqFailure> {
  if (!isGroqConfigured() || DISABLE_GROQ_GET()) {
    return {
      ok: false,
      status: 0,
      error: DISABLE_GROQ_GET()
        ? 'GROQ_API_KEY disabled via LLM_DISABLE_GROQ (or runtime override)'
        : 'GROQ_API_KEY not set',
      transient: false
    }
  }

  const body: Record<string, unknown> = { model: GROQ_MODEL, messages }
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens
  if (typeof opts?.temperature === 'number') body.temperature = opts.temperature

  const controller = new AbortController()
  const timeoutMs = opts?.signalAbortMs ?? 90_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(GROQ_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const transient =
        res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504
      return {
        ok: false,
        status: res.status,
        error: `Groq HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
        transient
      }
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = json?.choices?.[0]?.message?.content
    if (!content || !content.trim()) {
      return {
        ok: false,
        status: 200,
        error: 'Groq returned an empty response',
        transient: true
      }
    }
    return { ok: true, text: content.trim(), model: GROQ_MODEL }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      error: aborted
        ? `Groq timed out (${Math.round(timeoutMs / 1000)}s)`
        : `Groq network: ${err instanceof Error ? err.message : String(err)}`,
      transient: true
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Wrapper result + options ───────────────────────────────────────────────

export interface CallLLMOptions {
  /**
   * Max attempts on the Z.ai primary path BEFORE falling back to Cloudflare.
   * Default 3. Each Z.ai retry uses jittered exponential backoff on transient
   * 429s. A DailyQuotaExhaustedError aborts the Z.ai path immediately (no
   * retry) and triggers the Cloudflare fallback.
   */
  zaiMaxAttempts?: number
  /**
   * Max attempts on the Cloudflare fallback path. Default 3. Each retry uses
   * 2s * attempt backoff. Cloudflare rarely rate-limits within the free tier
   * (10k neurons/day), so most failures are transient network/cold-start.
   */
  cloudflareMaxAttempts?: number
  /**
   * Max attempts on the Groq third-tier fallback path. Default 2. Groq's
   * free tier (14,400 req/day) rarely rate-limits, so we use a tighter
   * retry count — the smart retry-queue (which wraps the whole chain) is
   * the real safety net, not per-tier retries.
   */
  groqMaxAttempts?: number
  /** Max output tokens for the Cloudflare + Groq calls (Z.ai path doesn't use this). */
  maxTokens?: number
  /** Temperature for the Cloudflare + Groq calls (default 0.7). */
  temperature?: number
  /**
   * When true (default), a Z.ai DailyQuotaExhaustedError triggers an immediate
   * Cloudflare fallback. When false, the error propagates (used by callers
   * that want to surface the daily-quota message directly without fallback).
   */
  fallbackOnQuotaExhausted?: boolean
  /** Abort timeout for the Cloudflare + Groq calls (default 90s). */
  cloudflareAbortMs?: number
  /** Caller label for logs (e.g. "rewrite", "title-card", "image-prompts"). */
  tag?: string
  /**
   * Called when ALL 3 tiers fail in a single pass and the smart retry-queue
   * kicks in. The callback receives the round number (1-indexed), the max
   * rounds, the wait time in ms, the human-readable retry-in-seconds, and
   * the last error from all 3 tiers. Callers (e.g. /api/rewrite) use this to
   * surface "Waiting for AI capacity, retrying in Xs..." to the polling UI
   * INSTEAD of throwing a "very busy" error — the request is still in
   * flight, just queued.
   */
  onWait?: (info: {
    round: number
    maxRounds: number
    waitMs: number
    retryInSecs: number
    lastError: string
  }) => void
}

export interface CallLLMResult {
  text: string
  provider: 'zai' | 'cloudflare' | 'groq'
  model: string
  /** How many Z.ai attempts were made before success/fallback. */
  zaiAttempts: number
  /** How many Cloudflare attempts were made before success. */
  cloudflareAttempts: number
  /** How many Groq attempts were made before success. */
  groqAttempts: number
  /** True if Z.ai failed and a fallback (Cloudflare or Groq) produced the result. */
  fellBackToCloudflare: boolean
  /** True if both Z.ai AND Cloudflare failed and Groq produced the result. */
  fellBackToGroq: boolean
  /** True if the retry-queue ran at least once (all 3 tiers failed initially). */
  usedRetryQueue: boolean
  /** Number of retry-queue rounds that ran (0 if the request succeeded on the first chain pass). */
  retryQueueRounds: number
}

/**
 * ─── The shared LLM wrapper (3-tier chain + smart retry-queue) ──────────────
 *
 * CALL FLOW:
 *
 *   ┌─ round 0 (the initial chain pass) ──────────────────────────────────┐
 *   │  TIER 1: Z.ai (3 retries, exponential backoff on transient 429)    │
 *   │     ↓ on quota-exhausted or persistent 429                          │
 *   │  TIER 2: Cloudflare Workers AI (3 retries, 2s*attempt backoff)     │
 *   │     ↓ on transient failure / not-configured                          │
 *   │  TIER 3: Groq (2 retries, 2s*attempt backoff)                      │
 *   │     ↓ on all three tiers failing                                     │
 *   └──────────────────────────────────────────────────────────────────────┘
 *                    ↓ enter smart retry-queue
 *   ┌─ retry-queue (max RETRY_QUEUE_MAX_ROUNDS rounds) ───────────────────┐
 *   │  wait 15s → re-run whole chain (Z.ai → Cloudflare → Groq)           │
 *   │  wait 30s → re-run whole chain                                       │
 *   │  wait 60s → re-run whole chain                                       │
 *   │  wait 2min → re-run whole chain  (×3 more rounds)                    │
 *   │  on any single tier succeeding → return result immediately           │
 *   │  on all rounds exhausted → throw friendly error                     │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The `onWait` callback fires BEFORE each retry-queue sleep so callers can
 * surface "Waiting for AI capacity, retrying in Xs..." to the UI (instead
 * of throwing a "very busy" error — the request is still in flight, just
 * queued waiting for any of the 3 tiers to recover).
 *
 * Both `systemPrompt` + `userContent` and `messages` are accepted (the former
 * is a convenience for single-turn calls; the latter for multi-turn / no-system
 * calls). If both are provided, `messages` wins.
 */
export async function callLLM(
  args: {
    systemPrompt?: string
    userContent?: string
    messages?: LLMMessage[]
  },
  options: CallLLMOptions = {}
): Promise<CallLLMResult> {
  const tag = options.tag || 'llm'
  const zaiMaxAttempts = options.zaiMaxAttempts ?? 3
  const cloudflareMaxAttempts = options.cloudflareMaxAttempts ?? 3
  const groqMaxAttempts = options.groqMaxAttempts ?? 2
  const fallbackOnQuota = options.fallbackOnQuotaExhausted ?? true

  // Normalize messages.
  let messages: LLMMessage[]
  if (args.messages && args.messages.length > 0) {
    messages = args.messages
  } else if (args.systemPrompt && args.userContent) {
    messages = [
      { role: 'assistant', content: args.systemPrompt },
      { role: 'user', content: args.userContent }
    ]
  } else if (args.userContent) {
    messages = [{ role: 'user', content: args.userContent }]
  } else {
    throw new Error('callLLM: must provide either messages, or systemPrompt + userContent, or userContent')
  }

  // ── Single chain pass: Z.ai → Cloudflare → Groq ──
  //
  // Returns the result on success, or a structured failure summary that the
  // retry-queue outer loop uses for the `onWait` callback + final error.
  type ChainFailure = {
    ok: false
    zaiAttempts: number
    zaiReason: string
    cloudflareAttempts: number
    cfLastError: string
    groqAttempts: number
    groqLastError: string
  }
  type ChainSuccess = CallLLMResult
  type ChainResult = ChainSuccess | ChainFailure

  async function attemptChainOnce(): Promise<ChainResult> {
    // ── TIER 1: Z.ai primary path ──
    let zaiAttempts = 0
    let zaiFailureReason:
      | 'quota-exhausted'
      | 'transient-rate-limit'
      | 'other'
      | 'no-config'
      | 'disabled'
      | 'skipped'
      = 'other'
    let zaiLastError: Error | null = null

    if (DISABLE_ZAI_GET()) {
      zaiFailureReason = 'disabled'
      // No log here — too noisy on every retry-queue round. Logged once at the
      // queue entry below.
    } else {
      try {
        const config = await loadZaiConfig()
        // Spin a fresh X-Chat-Id per call so each gets its own chat bucket (the
        // default config's chatId is shared with the active IM session).
        config.chatId = `${tag}-${randomUUID()}`

        for (let attempt = 1; attempt <= zaiMaxAttempts; attempt++) {
          try {
            // Proactive cap: never exceed RATE_LIMIT_MAX_PER_WINDOW calls per 60s.
            await zaiLimiter.acquire()
            await waitForZaiCallGate()

            zaiAttempts = attempt
            const raw = await callZaiDirect(config, messages)
            if (!raw || !raw.trim()) {
              throw new Error('Z.ai returned an empty response.')
            }
            return {
              text: raw,
              provider: 'zai',
              model: 'zai-bundled',
              zaiAttempts: attempt,
              cloudflareAttempts: 0,
              groqAttempts: 0,
              fellBackToCloudflare: false,
              fellBackToGroq: false,
              usedRetryQueue: false,
              retryQueueRounds: 0
            }
          } catch (err) {
            zaiLastError = err instanceof Error ? err : new Error(String(err))

            if (err instanceof DailyQuotaExhaustedError) {
              // Hard daily-quota exhaustion: abort the Z.ai path immediately.
              // Do NOT retry — futile, and rejected calls still burn user-daily.
              zaiFailureReason = 'quota-exhausted'
              console.error(
                `[llm-wrapper:${tag}] Z.ai daily quota exhausted (limit=${err.rateLimit.limitDaily}, remaining=0) — falling back to Cloudflare.`
              )
              break
            }

            if (err instanceof TransientRateLimitError || isRateLimitError(err)) {
              zaiFailureReason = 'transient-rate-limit'
              const base = Math.min(30_000, 5_000 * Math.pow(2, attempt - 1))
              const jitter = Math.random() * 1_000
              const wait = base + jitter
              zaiRateLimitCooldownUntil = Date.now() + wait
              console.error(
                `[llm-wrapper:${tag}] Z.ai attempt ${attempt}/${zaiMaxAttempts} transient rate-limit; backing off ${Math.round(wait)}ms`
              )
              if (attempt < zaiMaxAttempts) {
                await new Promise((r) => setTimeout(r, wait))
              }
            } else {
              console.error(
                `[llm-wrapper:${tag}] Z.ai attempt ${attempt}/${zaiMaxAttempts} failed:`,
                zaiLastError.message
              )
              if (attempt < zaiMaxAttempts) {
                await new Promise((r) => setTimeout(r, 1_200 * attempt))
              }
            }
          }
        }
      } catch (err) {
        // loadZaiConfig() threw — no Z.ai config available.
        zaiLastError = err instanceof Error ? err : new Error(String(err))
        zaiFailureReason = 'no-config'
        console.error(
          `[llm-wrapper:${tag}] Z.ai config load failed — falling back to Cloudflare:`,
          zaiLastError.message
        )
      }
    }

    // ── Decide whether to fall back to Cloudflare ──
    if (
      !fallbackOnQuota &&
      zaiFailureReason === 'quota-exhausted' &&
      zaiLastError instanceof DailyQuotaExhaustedError
    ) {
      // Caller asked NOT to fall back on quota exhaustion (rare — used when the
      // caller wants to surface the daily-quota message directly). We still
      // propagate via the structured failure so the retry-queue doesn't kick
      // in (the wrapper contract for this mode is "fail fast").
      throw zaiLastError
    }

    // ── TIER 2: Cloudflare fallback path ──
    let cloudflareAttempts = 0
    let cfLastError = ''

    for (let attempt = 1; attempt <= cloudflareMaxAttempts; attempt++) {
      cloudflareAttempts = attempt
      const result = await callCloudflareDirect(messages, {
        maxTokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        signalAbortMs: options.cloudflareAbortMs
      })

      if (result.ok) {
        console.log(
          `[llm-wrapper:${tag}] Cloudflare attempt ${attempt}/${cloudflareMaxAttempts} succeeded (${result.text.length} chars, model=${result.model}) after Z.ai failed (reason=${zaiFailureReason}, attempts=${zaiAttempts}).`
        )
        return {
          text: result.text,
          provider: 'cloudflare',
          model: result.model,
          zaiAttempts,
          cloudflareAttempts: attempt,
          groqAttempts: 0,
          fellBackToCloudflare: true,
          fellBackToGroq: false,
          usedRetryQueue: false,
          retryQueueRounds: 0
        }
      }

      cfLastError = result.error
      const shouldRetry = result.transient && attempt < cloudflareMaxAttempts
      console.error(
        `[llm-wrapper:${tag}] Cloudflare attempt ${attempt}/${cloudflareMaxAttempts} failed (HTTP ${result.status}): ${result.error.slice(0, 140)}`
      )
      if (!shouldRetry) break
      await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }

    // ── TIER 3: Groq fallback path (third tier) ──
    let groqAttempts = 0
    let groqLastError = ''

    for (let attempt = 1; attempt <= groqMaxAttempts; attempt++) {
      groqAttempts = attempt
      const result = await callGroqDirect(messages, {
        maxTokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        signalAbortMs: options.cloudflareAbortMs
      })

      if (result.ok) {
        console.log(
          `[llm-wrapper:${tag}] Groq attempt ${attempt}/${groqMaxAttempts} succeeded (${result.text.length} chars, model=${result.model}) after Z.ai + Cloudflare failed.`
        )
        return {
          text: result.text,
          provider: 'groq',
          model: result.model,
          zaiAttempts,
          cloudflareAttempts,
          groqAttempts: attempt,
          fellBackToCloudflare: false,
          fellBackToGroq: true,
          usedRetryQueue: false,
          retryQueueRounds: 0
        }
      }

      groqLastError = result.error
      const shouldRetry = result.transient && attempt < groqMaxAttempts
      console.error(
        `[llm-wrapper:${tag}] Groq attempt ${attempt}/${groqMaxAttempts} failed (HTTP ${result.status}): ${result.error.slice(0, 140)}`
      )
      if (!shouldRetry) break
      await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }

    // ── All 3 tiers failed in this chain pass — return structured failure ──
    const zaiReasonStr =
      zaiFailureReason === 'quota-exhausted'
        ? 'daily quota exhausted'
        : zaiFailureReason === 'transient-rate-limit'
          ? 'rate-limited'
          : zaiFailureReason === 'no-config'
            ? 'config unavailable'
            : zaiFailureReason === 'disabled'
              ? 'disabled (test toggle)'
              : zaiFailureReason === 'skipped'
                ? 'skipped'
                : `error: ${zaiLastError?.message.slice(0, 100) || 'unknown'}`

    return {
      ok: false,
      zaiAttempts,
      zaiReason: zaiReasonStr,
      cloudflareAttempts,
      cfLastError,
      groqAttempts,
      groqLastError
    }
  }

  // ── Smart retry-queue: re-run the whole chain up to RETRY_QUEUE_MAX_ROUNDS ──
  let retryQueueRounds = 0
  let lastFailure: ChainFailure | null = null

  while (true) {
    const result = await attemptChainOnce()
    if ('text' in result) {
      // Success — if we ran the retry-queue at least once, mark it.
      if (retryQueueRounds > 0) {
        return {
          ...result,
          usedRetryQueue: true,
          retryQueueRounds
        }
      }
      return result
    }
    lastFailure = result

    // All 3 tiers failed in this round. Decide whether to enter / continue
    // the retry-queue.
    if (retryQueueRounds >= RETRY_QUEUE_MAX_ROUNDS) {
      // Retry-queue exhausted — throw the friendly, user-facing error.
      const f = lastFailure
      const cloudflareConfiguredStr =
        isCloudflareConfigured() && !DISABLE_CLOUDFLARE_GET() ? '' : ' (Cloudflare credentials not set or disabled)'
      const groqConfiguredStr =
        isGroqConfigured() && !DISABLE_GROQ_GET() ? '' : ' (Groq API key not set or disabled)'
      throw new Error(
        `All 3 LLM providers failed after ${RETRY_QUEUE_MAX_ROUNDS} retry-queue rounds (waited ~${Math.round(
          RETRY_QUEUE_BACKOFF_MS.reduce((a, b) => a + b, 0) / 1000
        )}s total). Z.ai: ${f.zaiReason}. Cloudflare (${CF_TEXT_MODEL}): ${f.cfLastError.slice(0, 100)}${cloudflareConfiguredStr}. Groq (${GROQ_MODEL}): ${f.groqLastError.slice(0, 100)}${groqConfiguredStr}. The AI services may be temporarily overloaded — please try again in a few minutes.`
      )
    }

    // Enter / continue the retry-queue. Compute the wait time for THIS round
    // (round 1 = first backoff slot, etc.) and fire the onWait callback so
    // callers can surface "Waiting for AI capacity, retrying in Xs..." to
    // the UI BEFORE the sleep starts.
    retryQueueRounds++
    const waitMs = RETRY_QUEUE_BACKOFF_MS[retryQueueRounds - 1]
    const retryInSecs = Math.round(waitMs / 1000)
    const f = lastFailure
    const lastErrorSummary = `Z.ai: ${f.zaiReason}; Cloudflare: ${f.cfLastError.slice(0, 80)}; Groq: ${f.groqLastError.slice(0, 80)}`

    console.warn(
      `[llm-wrapper:${tag}] All 3 tiers failed (round ${retryQueueRounds}/${RETRY_QUEUE_MAX_ROUNDS}). Entering retry-queue: waiting ${retryInSecs}s before re-running the whole chain. Last errors: ${lastErrorSummary}`
    )

    if (options.onWait) {
      try {
        options.onWait({
          round: retryQueueRounds,
          maxRounds: RETRY_QUEUE_MAX_ROUNDS,
          waitMs,
          retryInSecs,
          lastError: lastErrorSummary
        })
      } catch (cbErr) {
        // The onWait callback should never throw, but if it does, log + continue.
        console.error(`[llm-wrapper:${tag}] onWait callback threw:`, cbErr)
      }
    }

    await new Promise((r) => setTimeout(r, waitMs))
    // Loop back to attemptChainOnce() — fresh chain pass from Z.ai.
  }
}

/**
 * Convenience: a calm, user-facing sentence for any error thrown by callLLM.
 * Never surfaces raw 429 JSON or stack traces to the UI.
 */
export function friendlyLLMError(err: unknown): string {
  if (err instanceof DailyQuotaExhaustedError) {
    const rl = err.rateLimit
    const limitStr =
      rl.limitDaily != null ? ` (0 of ${rl.limitDaily} daily requests left)` : ''
    return `The AI service's daily request quota is used up${limitStr}. Please try again later when the quota resets.`
  }
  if (err instanceof TransientRateLimitError || isRateLimitError(err)) {
    return 'The AI service is very busy right now. Please wait a moment and try again.'
  }
  const msg = err instanceof Error && err.message ? err.message : String(err)
  if (/All 3 LLM providers failed after .* retry-queue rounds/i.test(msg)) {
    // The retry-queue ran to completion (6 rounds, ~6min) and still failed.
    // This is the only path that should EVER surface "all providers failed"
    // to the user — and only after extensive automatic retrying.
    return 'All AI providers are temporarily overloaded after extensive automatic retrying. Please try again in a few minutes.'
  }
  if (/Both LLM providers failed/i.test(msg)) {
    // Legacy message — kept for backward compat with any caller that bypassed
    // the retry-queue. Should be unreachable now (callLLM always enters the
    // retry-queue instead of throwing "Both LLM providers failed" directly).
    return 'Both the primary and backup AI services failed. Please try again in a minute.'
  }
  if (/empty response/i.test(msg)) {
    return 'The AI returned an empty response. Please try again.'
  }
  if (/could not be parsed/i.test(msg)) {
    return 'The AI response could not be parsed. Please try again.'
  }
  if (/Cloudflare credentials not set/i.test(msg)) {
    return 'The backup AI service is not configured. Please add CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN to .env.'
  }
  if (/GROQ_API_KEY not set/i.test(msg)) {
    return 'The third-tier AI service (Groq) is not configured. Please add GROQ_API_KEY to .env for maximum resilience.'
  }
  return `The AI service failed. Please try again. (Details: ${msg.slice(0, 140)})`
}

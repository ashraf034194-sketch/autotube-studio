import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import {
  callLLM,
  friendlyLLMError,
  DailyQuotaExhaustedError
} from '@/lib/llm-wrapper'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_CHARS = 50
const MAX_CHARS = 20000

/** Target size of each section sent to the LLM separately (larger = fewer API calls). */
const SECTION_TARGET_CHARS = 1400

/** Section overlap above this triggers one aggressive re-rewrite attempt. */
const SECTION_OVERLAP_LIMIT = 32

/**
 * How many sections the LLM rewrites concurrently.
 * 1 = strictly sequential — the safest choice to stay under upstream rate limits.
 */
const CONCURRENCY = 1

/** Finished jobs are kept for this long, then garbage-collected. */
//
// 30 minutes — bumped from 10min to fit the smart retry-queue's worst case.
// The retry-queue can wait up to ~8min per LLM call (6 rounds × 2min cap) when
// all 3 tiers (Z.ai + Cloudflare + Groq) are simultaneously overloaded. For a
// script with 2-3 sections, that's 16-24min in the pathological worst case —
// 30min TTL gives a comfortable headroom while still reclaiming memory for
// abandoned jobs. In practice the queue rarely runs more than 1-2 rounds.
const JOB_TTL_MS = 30 * 60 * 1000

const SYSTEM_PROMPT = `You are an expert script doctor who rewrites video transcripts into completely fresh, original scripts.

ABSOLUTE RULES:
1. MEANING: Preserve every key point, fact, example, and the overall message. Do not invent new facts. Do not drop important ideas.
2. WORDING: The rewrite must be a genuinely NEW text. You must:
   - Replace terminology and key phrases with synonyms wherever possible (e.g. "habit loop" → "behavioral cycle", "trigger" → "prompt", "brain's reward system" → "mind's pleasure circuitry").
   - Rebuild every sentence from scratch with different grammar and structure. NEVER copy a run of 3+ consecutive words from the source (proper nouns and numbers excepted).
   - Reorder and merge/split ideas within the section when it does not damage logic.
   - Vary sentence lengths and rhythm so it reads like a different author.
3. STYLE: Natural, engaging spoken-narration style for a YouTube audience.
4. LENGTH: Stay within ±15% of the section's length.
5. FORMAT: Output ONLY the rewritten section as plain narration text. No titles, headings, timestamps, bullet points, markdown, preamble ("Here is..."), or commentary.

A lazy near-copy is a FAILURE. If any sentence survives nearly unchanged, you have failed the task.`

const RETRY_PROMPT_SUFFIX = `\n\nIMPORTANT: Your previous attempt was rejected because it reused too much of the original vocabulary and phrasing. This time be far more aggressive: change nearly every content word to a synonym or completely different expression, restructure every sentence, and use different terminology for the key concepts. The result must read like an independent author covering the same ideas.`

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'that', 'this', 'it', 'as', 'you',
  'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'not', 'do',
  'does', 'did', 'so', 'if', 'then', 'than', 'from', 'by', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'its', 'about', 'into', 'over', 'after',
  'before', 'what', 'when', 'how', 'why', 'all', 'any', 'each', 'just', 'also',
  'more', 'most', 'some', 'such', 'no', 'nor', 'only', 'own', 'same', 'too',
  'very', 'now', 'there', 'here', 'out', 'up', 'down', 'again', 'get', 'got',
  'like', 'want', 'make', 'them', 'they', 'who', 'which'
])

// ─── Job store (in-memory; survives across requests in the server process) ────

interface RewriteJobResult {
  rewritten: string
  originalWordCount: number
  rewrittenWordCount: number
  sectionCount: number
  vocabularyOverlap: number
}

interface RewriteJob {
  id: string
  status: 'processing' | 'waiting' | 'done' | 'error'
  createdAt: number
  totalSections: number
  completedSections: number
  result?: RewriteJobResult
  error?: string
  // ── Retry-queue waiting state ──
  // When the LLM wrapper enters its smart retry-queue (all 3 tiers — Z.ai,
  // Cloudflare, Groq — momentarily overloaded), it fires onWait. We persist
  // the latest wait info here so the polling GET handler can surface
  // "Waiting for AI capacity, retrying in Xs..." to the UI INSTEAD of an
  // error. The job stays in 'waiting' status until either the queue produces
  // a successful result (→ 'done') or the queue is exhausted (→ 'error').
  waiting?: {
    round: number
    maxRounds: number
    retryInSecs: number
    // Epoch-ms when the current wait started — used by the UI to render a
    // live countdown without polling the server every second.
    startedAt: number
    // Epoch-ms when the current wait will end (startedAt + retryInSecs*1000).
    endsAt: number
    lastError: string
  }
}

const jobs = new Map<string, RewriteJob>()

function cleanupExpiredJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

/** Stopword-filtered unigram Jaccard — same metric shown in the UI. Lower = more original. */
function vocabularyOverlap(a: string, b: string): number {
  const extract = (t: string) =>
    new Set(
      (t.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
        (w) => !STOPWORDS.has(w) && w.length > 2
      )
    )
  const wa = extract(a)
  const wb = extract(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0
  wa.forEach((w) => {
    if (wb.has(w)) inter++
  })
  const union = new Set([...wa, ...wb]).size
  return Math.round((inter / union) * 100)
}

/** Clean up common LLM artifacts: code fences, preambles, wrapping quotes. */
function cleanRewrittenText(raw: string): string {
  let text = raw.trim()

  const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const lines = text.split('\n')
  if (lines.length > 1) {
    const first = lines[0].trim().toLowerCase()
    const preamblePatterns = [
      /^(here'?s|here is) (the |your |a )?(rewritten|paraphrased|new)?.*(script|version|section|transcript)[:.]?$/,
      /^(rewritten|paraphrased) (script|version|section|transcript)[:.]?$/,
      /^sure[,!]?\s*(here'?s|here is).*(script|version)[:.]?$/
    ]
    if (preamblePatterns.some((p) => p.test(first))) {
      lines.shift()
      text = lines.join('\n').trim()
    }
  }

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim()
  }

  return text
}

/**
 * Split the transcript into LLM-sized sections. Prefers paragraph boundaries,
 * then sentence boundaries, so each section is a coherent chunk of meaning.
 */
function splitIntoSections(text: string, target = SECTION_TARGET_CHARS): string[] {
  const normalized = text.trim()
  if (normalized.length <= target * 1.25) return [normalized]

  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const sections: string[] = []
  let current = ''

  const flush = () => {
    if (current.trim()) sections.push(current.trim())
    current = ''
  }

  for (const para of paragraphs) {
    if (para.length > target * 1.5) {
      flush()
      const sentences = para.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [para]
      let piece = ''
      for (const s of sentences) {
        if ((piece + s).length > target) {
          if (piece.trim()) sections.push(piece.trim())
          piece = s
        } else {
          piece += s
        }
      }
      if (piece.trim()) sections.push(piece.trim())
      continue
    }
    if ((current + '\n\n' + para).trim().length <= target) {
      current = current ? `${current}\n\n${para}` : para
    } else {
      flush()
      current = para
    }
  }
  flush()

  return sections.filter((s) => s.length > 0)
}

// ─── LLM call (shared wrapper: Z.ai → Cloudflare → Groq + retry-queue) ──────
//
// The wrapper lives at src/lib/llm-wrapper.ts. It tries Z.ai first (direct
// fetch + rate-limit header parsing — DailyQuotaExhaustedError aborts the
// Z.ai path immediately and triggers the Cloudflare fallback). When Z.ai's
// bundled daily quota is exhausted (the condition that broke Script Rewrite
// for the user), the wrapper falls through to:
//   TIER 2: Cloudflare Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast
//           — 70B params, fp8 quantized, 24k context, genuinely free 10k
//           neurons/day, no card)
//   TIER 3: Groq (OpenAI-compatible, llama-3.3-70b-versatile default,
//           14,400 req/day free, no card, independent infra)
// And if ALL 3 tiers fail in a single pass, the wrapper enters a smart
// retry-queue (exponential backoff 15s → 30s → 60s → 2min × 3, max 6 rounds
// ≈ 8min total) that re-runs the whole chain. The `onWait` callback below
// persists the wait info onto the job so the polling GET handler can surface
// "Waiting for AI capacity, retrying in Xs..." to the UI INSTEAD of an error
// — the user NEVER sees "very busy" anymore, only a live waiting countdown.

/**
 * One LLM call to rewrite a single section. Returns the cleaned text.
 *
 * The `job` parameter is required: the function persists retry-queue wait
 * state onto it (job.status='waiting' + job.waiting={...}) so the polling
 * GET handler can render the live countdown in the UI. When the LLM call
 * completes (success or final failure), the caller restores job.status to
 * 'processing' so the UI flips back to the regular progress bar.
 *
 * On Z.ai quota exhaustion or persistent 429, transparently falls back to
 * Cloudflare → Groq → retry-queue — the caller never needs to know which
 * provider answered (or that the queue ran at all).
 */
async function callRewriteLLM(
  section: string,
  aggressive: boolean,
  job: RewriteJob
): Promise<string> {
  const userContent = aggressive
    ? `Rewrite the following section into an original script.\n${RETRY_PROMPT_SUFFIX}\n\n---SECTION START---\n${section}\n---SECTION END---`
    : `Rewrite the following section of a video transcript into an original script. Remember: same meaning, completely different wording and terminology, natural spoken narration.\n\n---SECTION START---\n${section}\n---SECTION END---`

  const result = await callLLM(
    { systemPrompt: SYSTEM_PROMPT, userContent },
    {
      tag: aggressive ? 'rewrite-aggressive' : 'rewrite',
      zaiMaxAttempts: 3,
      cloudflareMaxAttempts: 3,
      groqMaxAttempts: 2,
      maxTokens: 1800, // Llama 3.3 70B output cap — generous for a ~1400-char section rewrite.
      temperature: 0.7,
      // Persist every retry-queue entry onto the job so the polling UI can
      // render a live countdown. The callback fires BEFORE the queue sleeps,
      // so by the time the next GET poll arrives (1.5s later) the job is
      // already in 'waiting' status with the wait ETA populated.
      onWait: (info) => {
        const now = Date.now()
        job.status = 'waiting'
        job.waiting = {
          round: info.round,
          maxRounds: info.maxRounds,
          retryInSecs: info.retryInSecs,
          startedAt: now,
          endsAt: now + info.waitMs,
          lastError: info.lastError
        }
        console.log(
          `[rewrite] Job ${job.id} entered retry-queue (round ${info.round}/${info.maxRounds}); waiting ${info.retryInSecs}s. Last error: ${info.lastError}`
        )
      }
    }
  )

  // LLM call returned — clear the waiting state + restore processing status
  // so the UI flips back to the regular progress bar.
  if (job.status === 'waiting') {
    job.status = 'processing'
    job.waiting = undefined
  }

  if (result.fellBackToCloudflare) {
    console.log(
      `[rewrite] Section used Cloudflare fallback (model=${result.model}, zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}).`
    )
  } else if (result.fellBackToGroq) {
    console.log(
      `[rewrite] Section used Groq fallback (model=${result.model}, zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}, groqAttempts=${result.groqAttempts}).`
    )
  }
  if (result.usedRetryQueue) {
    console.log(
      `[rewrite] Section succeeded after retry-queue (rounds=${result.retryQueueRounds}, provider=${result.provider}).`
    )
  }

  const cleaned = cleanRewrittenText(result.text)
  if (countWords(cleaned) < 3) {
    throw new Error('The AI response could not be parsed.')
  }
  return cleaned
}

/**
 * Rewrite a single section: first pass, then an aggressive re-rewrite if the
 * overlap quality gate fails. Raises on unrecoverable errors.
 */
async function rewriteSectionWithQualityGate(
  section: string,
  job: RewriteJob
): Promise<string> {
  let result = await callRewriteLLM(section, false, job)

  const overlap = vocabularyOverlap(section, result)
  if (overlap > SECTION_OVERLAP_LIMIT) {
    try {
      const aggressiveResult = await callRewriteLLM(section, true, job)
      const aggressiveOverlap = vocabularyOverlap(section, aggressiveResult)
      if (
        aggressiveOverlap < overlap &&
        countWords(aggressiveResult) >= countWords(section) * 0.55
      ) {
        result = aggressiveResult
      }
    } catch (err) {
      console.error('[rewrite] Aggressive retry failed (keeping first pass):', err)
    }
  }

  return result
}

/**
 * Background job processor: rewrites sections with CONCURRENCY parallel workers
 * and streams progress into the job record. Never throws — stores the error.
 */
async function processJob(job: RewriteJob, transcript: string, sections: string[]) {
  try {
    const results: string[] = new Array(sections.length)
    let nextIndex = 0

    const worker = async () => {
      while (true) {
        const i = nextIndex
        if (i >= sections.length) return
        nextIndex++

        results[i] = await rewriteSectionWithQualityGate(sections[i], job)
        job.completedSections++
      }
    }

    // CONCURRENCY workers processing sections in parallel
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

    const rewritten = results.join('\n\n')
    const overallOverlap = vocabularyOverlap(transcript, rewritten)

    job.result = {
      rewritten,
      originalWordCount: countWords(transcript),
      rewrittenWordCount: countWords(rewritten),
      sectionCount: sections.length,
      vocabularyOverlap: overallOverlap
    }
    job.status = 'done'
    console.log(
      `[rewrite] Job ${job.id} done: ${sections.length} sections, overlap ${overallOverlap}%, ${job.result.originalWordCount}→${job.result.rewrittenWordCount} words`
    )
  } catch (error) {
    job.status = 'error'
    // Clear any lingering wait state — the job is now in terminal 'error' status.
    job.waiting = undefined
    // Always store a calm, user-facing sentence (never raw 429 JSON).
    job.error = friendlyLLMError(error)
    console.error(`[rewrite] Job ${job.id} failed:`, error instanceof Error ? error.message : error)
  }
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/rewrite — starts an async rewrite job and returns the jobId
 * immediately. Long scripts never hold the HTTP connection open, so gateway
 * timeouts are impossible.
 */
export async function POST(req: NextRequest) {
  try {
    cleanupExpiredJobs()

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request: request body must be valid JSON.' },
        { status: 400 }
      )
    }

    const { transcript } = (body ?? {}) as { transcript?: string }

    // ── Validation ──
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return NextResponse.json(
        { success: false, error: 'Transcript is required. Please provide the transcript text you want to rewrite.' },
        { status: 400 }
      )
    }
    if (transcript.trim().length < MIN_CHARS) {
      return NextResponse.json(
        { success: false, error: `Transcript is too short. Please provide at least ${MIN_CHARS} characters of transcript text.` },
        { status: 400 }
      )
    }
    if (transcript.length > MAX_CHARS) {
      return NextResponse.json(
        { success: false, error: `Transcript is too long (${transcript.length} characters). Maximum allowed is ${MAX_CHARS.toLocaleString()} characters.` },
        { status: 400 }
      )
    }

    const sections = splitIntoSections(transcript.trim())
    if (sections.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Could not extract any rewritable text from the transcript.' },
        { status: 400 }
      )
    }

    const job: RewriteJob = {
      id: randomUUID(),
      status: 'processing',
      createdAt: Date.now(),
      totalSections: sections.length,
      completedSections: 0
    }
    jobs.set(job.id, job)

    // Fire-and-forget background processing (never blocks the response)
    void processJob(job, transcript.trim(), sections)

    console.log(`[rewrite] Job ${job.id} started: ${sections.length} sections, ${transcript.length} chars`)

    return NextResponse.json({
      success: true,
      data: { jobId: job.id, totalSections: sections.length }
    })
  } catch (error) {
    console.error('[rewrite] Unexpected error:', error)
    return NextResponse.json(
      {
        success: false,
        error: friendlyLLMError(error)
      },
      { status: 502 }
    )
  }
}

/**
 * GET /api/rewrite?jobId=... — poll endpoint for job progress / result.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')

  if (!jobId) {
    return NextResponse.json(
      { success: false, error: 'Missing jobId query parameter.' },
      { status: 400 }
    )
  }

  const job = jobs.get(jobId)
  if (!job) {
    return NextResponse.json(
      {
        success: false,
        error: 'Rewrite job not found. It may have expired (jobs are kept for 30 minutes) — please start again.'
      },
      { status: 404 }
    )
  }

  if (job.status === 'processing') {
    return NextResponse.json({
      success: true,
      data: {
        status: 'processing',
        completedSections: job.completedSections,
        totalSections: job.totalSections
      }
    })
  }

  if (job.status === 'waiting') {
    // The LLM wrapper entered its smart retry-queue (all 3 tiers — Z.ai,
    // Cloudflare, Groq — momentarily overloaded). The job is NOT failed —
    // it's waiting for any tier to recover. Surface a clear "waiting"
    // status with a live countdown ETA so the UI can render
    // "Waiting for AI capacity, retrying in Xs..." instead of an error.
    //
    // We pass both `retryInSecs` (the original wait) and `endsAt` (epoch-ms
    // when the wait elapses) so the UI can compute a precise live countdown
    // without polling the server every second.
    const w = job.waiting
    const now = Date.now()
    const remainingSecs = w ? Math.max(0, Math.round((w.endsAt - now) / 1000)) : 0
    return NextResponse.json({
      success: true,
      data: {
        status: 'waiting',
        completedSections: job.completedSections,
        totalSections: job.totalSections,
        waiting: w
          ? {
              round: w.round,
              maxRounds: w.maxRounds,
              retryInSecs: w.retryInSecs,
              retryInSecsRemaining: remainingSecs,
              startedAt: w.startedAt,
              endsAt: w.endsAt,
              lastError: w.lastError
            }
          : null
      }
    })
  }

  if (job.status === 'error') {
    // Job consumed — clean it up. job.error is already a friendly sentence.
    jobs.delete(job.id)
    return NextResponse.json({
      success: false,
      error: job.error
    })
  }

  // done — return the result and clean up
  const result = job.result!
  jobs.delete(job.id)
  return NextResponse.json({
    success: true,
    data: {
      status: 'done',
      ...result
    }
  })
}

import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { randomUUID } from 'crypto'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_CHARS = 50
const MAX_CHARS = 20000

/** Target size of each section sent to the LLM separately. */
const SECTION_TARGET_CHARS = 900

/** Section overlap above this triggers one aggressive re-rewrite attempt. */
const SECTION_OVERLAP_LIMIT = 32

/** How many sections the LLM rewrites concurrently (2 is the API-safe max). */
const CONCURRENCY = 2

/** Finished jobs are kept for this long, then garbage-collected. */
const JOB_TTL_MS = 10 * 60 * 1000

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
  status: 'processing' | 'done' | 'error'
  createdAt: number
  totalSections: number
  completedSections: number
  result?: RewriteJobResult
  error?: string
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

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>

/** One LLM call with 429-aware retries. */
async function callRewriteLLM(
  zai: ZaiClient,
  section: string,
  aggressive: boolean
): Promise<string> {
  const userContent = aggressive
    ? `Rewrite the following section into an original script.\n${RETRY_PROMPT_SUFFIX}\n\n---SECTION START---\n${section}\n---SECTION END---`
    : `Rewrite the following section of a video transcript into an original script. Remember: same meaning, completely different wording and terminology, natural spoken narration.\n\n---SECTION START---\n${section}\n---SECTION END---`

  const MAX_ATTEMPTS = 4
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        thinking: { type: 'disabled' }
      })

      const raw = completion.choices[0]?.message?.content
      if (!raw || !raw.trim()) {
        throw new Error('The AI returned an empty response.')
      }

      const cleaned = cleanRewrittenText(raw)
      if (countWords(cleaned) < 3) {
        throw new Error('The AI response could not be parsed.')
      }
      return cleaned
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const rateLimited = lastErr.message.includes('429') || /too many requests/i.test(lastErr.message)
      console.error(`[rewrite] LLM attempt ${attempt} failed${rateLimited ? ' (rate limit)' : ''}:`, lastErr.message)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, rateLimited ? 3500 * attempt : 1200 * attempt))
      }
    }
  }

  throw lastErr ?? new Error('LLM call failed')
}

/**
 * Rewrite a single section: first pass, then an aggressive re-rewrite if the
 * overlap quality gate fails. Raises on unrecoverable errors.
 */
async function rewriteSectionWithQualityGate(
  zai: ZaiClient,
  section: string
): Promise<string> {
  let result = await callRewriteLLM(zai, section, false)

  const overlap = vocabularyOverlap(section, result)
  if (overlap > SECTION_OVERLAP_LIMIT) {
    try {
      const aggressiveResult = await callRewriteLLM(zai, section, true)
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
    const zai = await ZAI.create()
    const results: string[] = new Array(sections.length)
    let nextIndex = 0

    const worker = async () => {
      while (true) {
        const i = nextIndex
        if (i >= sections.length) return
        nextIndex++

        results[i] = await rewriteSectionWithQualityGate(zai, sections[i])
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
    job.error =
      error instanceof Error && error.message
        ? error.message
        : 'The AI rewrite service failed.'
    console.error(`[rewrite] Job ${job.id} failed:`, job.error)
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
    const rawMessage = error instanceof Error && error.message ? error.message : String(error)
    return NextResponse.json(
      {
        success: false,
        error: `The AI rewrite service failed to start. Please try again. (Details: ${rawMessage.slice(0, 180)})`
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
        error: 'Rewrite job not found. It may have expired (jobs are kept for 10 minutes) — please start again.'
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

  if (job.status === 'error') {
    // Job consumed — clean it up
    jobs.delete(job.id)
    return NextResponse.json({
      success: false,
      error: `The AI rewrite service failed. Please try again. (Details: ${job.error.slice(0, 180)})`
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

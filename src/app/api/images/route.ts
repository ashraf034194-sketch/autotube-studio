import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import {
  generateImageWithRetryQueue,
  type TrailEntry,
  type ProviderName
} from '@/lib/image-providers'
import { callLLM as callLLMWrapper } from '@/lib/llm-wrapper'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Types ───────────────────────────────────────────────────────────────────

/** One script segment + its precise timing inside the final voiceover audio.
 *  Produced by /api/voiceover; consumed here so image N visualizes the EXACT
 *  text chunk N the narrator speaks (true script-to-image match). */
interface ImageChunk {
  text: string
  startMs?: number
  endMs?: number
}

interface ImageSlot {
  index: number
  status: 'pending' | 'processing' | 'waiting' | 'done' | 'error'
  provider?: ProviderName
  trail?: TrailEntry[]
  retryCount: number
  nextRetryAt?: number
  waitMs?: number
  error?: string
  /** Literal script text this image is anchored to — for "exact match" proof. */
  chunkText?: string
}

interface ImageJob {
  id: string
  /** Lifecycle: styling → prompting → processing → done/error. */
  status: 'styling' | 'prompting' | 'processing' | 'done' | 'error'
  total: number
  completed: number
  waiting: number
  failed: number
  slots: ImageSlot[]
  prompts: string[]
  /** Visual style preamble prepended to every prompt — keeps the whole batch
   *  looking like one movie instead of unrelated stock photos. */
  styleDna?: string
  /** Source-of-truth script segments. Image N is anchored to chunks[N].text. */
  chunks: ImageChunk[]
  /** Prompt-gen progress (for the UI "Writing prompts (batch X/Y)" label). */
  promptBatchesTotal?: number
  promptBatchesDone?: number
  createdAt: number
  doneAt?: number
  error?: string
  currentLabel?: string
  // ── Junction (gated batch) flow ─────────────────────────────────────────
  // The whole image set is split into "junctions" of IMAGE_BATCH_GATE_SIZE
  // (default 20). One junction is processed at a time: its 20 images are run
  // with bounded intra-junction concurrency (IMAGE_BATCH_INTRA_CONCURRENCY),
  // then — once the WHOLE junction is settled (done/error) — the worker pool
  // pauses for BATCH_INTERLUDE_MS before starting the next junction. This
  // gives the provider APIs regular breathing room so the tool isn't pinned
  // at peak load for minutes on end (the user's "kum bojh" / less-load goal
  // for sets of 80/100/150+ images).
  batchGateSize?: number
  batchesTotal?: number
  /** 1-indexed junction currently being processed (0 = not started). */
  currentBatch?: number
  /** Images completed within the current junction (0..batchGateSize). */
  batchCompleted?: number
  batchFailed?: number
  /** Per-junction summary for the UI pills row. */
  batchStates?: BatchState[]
  /** True during the brief inter-junction pause (UI shows "breathing…"). */
  batchInterlude?: boolean
}

interface BatchState {
  index: number
  total: number
  completed: number
  failed: number
  status: 'pending' | 'active' | 'done'
}

const jobs = new Map<string, ImageJob>()
// 3 hours — large batches (100+ images) with junction-gated processing
// (20 images/junction × 3 workers × ~2s/image + interludes + retry-backoff
// for transient provider failures) can legitimately take 30-60+ minutes.
// The previous 1-hour TTL expired mid-batch for big jobs, surfacing as
// "Job not found (TTL 1 hour expired)" to the polling client. 3 hours gives
// ample headroom while still reclaiming memory for abandoned jobs.
const JOB_TTL_MS = 3 * 60 * 60 * 1000 // 3 hours

function cleanupExpiredJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)
  }
}

// ─── Image storage ──────────────────────────────────────────────────────────

const IMAGE_DIR_ROOT = process.env.AUTOTUBE_IMAGE_DIR || '/tmp/autotube-images'

function getImagePath(jobId: string, index: number): string {
  return path.join(IMAGE_DIR_ROOT, jobId, `${index}.jpg`)
}

// ─── Scale constants (Phase 1, 2026-05-11) ──────────────────────────────────
//
// MAX_IMAGES raised from 200 → 1000 to support long-form (25-40 min) videos.
// IMAGE_GEN_CONCURRENCY lowered from 6 → 3 — with the new 3-tier chain
// (Stability → GROK → Z.ai), when Stability (402) and GROK (403) are both in
// billing cooldown, ALL images fall to Z.ai (the only working tier). With 6
// concurrent workers, Z.ai gets 6 simultaneous calls → instant 429 rate-limit
// → 2-min cooldown → everything stalls. With 3 concurrent workers, Z.ai handles
// the load comfortably (~1-2s per image, no rate-limiting). The trade-off:
// 3 workers × ~2s/image = ~1.5 images/s, so a 115-image batch takes ~75s —
// well within the Z.ai quota. When Stability + GROK have credits again, the
// chain naturally uses them first (Stability is ~17s/image but cinematic
// quality), and 3 concurrent is still plenty for Stability's API limits.

const MAX_IMAGES = 1000
const IMAGE_GEN_CONCURRENCY = 3

// ─── Junction (gated batch) flow — "kum bojh" for big image sets ─────────────
//
// User request: "jitni bhi images hon — 80, 100, 150 ya us se opar — unko
// 20-20 images ke junction me tod do. Ek junction (20 images) generate
// karo, phir next 20, phir next 20… is tarah tool par bojh kam padega."
//
// Implementation: the whole image set is sliced into junctions of
// IMAGE_BATCH_GATE_SIZE (20). ONE junction is processed at a time using
// IMAGE_BATCH_INTRA_CONCURRENCY parallel workers (kept low at 3 — same as
// before, so the per-image peak load on the provider chain is unchanged).
// Once every slot in the current junction is settled (done/error), the
// worker pool pauses for BATCH_INTERLUDE_MS before starting the next
// junction. That interlude is the actual load-reducer: instead of 3
// workers pinning the provider chain continuously for N=150 images
// (5+ minutes of non-stop calls), the chain now gets a short breath
// every 20 images. Total wall-clock goes up marginally, but the provider
// APIs see a healthier request cadence and far fewer "all slots waiting
// simultaneously" cascades when a tier rate-limits.
//
// Junction size is intentionally the SAME as PROMPT_BATCH_SIZE (20) so
// the prompt-gen phase and the image-gen phase share the same mental
// model: "the video is processed in 20-image chapters".

/** Images per junction (user-specified "20 at a time"). */
const IMAGE_BATCH_GATE_SIZE = 20
/** Workers active WITHIN one junction. Bounded so peak load stays low. */
const IMAGE_BATCH_INTRA_CONCURRENCY = 3
/** Breathing-room pause between junctions, in ms. */
const BATCH_INTERLUDE_MS = 1500

/** Prompt generation: 20 chunks per LLM call (well within SDK output cap of
 *  ~4-8K tokens; 20 × ~100 tokens = ~2K tokens per batch). */
const PROMPT_BATCH_SIZE = 20

/** Parallel prompt-gen batches. 5 concurrent × ~3-5s/batch = ~25-30s for 200 prompts. */
const PROMPT_BATCH_PARALLEL = 5

// ─── Style DNA generation (one LLM call, ~3s) ────────────────────────────────
//
// The Style DNA is a single ~80-120 word preamble derived from the script that
// is PREPENDED to every image prompt in the batch. This guarantees visual
// consistency across all images — same palette, lighting, camera style — so
// the final video looks like one movie instead of unrelated stock photos.

const STYLE_DNA_SYSTEM = `You are a cinematographer designing the visual bible for a YouTube video. Derive ONE concise Style DNA preamble (2-3 sentences, ~80-120 words) that will be PREPENDED to every image prompt in this video to ensure visual consistency across all frames.

Include:
1. Visual medium (e.g. "cinematic photorealistic")
2. Aspect ratio (always "16:9" for YouTube)
3. Color palette (2-3 specific colors, e.g. "warm golden-hour palette with amber and teal tones")
4. Lighting style (e.g. "soft directional lighting, gentle bokeh background")
5. Camera style (e.g. "eye-level medium shots with occasional low-angle hero shots")
6. Mood (e.g. "intimate, contemplative")
7. A no-text/watermark clause

Output ONLY the Style DNA paragraph itself — no preamble, no markdown, no labels. Example output:
"cinematic photorealistic 16:9, warm golden-hour palette with amber and teal tones, soft directional lighting with gentle bokeh background, eye-level medium shots with occasional low-angle hero shots, intimate contemplative mood, no text overlay, no watermark"`

const DEFAULT_STYLE_DNA =
  'cinematic photorealistic 16:9, warm golden-hour palette with amber and teal tones, soft directional lighting with gentle bokeh background, eye-level medium shots, intimate contemplative mood, no text overlay, no watermark'

async function generateStyleDna(script: string): Promise<string> {
  // Use up to 8KB of the script — enough to capture the subject + tone without
  // blowing the input token budget.
  const scriptSlice = script.slice(0, 8000)
  const result = await callLLMWrapper(
    {
      systemPrompt: STYLE_DNA_SYSTEM,
      userContent: `SCRIPT:\n${scriptSlice}\n\nDerive the Style DNA for this video:`
    },
    {
      tag: 'style-dna',
      zaiMaxAttempts: 3,
      cloudflareMaxAttempts: 3,
      groqMaxAttempts: 2,
      maxTokens: 600,
      temperature: 0.6
      // No onWait here — Style DNA failure falls back to DEFAULT_STYLE_DNA
      // (fail-soft), and the wrapper's retry-queue (8min worst-case) is
      // absorbed by the image job's existing polling UI.
    }
  )
  if (result.fellBackToCloudflare) {
    console.log(
      `[images] Style DNA used Cloudflare fallback (zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}).`
    )
  } else if (result.fellBackToGroq) {
    console.log(
      `[images] Style DNA used Groq fallback (zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}, groqAttempts=${result.groqAttempts}).`
    )
  }
  if (result.usedRetryQueue) {
    console.log(
      `[images] Style DNA succeeded after retry-queue (rounds=${result.retryQueueRounds}, provider=${result.provider}).`
    )
  }
  return result.text.trim().slice(0, 1000) // Cap at 1000 chars to keep prompt sizes manageable.
}

// ─── Batched prompt generation ───────────────────────────────────────────────
//
// Replaces the old single-LLM-call-for-N-prompts approach. For N=200 prompts:
//   OLD: 1 call × 200 prompts = ~60-120s, fragile, output-token-capped
//   NEW: 10 batches × 20 prompts, 5 parallel = ~25-30s, resilient
//
// Each batch's system prompt includes the Style DNA + the chunk texts for THAT
// batch only. Failed batches fall back to style-DNA-anchored generic prompts
// (still script-anchored via the chunk text) so the batch can always proceed.

const BATCH_PROMPT_SYSTEM = `You are a cinematic storyboard artist. I will give you a Style DNA preamble and N sequential script chunks. For EACH chunk, write ONE image-generation prompt that DIRECTLY visualizes the LITERAL content of that specific chunk.

CRITICAL RULES (in priority order — rule #1 overrides all others):
1. LITERAL ANCHORING IS #1 — Each prompt MUST START with the SPECIFIC, CONCRETE subject of the chunk. If the chunk says "do five pushups", the prompt MUST contain "a person doing pushups on the floor". If the chunk says "she opened the door", the prompt MUST contain "a woman opening a door". Do NOT paraphrase, abstract, or replace the literal subject with a metaphor.
2. SUBJECT FIRST, STYLE SECOND — The concrete subject of the chunk MUST appear at the START of the prompt (within the first 40 chars). Style DNA wrapping (palette, lighting, camera) comes AFTER. This prevents the Style DNA from diluting the actual subject when sent to the image model.
3. STYLE CONSISTENCY — The Style DNA I provide is the visual bible. Wrap your literal subject with the Style DNA's palette, lighting, camera style — do NOT contradict it. But the Style DNA should NOT replace or overshadow the literal subject.
4. NO GENERIC IMAGERY — Avoid vague thematic words like "motivation", "success", "growth", "discipline", "journey", "challenge". ALWAYS anchor to the LITERAL concrete nouns + verbs of the chunk. If the chunk mentions "the man climbed the stairs", write "a man climbing a flight of wooden stairs" — NOT "an image representing progress".
5. DISTINCT BUT CONSISTENT — Each prompt must be visually distinct in SUBJECT/SETTING (different scenes, different actions, different objects) but stylistically CONSISTENT (same palette/lighting/camera from the Style DNA).
6. NO TEXT IN IMAGE — End every prompt with "no text overlay, no watermark".

OUTPUT FORMAT:
- Plain text only.
- One prompt per line.
- NO numbering, NO preamble, NO markdown, NO "Here are the prompts:".
- Output EXACTLY N lines (one per chunk, in input order).

EXAMPLE (Style DNA: "cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots"):
a person waking up in bed at dawn with sunlight streaming through a window, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, no text overlay, no watermark
a hand pouring water into a clear glass on a wooden nightstand, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, eye-level medium shots, no text overlay, no watermark`

async function generateOneBatch(
  batchChunks: ImageChunk[],
  styleDna: string
): Promise<string[]> {
  const chunkList = batchChunks
    .map((c, i) => `[Chunk ${i + 1}] ${c.text}`)
    .join('\n')
  const userContent = `STYLE DNA:\n${styleDna}\n\nCHUNKS (write ONE prompt per chunk, EXACTLY ${batchChunks.length} prompts):\n${chunkList}\n\nOutput ${batchChunks.length} prompts, one per line, in input order:`

  // 20 chunks × ~80 chars/prompt ≈ 1600 chars output. Cap at 2500 tokens to
  // be safe (Llama 3.3 70B has 24k context, so we have plenty of headroom).
  const result = await callLLMWrapper(
    {
      systemPrompt: BATCH_PROMPT_SYSTEM,
      userContent
    },
    {
      tag: `image-prompts-batch-${batchChunks.length}`,
      zaiMaxAttempts: 3,
      cloudflareMaxAttempts: 3,
      groqMaxAttempts: 2,
      maxTokens: 2500,
      temperature: 0.7
      // No onWait — batches already fail-soft to chunk-text-anchored generic
      // prompts after the retry-queue is exhausted.
    }
  )
  if (result.fellBackToCloudflare) {
    console.log(
      `[images] Batch prompts used Cloudflare fallback (zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}).`
    )
  } else if (result.fellBackToGroq) {
    console.log(
      `[images] Batch prompts used Groq fallback (zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}, groqAttempts=${result.groqAttempts}).`
    )
  }
  if (result.usedRetryQueue) {
    console.log(
      `[images] Batch prompts succeeded after retry-queue (rounds=${result.retryQueueRounds}, provider=${result.provider}).`
    )
  }
  const text = result.text
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\[\d+\]\s*|^\d+[\.)]\s*/, '').trim())
    .filter((l) => l.length > 15)

  // Pad missing prompts with chunk-text-anchored fallback (subject FIRST,
  // then style DNA wrapping — so the literal chunk subject dominates the
  // prompt even in the fallback path).
  while (lines.length < batchChunks.length) {
    const missingChunk = batchChunks[lines.length]
    lines.push(
      `${missingChunk.text.slice(0, 150)}, ${styleDna}, photorealistic, no text overlay, no watermark`
    )
  }
  return lines.slice(0, batchChunks.length)
}

async function generatePromptBatches(
  chunks: ImageChunk[],
  styleDna: string,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const batches: ImageChunk[][] = []
  for (let i = 0; i < chunks.length; i += PROMPT_BATCH_SIZE) {
    batches.push(chunks.slice(i, i + PROMPT_BATCH_SIZE))
  }

  const results: string[][] = new Array(batches.length)
  let nextBatch = 0
  let completed = 0

  async function worker(): Promise<void> {
    while (nextBatch < batches.length) {
      const b = nextBatch++
      try {
        results[b] = await generateOneBatch(batches[b], styleDna)
      } catch (err) {
        // Fall back to chunk-text-anchored generic prompts (subject FIRST,
        // then style DNA wrapping) so the batch can still proceed with
        // literal-anchored prompts even if the LLM call failed.
        console.error(
          `[images] Prompt batch ${b + 1}/${batches.length} failed:`,
          err instanceof Error ? err.message : String(err)
        )
        results[b] = batches[b].map(
          (c) =>
            `${c.text.slice(0, 150)}, ${styleDna}, photorealistic, no text overlay, no watermark`
        )
      }
      completed++
      onProgress?.(completed, batches.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PROMPT_BATCH_PARALLEL, batches.length) }, () => worker())
  )

  return results.flat()
}

// ─── Local copy of voiceover's chunker (independent to avoid circular imports) ─

function splitTextIntoChunksLocal(text: string, maxLength: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return [normalized]
  const sentences =
    normalized.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [normalized]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if ((current + sentence).length <= maxLength) {
      current += sentence
      continue
    }
    if (current.trim()) chunks.push(current.trim())
    current = ''
    if (sentence.length <= maxLength) {
      current = sentence
    } else {
      const words = sentence.split(' ')
      let piece = ''
      for (const word of words) {
        if ((piece + ' ' + word).trim().length > maxLength) {
          if (piece.trim()) chunks.push(piece.trim())
          piece = word
        } else {
          piece = piece ? `${piece} ${word}` : word
        }
      }
      if (piece.trim()) chunks.push(piece.trim())
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter((c) => c.length > 0)
}

// ─── POST: start image-generation job ───────────────────────────────────────

export async function POST(req: NextRequest) {
  cleanupExpiredJobs()
  let body: {
    text?: string
    durationSeconds?: number
    prompts?: string[]
    chunks?: ImageChunk[] // PREFERRED path (exact script-image match)
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // ── Branch A: caller pre-supplied prompts (rare — e.g. downstream replay) ──
  if (Array.isArray(body.prompts) && body.prompts.length > 0) {
    const prompts = body.prompts.slice(0, MAX_IMAGES)
    const jobId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const job: ImageJob = {
      id: jobId,
      status: 'processing',
      total: prompts.length,
      completed: 0,
      waiting: 0,
      failed: 0,
      slots: prompts.map((_, i) => ({ index: i, status: 'pending' as const, retryCount: 0 })),
      prompts,
      chunks: [],
      createdAt: Date.now(),
      currentLabel: 'Starting image generation'
    }
    jobs.set(jobId, job)
    processJob(job).catch((err) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      console.error(`[images] Job ${jobId} crashed:`, job.error)
    })
    return NextResponse.json({ jobId, total: prompts.length, prompts })
  }

  // ── Branch C (PREFERRED, NEW): caller passes chunks[] from voiceover ──
  // Image N will visualize the EXACT text chunk N — true script-to-image match.
  // No LLM-based segmentation needed; the chunks ARE the segmentation.
  if (Array.isArray(body.chunks) && body.chunks.length > 0 && body.chunks[0]?.text) {
    const chunks = body.chunks.slice(0, MAX_IMAGES)
    const targetCount = chunks.length
    const jobId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const job: ImageJob = {
      id: jobId,
      status: 'styling', // starts with Style DNA generation
      total: targetCount,
      completed: 0,
      waiting: 0,
      failed: 0,
      slots: [],
      prompts: [],
      chunks,
      createdAt: Date.now(),
      currentLabel: 'Designing visual style for the video'
    }
    jobs.set(jobId, job)
    processJob(job, { chunks }).catch((err) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      console.error(`[images] Job ${jobId} crashed:`, job.error)
    })
    console.log(
      `[images] Job ${jobId} started (chunk-based): ${targetCount} chunks, prompt-gen runs in background`
    )
    return NextResponse.json({ jobId, total: targetCount, prompts: [], chunks })
  }

  // ── Branch B (LEGACY FALLBACK): caller passes text + durationSeconds ──
  // Used when voiceover was generated by an older route version that didn't
  // return chunks. Internally splits the text using the same 140-char chunking
  // as the voiceover route so the segmentation is consistent.
  if (!body.text || body.text.trim().length < 20) {
    return NextResponse.json(
      {
        error:
          'Either "chunks" array, "prompts" array, or "text" (min 20 chars) is required.'
      },
      { status: 400 }
    )
  }
  const legacyChunks = splitTextIntoChunksLocal(body.text, 80).map((text) => ({ text }))
  const targetCount = Math.min(MAX_IMAGES, legacyChunks.length)
  const jobId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const job: ImageJob = {
    id: jobId,
    status: 'styling',
    total: targetCount,
    completed: 0,
    waiting: 0,
    failed: 0,
    slots: [],
    prompts: [],
    chunks: legacyChunks.slice(0, targetCount),
    createdAt: Date.now(),
    currentLabel: 'Designing visual style for the video'
  }
  jobs.set(jobId, job)
  processJob(job, { chunks: job.chunks }).catch((err) => {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    console.error(`[images] Job ${jobId} crashed:`, job.error)
  })
  console.log(
    `[images] Job ${jobId} started (legacy text-based): ${targetCount} chunks, prompt-gen runs in background`
  )
  return NextResponse.json({ jobId, total: targetCount, prompts: [], chunks: job.chunks })
}

// ─── GET: poll job progress ─────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  cleanupExpiredJobs()
  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId query param.' }, { status: 400 })
  }
  const job = jobs.get(jobId)
  if (!job) {
    return NextResponse.json(
      { error: 'Job not found (may have expired — TTL 3 hours).' },
      { status: 404 }
    )
  }

  const waitingSlots = job.slots
    .filter((s) => s.status === 'waiting')
    .map((s) => ({
      index: s.index,
      retryCount: s.retryCount,
      nextRetryAt: s.nextRetryAt,
      waitMs: s.waitMs
    }))

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    waiting: job.waiting,
    failed: job.failed,
    progress: job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0,
    waitingSlots,
    slots: job.slots.map((s) => ({
      index: s.index,
      status: s.status,
      provider: s.provider,
      retryCount: s.retryCount,
      error: s.error,
      chunkText: s.chunkText
    })),
    prompts: job.prompts,
    chunks: job.chunks,
    styleDna: job.styleDna ?? null,
    promptBatchesTotal: job.promptBatchesTotal ?? null,
    promptBatchesDone: job.promptBatchesDone ?? null,
    currentLabel: job.currentLabel ?? null,
    doneAt: job.doneAt,
    error: job.error,
    // ── Junction (gated batch) flow ──────────────────────────────────────
    batchGateSize: job.batchGateSize ?? null,
    batchesTotal: job.batchesTotal ?? null,
    currentBatch: job.currentBatch ?? null,
    batchCompleted: job.batchCompleted ?? null,
    batchFailed: job.batchFailed ?? null,
    batchInterlude: job.batchInterlude ?? false,
    batchStates: job.batchStates ?? null
  })
}

// ─── Background job processor ────────────────────────────────────────────────

async function processJob(
  job: ImageJob,
  promptRequest?: { chunks: ImageChunk[] }
): Promise<void> {
  fs.mkdirSync(path.join(IMAGE_DIR_ROOT, job.id), { recursive: true })

  // ── Phase 0: Style DNA generation (one LLM call, ~3s) ──
  if (job.status === 'styling' && promptRequest) {
    try {
      job.currentLabel = 'Designing visual style for the video'
      const scriptForStyle = promptRequest.chunks.map((c) => c.text).join(' ')
      job.styleDna = await generateStyleDna(scriptForStyle)
      const totalBatches = Math.ceil(promptRequest.chunks.length / PROMPT_BATCH_SIZE)
      job.promptBatchesTotal = totalBatches
      job.promptBatchesDone = 0
      job.status = 'prompting'
      job.currentLabel = `Writing image prompts (batch 0/${totalBatches})`
      console.log(
        `[images] Job ${job.id} Style DNA ready (${job.styleDna.length} chars), entering prompt-gen phase`
      )
    } catch (err) {
      // Style DNA failure is non-fatal — use a sensible default.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[images] Job ${job.id} Style DNA failed — using default: ${msg.slice(0, 100)}`
      )
      job.styleDna = DEFAULT_STYLE_DNA
      const totalBatches = Math.ceil(promptRequest.chunks.length / PROMPT_BATCH_SIZE)
      job.promptBatchesTotal = totalBatches
      job.promptBatchesDone = 0
      job.status = 'prompting'
      job.currentLabel = `Writing image prompts (batch 0/${totalBatches})`
    }
  }

  // ── Phase 1: prompt generation (batched, parallel LLM calls) ──
  if (job.status === 'prompting' && promptRequest) {
    try {
      const prompts = await generatePromptBatches(
        promptRequest.chunks,
        job.styleDna!,
        (done, total) => {
          job.promptBatchesDone = done
          job.promptBatchesTotal = total
          job.currentLabel = `Writing image prompts (batch ${done}/${total})`
        }
      )
      job.prompts = prompts
      job.total = prompts.length
      job.slots = prompts.map((_, i) => ({
        index: i,
        status: 'pending' as const,
        retryCount: 0,
        chunkText: promptRequest.chunks[i]?.text ?? ''
      }))
      job.status = 'processing'
      job.currentLabel = 'Starting image generation'
      console.log(
        `[images] Job ${job.id} prompts ready: ${prompts.length} prompts (${job.promptBatchesTotal} batches), entering image-gen phase`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      job.status = 'error'
      job.error = `Prompt generation failed: ${msg.slice(0, 200)}`
      console.error(`[images] Job ${job.id} prompt-gen failed:`, msg)
      return
    }
  }

  // ── Phase 2: image generation — gated junction flow (20 at a time) ──
  //
  // The whole set is sliced into junctions of IMAGE_BATCH_GATE_SIZE (20).
  // We process ONE junction at a time with IMAGE_BATCH_INTRA_CONCURRENCY
  // (3) parallel workers. When every slot in the current junction is
  // settled (done/error), we pause BATCH_INTERLUDE_MS for breathing room,
  // then advance to the next junction. This is the user-requested "kum
  // bojh" flow: instead of 3 workers pinning the provider chain non-stop
  // for N=150 images, the chain gets a short break every 20 images.
  const totalBatches = Math.max(1, Math.ceil(job.total / IMAGE_BATCH_GATE_SIZE))
  job.batchGateSize = IMAGE_BATCH_GATE_SIZE
  job.batchesTotal = totalBatches
  job.currentBatch = 0
  job.batchCompleted = 0
  job.batchFailed = 0
  job.batchInterlude = false
  job.batchStates = Array.from({ length: totalBatches }, (_, b) => {
    const start = b * IMAGE_BATCH_GATE_SIZE
    const end = Math.min(start + IMAGE_BATCH_GATE_SIZE, job.total)
    return {
      index: b,
      total: end - start,
      completed: 0,
      failed: 0,
      status: 'pending' as const
    }
  })

  function recomputeBatchState(b: number): void {
    if (!job.batchStates) return
    const bs = job.batchStates[b]
    if (!bs) return
    const start = b * IMAGE_BATCH_GATE_SIZE
    const end = Math.min(start + IMAGE_BATCH_GATE_SIZE, job.total)
    let done = 0
    let failed = 0
    for (let i = start; i < end; i++) {
      const s = job.slots[i]
      if (!s) continue
      if (s.status === 'done') done++
      else if (s.status === 'error') failed++
    }
    bs.completed = done
    bs.failed = failed
  }

  for (let b = 0; b < totalBatches; b++) {
    const batchStart = b * IMAGE_BATCH_GATE_SIZE
    const batchEnd = Math.min(batchStart + IMAGE_BATCH_GATE_SIZE, job.total)
    const batchSize = batchEnd - batchStart

    // Mark this junction active + update labels.
    if (job.batchStates) job.batchStates[b].status = 'active'
    job.currentBatch = b + 1
    job.batchCompleted = 0
    job.batchFailed = 0
    job.batchInterlude = false
    job.currentLabel =
      totalBatches > 1
        ? `Junction ${b + 1}/${totalBatches} — generating images ${batchStart + 1}–${batchEnd} (20 at a time)`
        : `Generating images ${batchStart + 1}–${batchEnd}`
    console.log(
      `[images] Job ${job.id} junction ${b + 1}/${totalBatches}: images ${batchStart + 1}–${batchEnd} (${batchSize} slots)`
    )

    // Per-junction cursor — workers can ONLY pull from this junction's
    // range, so the next junction's slots stay 'pending' (locked) until
    // this junction is fully settled. This is the gating mechanism.
    let batchCursor = batchStart

    async function junctionWorker(): Promise<void> {
      while (batchCursor < batchEnd) {
        const i = batchCursor++
        const slot = job.slots[i]
        if (!slot) continue
        slot.status = 'processing'
        const outPath = getImagePath(job.id, i)
        const prompt = job.prompts[i]

        try {
          const outcome = await generateImageWithRetryQueue(prompt, outPath, {
            onWait: (info) => {
              slot.status = 'waiting'
              slot.retryCount = info.retryCount
              slot.nextRetryAt = info.nextRetryAt
              slot.waitMs = info.waitMs
              slot.trail = info.lastTrail
              job.waiting = job.slots.filter((s) => s.status === 'waiting').length
              console.log(
                `[images] Job ${job.id} image ${i} (junction ${b + 1}): waiting for provider capacity (retry ${info.retryCount} in ${info.waitMs / 1000}s)`
              )
            },
            onRetry: (info) => {
              slot.status = 'processing'
              slot.retryCount = info.retryCount
              job.waiting = job.slots.filter((s) => s.status === 'waiting').length
              console.log(
                `[images] Job ${job.id} image ${i} (junction ${b + 1}): retrying full chain (round ${info.retryCount})`
              )
            }
          })
          slot.status = 'done'
          slot.provider = outcome.provider
          slot.trail = [{ provider: outcome.provider, ok: true }]
          slot.nextRetryAt = undefined
          slot.waitMs = undefined
          job.completed = job.slots.filter((s) => s.status === 'done').length
          job.waiting = job.slots.filter((s) => s.status === 'waiting').length
          recomputeBatchState(b)
          job.batchCompleted = job.batchStates?.[b]?.completed ?? 0
          job.batchFailed = job.batchStates?.[b]?.failed ?? 0
          const bc = job.batchCompleted ?? 0
          job.currentLabel =
            totalBatches > 1
              ? `Junction ${b + 1}/${totalBatches} — ${bc}/${batchSize} images (20 at a time)`
              : `Generating image ${job.completed + 1} of ${job.total}`
        } catch (err) {
          slot.status = 'error'
          slot.error = err instanceof Error ? err.message : String(err)
          job.failed = job.slots.filter((s) => s.status === 'error').length
          recomputeBatchState(b)
          job.batchCompleted = job.batchStates?.[b]?.completed ?? 0
          job.batchFailed = job.batchStates?.[b]?.failed ?? 0
          console.error(`[images] Job ${job.id} image ${i} (junction ${b + 1}) gave up:`, slot.error)
        }
        job.waiting = job.slots.filter((s) => s.status === 'waiting').length
      }
    }

    // Spawn the intra-junction worker pool. Capped to batchSize so we
    // never spawn more workers than there are images in this junction.
    const workers: Promise<void>[] = []
    for (let w = 0; w < Math.min(IMAGE_BATCH_INTRA_CONCURRENCY, batchSize); w++) {
      workers.push(junctionWorker())
    }
    await Promise.all(workers)

    // Junction fully settled. Mark done.
    if (job.batchStates) job.batchStates[b].status = 'done'
    recomputeBatchState(b)

    // Inter-junction breathing room — but only if there's another
    // junction coming. No point pausing after the last one.
    if (b < totalBatches - 1) {
      job.batchInterlude = true
      job.currentLabel =
        `Junction ${b + 1}/${totalBatches} done — breathing ${(BATCH_INTERLUDE_MS / 1000).toFixed(1)}s before next 20`
      console.log(
        `[images] Job ${job.id} junction ${b + 1}/${totalBatches} settled (${job.batchStates?.[b]?.completed ?? 0}/${batchSize} ok) — interlude ${BATCH_INTERLUDE_MS}ms`
      )
      await new Promise((r) => setTimeout(r, BATCH_INTERLUDE_MS))
      job.batchInterlude = false
    } else {
      console.log(
        `[images] Job ${job.id} final junction ${b + 1}/${totalBatches} settled (${job.batchStates?.[b]?.completed ?? 0}/${batchSize} ok)`
      )
    }
  }

  job.status = job.failed > 0 ? 'error' : 'done'
  job.doneAt = Date.now()
  job.batchInterlude = false
  job.currentLabel =
    job.failed > 0
      ? `Done with errors — ${job.completed}/${job.total} ok, ${job.failed} failed`
      : `All ${job.total} images ready`
  console.log(
    `[images] Job ${job.id} done: ${job.completed}/${job.total} ok, ${job.failed} failed (across ${totalBatches} junctions)`
  )
}

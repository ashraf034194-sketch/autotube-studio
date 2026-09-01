import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { callLLM as callLLMWrapper } from '@/lib/llm-wrapper'

const execFileAsync = promisify(execFile)

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
  status: 'pending' | 'done' | 'error'
  /** Literal script text this image is anchored to — for "exact match" proof. */
  chunkText?: string
  error?: string
}

interface ImageJob {
  id: string
  /** Lifecycle: styling → prompting → awaiting → done/error.
   *  'awaiting' = prompts ready, waiting for the user to generate images in
   *  Google Flow (https://labs.google/fx/tools/flow) and upload them here.
   *  Flow has no public API — this handoff is the only compliant path. */
  status: 'styling' | 'prompting' | 'awaiting' | 'done' | 'error'
  total: number
  completed: number
  waiting: number
  failed: number
  slots: ImageSlot[]
  prompts: string[]
  /** Visual style preamble prepended to every prompt — keeps the whole batch
   *  looking like one movie instead of unrelated frames. */
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
}

// Shared job store. Cached on globalThis so Next dev HMR module re-evaluation
// (new module instances after edits) keeps ONE live Map instead of forking
// state across route modules. In production there is a single instance anyway.
const gJobs = globalThis as unknown as { __imageJobs?: Map<string, ImageJob> }
const jobs: Map<string, ImageJob> = (gJobs.__imageJobs ??= new Map<string, ImageJob>())
// 12 hours — Flow-mode jobs wait for the USER to generate images in Google
// Flow (a manual round-trip that can easily take 30-60+ min for 57 images)
// and then upload them. 12h gives the handoff ample time while still
// reclaiming memory for abandoned jobs.
const JOB_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

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

// ─── Scale + prompt-batch constants ───────────────────────────────────────────────

/** Max images per video (long-form support — 25-40 min videos). */
const MAX_IMAGES = 1000

/** Prompt generation: 20 chunks per LLM call (well within the SDK output cap
 *  of ~4-8K tokens; 20 × ~100 tokens = ~2K tokens per batch). */
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

async function generateStyleDna(script: string, visualDirection?: string): Promise<string> {
  // Use up to 8KB of the script — enough to capture the subject + tone without
  // blowing the input token budget.
  const scriptSlice = script.slice(0, 8000)
  // Flow Prompt Studio integration: when the caller (autopilot or any client)
  // passes a visual direction (style / lighting / composition selected from
  // the Flow Studio catalogs), it becomes a HARD constraint the Style DNA
  // must honor — the LLM may enrich it with palette/camera/mood derived from
  // the script, but never contradict or drop the user's chosen direction.
  const directionBlock =
    visualDirection && visualDirection.trim()
      ? `\n\nUSER'S VISUAL DIRECTION (MUST be honored verbatim — weave every element into the Style DNA): ${visualDirection.trim()}\nYou may ADD palette, camera and mood details derived from the script, but you must NEVER contradict, drop, or dilute the user's visual direction.`
      : ''
  const result = await callLLMWrapper(
    {
      systemPrompt: STYLE_DNA_SYSTEM + directionBlock,
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
  if (!result.text.trim()) {
    return visualDirection?.trim()
      ? `${DEFAULT_STYLE_DNA}, ${visualDirection.trim()}`
      : DEFAULT_STYLE_DNA
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

// ─── POST: start a Flow-mode image job (prompts → Google Flow handoff) ─────────

export async function POST(req: NextRequest) {
  cleanupExpiredJobs()
  let body: {
    text?: string
    durationSeconds?: number
    prompts?: string[]
    chunks?: ImageChunk[] // PREFERRED path (exact script-image match)
    /** Flow Prompt Studio visual direction (style / lighting / composition)
     *  steering the Style DNA + every image prompt of the batch. */
    visualDirection?: string
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
      status: 'awaiting',
      total: prompts.length,
      completed: 0,
      waiting: 0,
      failed: 0,
      slots: prompts.map((_, i) => ({ index: i, status: 'pending' as const })),
      prompts,
      chunks: [],
      createdAt: Date.now(),
      currentLabel: 'Prompts ready — waiting for Google Flow images'
    }
    jobs.set(jobId, job)
    return NextResponse.json({ jobId, total: prompts.length, prompts })
  }

  // ── Branch C (PREFERRED, NEW): caller passes chunks[] from voiceover ──
  // Image N will visualize the EXACT text chunk N — true script-to-image match.
  // No LLM-based segmentation needed; the chunks ARE the segmentation.
  if (Array.isArray(body.chunks) && body.chunks.length > 0 && body.chunks[0]?.text) {
    const chunks = body.chunks.slice(0, MAX_IMAGES)
    const visualDirection =
      typeof body.visualDirection === 'string' ? body.visualDirection.slice(0, 500) : undefined
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
    processJob(job, { chunks, visualDirection }).catch((err) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      console.error(`[images] Job ${jobId} crashed:`, job.error)
    })
    console.log(
      `[images] Job ${jobId} started (chunk-based): ${targetCount} chunks, prompt-gen runs in background${visualDirection ? `, visualDirection="${visualDirection.slice(0, 80)}"` : ''}`
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
  processJob(job, {
    chunks: job.chunks,
    visualDirection:
      typeof body.visualDirection === 'string' ? body.visualDirection.slice(0, 500) : undefined
  }).catch((err) => {
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
      { error: 'Job not found (may have expired — TTL 12 hours).' },
      { status: 404 }
    )
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    waiting: 0,
    failed: job.failed,
    progress: job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0,
    slots: job.slots.map((s) => ({
      index: s.index,
      status: s.status,
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
    error: job.error
  })
}

// ─── Background job processor ────────────────────────────────────────────────

async function processJob(
  job: ImageJob,
  promptRequest?: { chunks: ImageChunk[]; visualDirection?: string }
): Promise<void> {
  fs.mkdirSync(path.join(IMAGE_DIR_ROOT, job.id), { recursive: true })

  // ── Phase 0: Style DNA generation (one LLM call, ~3s) ──
  if (job.status === 'styling' && promptRequest) {
    try {
      job.currentLabel = 'Designing visual style for the video'
      const scriptForStyle = promptRequest.chunks.map((c) => c.text).join(' ')
      job.styleDna = await generateStyleDna(scriptForStyle, promptRequest.visualDirection)
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
      // Keep honoring the Flow Studio visual direction even on the
      // fail-soft default path.
      job.styleDna = promptRequest.visualDirection?.trim()
        ? `${DEFAULT_STYLE_DNA}, ${promptRequest.visualDirection.trim()}`
        : DEFAULT_STYLE_DNA
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
        chunkText: promptRequest.chunks[i]?.text ?? ''
      }))
      job.status = 'awaiting'
      job.currentLabel = `${prompts.length} prompts ready — generate images in Google Flow, then upload them here`
      console.log(
        `[images] Job ${job.id} prompts ready: ${prompts.length} prompts — FLOW HANDOFF (no automatic generation; Pexels/Unsplash/Z.ai removed)`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      job.status = 'error'
      job.error = `Prompt generation failed: ${msg.slice(0, 200)}`
      console.error(`[images] Job ${job.id} prompt-gen failed:`, msg)
      return
    }
  }

  // ── Phase 2: FLOW HANDOFF — no automatic image generation ─────────────────
  //
  // The 3-tier automatic chain (Pexels → Unsplash → Z.ai) was REMOVED at the
  // user's request — Google Flow (https://labs.google/fx/tools/flow) is now the
  // ONLY image source. Flow has no public API, so after the prompts are
  // written the job simply parks in 'awaiting': the user generates the images
  // in Flow with their own account and uploads them via
  // POST /api/autopilot/flow-upload. Video assembly then resumes via
  // POST /api/autopilot/flow-finish. Everything else below this point is the
  // server-side machinery for those uploads.
}

// ─── Flow upload helpers (exported for /api/autopilot/flow-upload) ────────────

/** Look up a Flow-mode image job (must exist + have prompts ready). */
export function getFlowImageJob(jobId: string): ImageJob | undefined {
  return jobs.get(jobId)
}

/** Indices of slots still waiting for an image, in order. */
export function emptyFlowSlots(jobId: string): number[] {
  const job = jobs.get(jobId)
  if (!job) return []
  return job.slots.filter((s) => s.status === 'pending').map((s) => s.index)
}

/** Recompute the aggregate counters on an image job after slot changes. */
function recomputeFlowCounters(job: ImageJob): void {
  job.completed = job.slots.filter((s) => s.status === 'done').length
  job.failed = job.slots.filter((s) => s.status === 'error').length
  job.currentLabel = `${job.completed}/${job.total} images received from Google Flow`
}

/**
 * Save ONE uploaded image into its slot. The buffer is normalized to JPEG via
 * FFmpeg (any input format Flow exports — PNG/JPG/WebP — becomes ${index}.jpg,
 * which the video pipeline reads). Rejects on invalid/corrupt images.
 */
export async function saveFlowImage(
  jobId: string,
  slotIndex: number,
  buf: Buffer,
  originalName: string
): Promise<{ ok: boolean; error?: string }> {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: 'Image job not found (it may have expired — TTL 12 hours).' }
  const slot = job.slots[slotIndex]
  if (!slot) return { ok: false, error: `Slot ${slotIndex} does not exist on this job.` }

  const dir = path.join(IMAGE_DIR_ROOT, jobId)
  fs.mkdirSync(dir, { recursive: true })
  const outPath = getImagePath(jobId, slotIndex)

  // Extension only helps FFmpeg's demuxer hint — it probes content anyway.
  const ext = /\.(png|webp|gif|bmp|tiff?)$/i.test(originalName) ? originalName.split('.').pop()!.toLowerCase() : 'png'
  const tmpPath = path.join(dir, `upload-${slotIndex}-${Date.now()}.${ext}`)
  fs.writeFileSync(tmpPath, buf)

  try {
    // -frames:v 1 + -q:v 2 → single-frame, high-quality JPEG. The pipeline's
    // Pass-1 does its own scale/crop, so native resolution is preserved here.
    await execFileAsync('ffmpeg', ['-y', '-i', tmpPath, '-frames:v', '1', '-q:v', '2', outPath], {
      timeout: 30_000
    })
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      throw new Error('FFmpeg produced no usable output.')
    }
    slot.status = 'done'
    slot.error = undefined
    recomputeFlowCounters(job)
    return { ok: true }
  } catch (err) {
    slot.status = 'error'
    slot.error = err instanceof Error ? err.message : String(err)
    recomputeFlowCounters(job)
    return { ok: false, error: `Could not process "${originalName}": ${slot.error.slice(0, 150)}` }
  } finally {
    try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
  }
}

/** Remove an uploaded image from a slot (back to pending). */
export function removeFlowImage(jobId: string, slotIndex: number): { ok: boolean; error?: string } {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: 'Image job not found.' }
  const slot = job.slots[slotIndex]
  if (!slot) return { ok: false, error: `Slot ${slotIndex} does not exist.` }
  if (slot.status !== 'done') return { ok: false, error: 'This slot has no uploaded image.' }
  try { fs.unlinkSync(getImagePath(jobId, slotIndex)) } catch { /* already gone */ }
  slot.status = 'pending'
  slot.error = undefined
  recomputeFlowCounters(job)
  return { ok: true }
}

/**
 * Finalize the handoff: compact the uploaded images to a gap-free 0..N-1
 * sequence (the video pipeline reads ${index}.jpg for i < imageCount), mark
 * the job done, and return the final image count.
 */
export function finalizeFlowImages(jobId: string): { ok: boolean; total?: number; error?: string } {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: 'Image job not found.' }

  const doneIdx = job.slots.filter((s) => s.status === 'done').map((s) => s.index)
  const n = doneIdx.length
  if (n < 1) return { ok: false, error: 'No images uploaded yet — generate them in Google Flow and upload at least one.' }

  const dir = path.join(IMAGE_DIR_ROOT, jobId)
  // Two-phase rename (copy → temp, then move) so in-place compaction never
  // clobbers a source file we still need.
  for (let k = 0; k < n; k++) {
    const src = path.join(dir, `${doneIdx[k]}.jpg`)
    const tmp = path.join(dir, `compact-${k}.jpg`)
    fs.copyFileSync(src, tmp)
  }
  // Remove every original slot file, then move the temps into place.
  for (const idx of job.slots.map((s) => s.index)) {
    try { fs.unlinkSync(path.join(dir, `${idx}.jpg`)) } catch { /* not uploaded */ }
  }
  for (let k = 0; k < n; k++) {
    fs.renameSync(path.join(dir, `compact-${k}.jpg`), path.join(dir, `${k}.jpg`))
  }

  // Rewrite the job to its compacted shape: exactly N slots, all done.
  job.total = n
  job.completed = n
  job.failed = 0
  job.waiting = 0
  job.slots = Array.from({ length: n }, (_, i) => ({
    index: i,
    status: 'done' as const,
    chunkText: job.chunks[doneIdx[i]]?.text ?? job.slots[doneIdx[i]]?.chunkText ?? ''
  }))
  job.status = 'done'
  job.doneAt = Date.now()
  job.currentLabel = `${n} images received from Google Flow — video assembly starting`
  console.log(`[images] Job ${jobId} FLOW HANDOFF COMPLETE — ${n} images compacted to slots 0..${n - 1}`)
  return { ok: true, total: n }
}


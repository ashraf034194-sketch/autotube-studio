import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
// ── Direct route-handler imports (same process, shared disk artifacts) ───────
//
// The autopilot orchestrator drives the EXISTING battle-tested pipeline
// stages by importing their POST/GET handlers and invoking them with
// constructed NextRequest objects. Every underlying job store lives in
// module memory of this same import graph, and all heavy artifacts
// (images / MP4) are written to shared disk roots
// (/tmp/autotube-images, /tmp/autotube-videos) which the public file
// routes (/api/image, /api/video/file, /api/video/download) serve
// straight from disk. No HTTP self-calls, no port coupling, no keys.
import { POST as rewritePOST, GET as rewriteGET } from '@/app/api/rewrite/route'
import { POST as voiceoverPOST, GET as voiceoverGET } from '@/app/api/voiceover/route'
import { POST as imagesPOST, GET as imagesGET } from '@/app/api/images/route'
import {
  STYLE_OPTIONS,
  LIGHTING_OPTIONS,
  COMPOSITION_OPTIONS
} from '@/lib/flow-studio/types'
import { type AutopilotSettings, type AutopilotSnapshot } from '@/lib/autopilot/types'
import {
  autopilotJobs,
  beginStage,
  callRoute,
  cleanupExpiredAutopilotJobs,
  failJob,
  finishStage,
  getAutopilotJob,
  INTERNAL_BASE,
  jsonGET,
  jsonPOST,
  makeStages,
  updateStage,
  type AutopilotJobInternal
} from '@/lib/autopilot/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_CHARS = 50

/** Allowed voices (mirror of /api/voiceover's ALLOWED_VOICES). */
const ALLOWED_VOICES = new Set([
  'en-US-ChristopherNeural',
  'en-US-AndrewNeural',
  'en-US-BrianNeural',
  'en-US-AriaNeural',
  'en-US-MichelleNeural',
  'en-GB-RyanNeural',
  'en-GB-SoniaNeural'
])

const ALLOWED_SPEEDS = new Set([0.85, 1.0, 1.15, 1.3])
const ALLOWED_MUSIC = new Set(['none', 'calm', 'ambient', 'upbeat'])
const ALLOWED_RESOLUTIONS = new Set(['1080p', '4k'])

// Per-stage poll cadence + hard deadlines. Stages 1-3 only — the video stage
// (and its deadline) live in the store's runVideoStage, resumed after the
// Flow handoff.
const POLL = { rewrite: 1000, voiceover: 1200, images: 2000 }
const DEADLINE = {
  rewrite: 15 * 60 * 1000,
  voiceover: 12 * 60 * 1000,
  // Prompts only (Style DNA + batched prompt-gen); the actual images come
  // from the USER's Google Flow session, so there is nothing to wait for
  // here beyond prompt writing (LLM retry-queue worst case ≈ 8 min).
  images: 20 * 60 * 1000
}

// ── Visual direction (Flow Prompt Studio integration) ───────────────────────

/**
 * Build the visual-direction string from the Flow Prompt Studio option
 * catalogs (style / lighting / composition). This string steers the Style
 * DNA + every batch image prompt inside /api/images — i.e. the SAME
 * structured option catalogs that power the Flow Studio composer now
 * drive the automated pipeline's image prompts.
 */
export function buildVisualDirection(settings: AutopilotSettings): string {
  const parts: string[] = []

  if (settings.visualStyle === 'custom') {
    const custom = settings.customStyle.trim()
    if (custom) parts.push(`${custom} style`)
  } else {
    const style = STYLE_OPTIONS.find((o) => o.id === settings.visualStyle)
    if (style?.promptText) parts.push(style.promptText)
  }

  const lighting = LIGHTING_OPTIONS.find((o) => o.id === settings.lighting)
  if (lighting?.promptText) parts.push(lighting.promptText)

  if (settings.composition === 'custom') {
    const custom = settings.customComposition.trim()
    if (custom) parts.push(custom)
  } else {
    const comp = COMPOSITION_OPTIONS.find((o) => o.id === settings.composition)
    if (comp?.promptText) parts.push(comp.promptText)
  }

  return parts.join(', ')
}

// ── The orchestrator (stages 1-3, then the Flow-handoff pause) ───────────────

class StageError extends Error {
  stage: 'rewrite' | 'voiceover' | 'prompts' | 'images' | 'video'
  constructor(
    stage: 'rewrite' | 'voiceover' | 'prompts' | 'images' | 'video',
    message: string
  ) {
    super(message)
    this.stage = stage
    this.name = 'StageError'
  }
}

interface ImageSlotRow {
  index: number
  status: 'pending' | 'done' | 'error'
  error?: string
  chunkText?: string
}

interface RewriteStartData { jobId: string; totalSections: number }
interface RewriteDoneData {
  status: 'done'
  rewritten: string
  originalWordCount: number
  rewrittenWordCount: number
  sectionCount: number
  vocabularyOverlap: number
}
interface VoiceoverStartData { jobId: string; total: number }
interface VoiceoverDoneData {
  status: 'done'
  audioBase64: string
  mimeType: string
  durationSeconds: number
  sizeBytes: number
  chunkCount: number
  voice: string
  speed: number
  chunks: { text: string; startMs: number; endMs: number }[]
}
interface ImagesStartData { jobId: string; total: number }

async function runAutopilot(job: AutopilotJobInternal, transcript: string): Promise<void> {
  try {
    // ═══ Stage 1 — REWRITE ══════════════════════════════════════════════════
    beginStage(job, 'rewrite', 'Starting the script doctor…')
    const originalWordCount = transcript.trim().split(/\s+/).length
    job.artifacts.originalWordCount = originalWordCount

    const rewriteStart = await callRoute(
      rewritePOST,
      jsonPOST(`${INTERNAL_BASE}/api/rewrite`, { transcript })
    )
    const startData = rewriteStart.json.data as RewriteStartData | undefined
    if (!rewriteStart.ok || !rewriteStart.json.success || !startData?.jobId) {
      throw new StageError(
        'rewrite',
        (rewriteStart.json.error as string) ||
          `The rewrite service refused the request (status ${rewriteStart.status}).`
      )
    }

    // Poll the rewrite job (single consumer — its GET consumes on terminal).
    const rewritten = await new Promise<RewriteDoneData>((resolve, reject) => {
      const deadline = Date.now() + DEADLINE.rewrite
      const tick = async (): Promise<void> => {
        if (Date.now() > deadline) {
          reject(new StageError('rewrite', 'The rewrite stage timed out. Please try again.'))
          return
        }
        const poll = await callRoute(
          rewriteGET,
          jsonGET(`${INTERNAL_BASE}/api/rewrite?jobId=${encodeURIComponent(startData.jobId)}`)
        )
        const data = poll.json.data as
          | { status: 'processing'; completedSections: number; totalSections: number }
          | {
              status: 'waiting'
              completedSections: number
              totalSections: number
              waiting: { round: number; maxRounds: number; retryInSecsRemaining: number } | null
            }
          | RewriteDoneData
          | undefined

        if (!poll.json.success || !data) {
          reject(
            new StageError(
              'rewrite',
              (poll.json.error as string) || 'Lost track of the rewrite job.'
            )
          )
          return
        }

        if (data.status === 'processing') {
          updateStage(
            job,
            'rewrite',
            `Rewriting section ${data.completedSections + 1}/${data.totalSections}`,
            data.totalSections > 0
              ? Math.round((data.completedSections / data.totalSections) * 100)
              : null
          )
        } else if (data.status === 'waiting') {
          const w = data.waiting
          updateStage(
            job,
            'rewrite',
            w
              ? `Waiting for AI capacity — retrying in ${w.retryInSecsRemaining}s (round ${w.round}/${w.maxRounds})`
              : 'Waiting for AI capacity…',
            null
          )
        } else {
          resolve(data)
          return
        }
        setTimeout(tick, POLL.rewrite)
      }
      void tick()
    })

    job.artifacts.rewrittenScript = rewritten.rewritten
    job.artifacts.rewrittenWordCount = rewritten.rewrittenWordCount
    job.artifacts.vocabularyOverlap = rewritten.vocabularyOverlap
    finishStage(
      job,
      'rewrite',
      `Fresh script ready — ${rewritten.rewrittenWordCount.toLocaleString()} words, ${rewritten.vocabularyOverlap}% vocabulary overlap with the source.`
    )

    // ═══ Stage 2 — VOICEOVER ════════════════════════════════════════════════
    beginStage(job, 'voiceover', 'Starting neural narration…')
    const voStart = await callRoute(
      voiceoverPOST,
      jsonPOST(`${INTERNAL_BASE}/api/voiceover`, {
        text: rewritten.rewritten,
        voice: job.settings.voice,
        speed: job.settings.speed
      })
    )
    const voStartData = voStart.json.data as VoiceoverStartData | undefined
    if (!voStart.ok || !voStart.json.success || !voStartData?.jobId) {
      throw new StageError(
        'voiceover',
        (voStart.json.error as string) ||
          `The voiceover service refused the request (status ${voStart.status}).`
      )
    }
    job.live.voiceover.totalChunks = voStartData.total

    const voiceover = await new Promise<VoiceoverDoneData>((resolve, reject) => {
      const deadline = Date.now() + DEADLINE.voiceover
      const tick = async (): Promise<void> => {
        if (Date.now() > deadline) {
          reject(new StageError('voiceover', 'The voiceover stage timed out.'))
          return
        }
        const poll = await callRoute(
          voiceoverGET,
          jsonGET(`${INTERNAL_BASE}/api/voiceover?jobId=${encodeURIComponent(voStartData.jobId)}`)
        )
        const data = poll.json.data as
          | {
              status: 'processing'
              completedChunks: number
              totalChunks: number
              currentLabel: string | null
            }
          | VoiceoverDoneData
          | undefined

        if (!poll.json.success || !data) {
          reject(
            new StageError(
              'voiceover',
              (poll.json.error as string) || 'Lost track of the voiceover job.'
            )
          )
          return
        }

        if (data.status === 'processing') {
          job.live.voiceover.status = 'processing'
          job.live.voiceover.completedChunks = data.completedChunks
          job.live.voiceover.totalChunks = data.totalChunks
          job.live.voiceover.currentLabel = data.currentLabel
          updateStage(
            job,
            'voiceover',
            data.currentLabel ??
              `Synthesizing segment ${data.completedChunks}/${data.totalChunks}`,
            data.totalChunks > 0
              ? Math.round((data.completedChunks / data.totalChunks) * 100)
              : null
          )
        } else {
          job.live.voiceover.status = 'done'
          job.live.voiceover.completedChunks = data.chunkCount
          job.live.voiceover.durationSeconds = data.durationSeconds
          job.live.voiceover.sizeBytes = data.sizeBytes
          resolve(data)
          return
        }
        setTimeout(tick, POLL.voiceover)
      }
      void tick()
    })

    job.artifacts.voiceover = {
      voice: voiceover.voice,
      speed: voiceover.speed,
      durationSeconds: voiceover.durationSeconds,
      chunkCount: voiceover.chunkCount,
      sizeBytes: voiceover.sizeBytes
    }
    finishStage(
      job,
      'voiceover',
      `Narration ready — ${formatDurLocal(voiceover.durationSeconds)} across ${voiceover.chunkCount} segments (${(voiceover.sizeBytes / 1024 / 1024).toFixed(1)} MB).`
    )

    // ═══ Stage 3 + 4 — FLOW STUDIO PROMPTS → GOOGLE FLOW HANDOFF ═══════════
    //
    // One image job covers the prompt-writing UI stage:
    //   'styling'/'prompting' → stage 3 active (Flow Studio engine writes the
    //                            Style DNA + per-chunk prompts, batched 20/20)
    //   'awaiting'            → stage 3 done, stage 4 active. The pipeline
    //                            PAUSES: the user generates the images in
    //                            Google Flow (labs.google/fx/tools/flow — no
    //                            public API exists, this handoff is the only
    //                            compliant path) and uploads them via
    //                            POST /api/autopilot/flow-upload. Video
    //                            assembly resumes via
    //                            POST /api/autopilot/flow-finish.
    beginStage(
      job,
      'prompts',
      'Flow Studio is designing the visual direction (Style DNA)…'
    )
    const visualDirection = buildVisualDirection(job.settings)
    const imgStart = await callRoute(
      imagesPOST,
      jsonPOST(`${INTERNAL_BASE}/api/images`, {
        chunks: voiceover.chunks,
        visualDirection
      })
    )
    const imgStartData = imgStart.json as unknown as ImagesStartData | undefined
    if (!imgStart.ok || !imgStartData?.jobId) {
      throw new StageError(
        'prompts',
        (imgStart.json.error as string) ||
          `The image service refused the request (status ${imgStart.status}).`
      )
    }
    job.live.images.jobId = imgStartData.jobId
    job.artifacts.imageJobId = imgStartData.jobId

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + DEADLINE.images
      const tick = async (): Promise<void> => {
        if (Date.now() > deadline) {
          reject(new StageError('prompts', 'The prompt-writing stage timed out.'))
          return
        }
        const poll = await callRoute(
          imagesGET,
          jsonGET(`${INTERNAL_BASE}/api/images?jobId=${encodeURIComponent(imgStartData.jobId)}`)
        )
        const data = poll.json as
          | {
              jobId: string
              status: 'styling' | 'prompting' | 'awaiting' | 'done' | 'error'
              total: number
              completed: number
              waiting: number
              failed: number
              progress: number
              currentLabel: string | null
              promptBatchesTotal: number | null
              promptBatchesDone: number | null
              styleDna: string | null
              slots: ImageSlotRow[]
              prompts: string[]
              error: string | null
            }
          | undefined

        if (!poll.ok || !data) {
          reject(
            new StageError(
              'prompts',
              (poll.json.error as string) || 'Lost track of the image job.'
            )
          )
          return
        }

        // Mirror the live image state for the UI.
        job.live.images.status = data.status
        job.live.images.total = data.total
        job.live.images.completed = data.completed
        job.live.images.failed = data.failed
        job.live.images.progress = data.progress
        job.live.images.currentLabel = data.currentLabel
        job.live.images.promptBatchesTotal = data.promptBatchesTotal
        job.live.images.promptBatchesDone = data.promptBatchesDone
        job.live.images.styleDna = data.styleDna
        job.live.images.slots = data.slots.map((s) => ({
          index: s.index,
          status: s.status,
          chunkText: s.chunkText,
          error: s.error
        }))
        job.artifacts.styleDna = data.styleDna ?? undefined

        if (data.status === 'error') {
          job.live.images.error = data.error ?? 'Image job failed.'
          reject(new StageError('prompts', job.live.images.error))
          return
        }

        if (data.status === 'styling') {
          updateStage(
            job,
            'prompts',
            visualDirection
              ? `Flow Studio is blending your visual direction (${visualDirection}) into the Style DNA…`
              : 'Flow Studio is designing the visual style (Style DNA)…'
          )
        } else if (data.status === 'prompting') {
          const done = data.promptBatchesDone ?? 0
          const total = data.promptBatchesTotal ?? 0
          updateStage(
            job,
            'prompts',
            `Writing image prompts — batch ${Math.min(done + 1, total || 1)}/${total || '?'} (20 chunks per batch)`,
            total > 0 ? Math.round((done / total) * 100) : null
          )
        } else if (data.status === 'awaiting' || data.status === 'done') {
          // Prompts are ready → finish stage 3, pause stage 4 at the handoff.
          if (data.prompts?.length) {
            job.artifacts.promptsSample = data.prompts.slice(0, 3)
            job.live.images.prompts = data.prompts
          }
          finishStage(
            job,
            'prompts',
            `${data.total} Flow-Studio prompts ready — every image anchored to its exact narration chunk.`
          )
          beginStage(
            job,
            'images',
            `Waiting for your Google Flow images — ${data.total} prompts are ready to copy.`
          )
          job.live.images.currentLabel = 'Prompts ready — generate images in Google Flow, then upload them here'

          // Store the resume context (server-side only) and pause the run.
          job.resume = {
            audioBase64: voiceover.audioBase64,
            mimeType: voiceover.mimeType,
            audioDuration: voiceover.durationSeconds,
            script: rewritten.rewritten,
            imageJobId: imgStartData.jobId
          }
          job.status = 'awaiting_images'
          job.artifacts.imageCount = 0
          console.log(
            `[autopilot ${job.id}] AWAITING FLOW IMAGES — ${data.total} prompts ready (image job ${imgStartData.jobId}); run paused until uploads finish`
          )
          resolve()
          return
        }

        setTimeout(tick, POLL.images)
      }
      void tick()
    })
    // runAutopilot ENDS here in the happy path — stage 5 runs later, resumed
    // by POST /api/autopilot/flow-finish (→ runVideoStage in the store).
  } catch (err) {
    if (err instanceof StageError) {
      failJob(job, err.stage, err.message)
    } else {
      const fallbackKey: 'images' | 'prompts' =
        beginFallbackKey(job)
      failJob(job, fallbackKey, err instanceof Error ? err.message : String(err))
    }
  }
}

function beginFallbackKey(job: AutopilotJobInternal): 'images' | 'prompts' {
  const images = job.stages.find((s) => s.key === 'images')
  return images && images.status === 'active' ? 'images' : 'prompts'
}

function formatDurLocal(totalSeconds?: number): string {
  if (!totalSeconds || !Number.isFinite(totalSeconds)) return '—'
  const secs = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

// ── POST: start an autopilot run ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  cleanupExpiredAutopilotJobs()

  let body: {
    transcript?: string
    settings?: Partial<AutopilotSettings>
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : ''
  if (transcript.length < MIN_CHARS) {
    return NextResponse.json(
      {
        error: `Please provide a script of at least ${MIN_CHARS} characters. The autopilot needs real content to work with.`
      },
      { status: 400 }
    )
  }

  // ── Settings validation (fail fast, friendly) ──
  const raw = body.settings ?? {}
  const voice =
    typeof raw.voice === 'string' && ALLOWED_VOICES.has(raw.voice)
      ? raw.voice
      : 'en-US-ChristopherNeural'
  const speed =
    typeof raw.speed === 'number' && ALLOWED_SPEEDS.has(raw.speed) ? raw.speed : 1.0
  const music =
    typeof raw.music === 'string' && ALLOWED_MUSIC.has(raw.music) ? raw.music : 'none'
  const resolution =
    typeof raw.resolution === 'string' && ALLOWED_RESOLUTIONS.has(raw.resolution)
      ? raw.resolution
      : '1080p'

  const visualStyle =
    typeof raw.visualStyle === 'string' &&
    (STYLE_OPTIONS.some((o) => o.id === raw.visualStyle) || raw.visualStyle === 'custom')
      ? raw.visualStyle
      : 'cinematic'
  const lighting =
    typeof raw.lighting === 'string' && LIGHTING_OPTIONS.some((o) => o.id === raw.lighting)
      ? raw.lighting
      : 'cinematic-light'
  const composition =
    typeof raw.composition === 'string' &&
    (COMPOSITION_OPTIONS.some((o) => o.id === raw.composition) || raw.composition === 'custom')
      ? raw.composition
      : 'medium-shot'

  const settings: AutopilotSettings = {
    voice,
    speed,
    visualStyle,
    customStyle: typeof raw.customStyle === 'string' ? raw.customStyle.slice(0, 300) : '',
    lighting,
    composition,
    customComposition:
      typeof raw.customComposition === 'string' ? raw.customComposition.slice(0, 300) : '',
    music,
    resolution,
    captions: raw.captions !== false,
    transitions: raw.transitions !== false,
    titleCard: raw.titleCard !== false,
    highlights: raw.highlights !== false,
    outro: raw.outro !== false
  }

  // Custom style selected but left blank → honest early error (no guessing).
  if (visualStyle === 'custom' && !settings.customStyle.trim()) {
    return NextResponse.json(
      {
        error: 'Custom visual style selected but no description given — describe the look you want.'
      },
      { status: 400 }
    )
  }
  if (composition === 'custom' && !settings.customComposition.trim()) {
    return NextResponse.json(
      {
        error: 'Custom composition selected but no description given — describe the framing you want.'
      },
      { status: 400 }
    )
  }

  // ── Guard: one active autopilot at a time (duplicate protection) ──
  // An awaiting-Images run ALSO blocks new starts: its resume context (the
  // voiceover audio) only lives in memory and must not be orphaned.
  for (const existing of autopilotJobs.values()) {
    if (existing.status === 'running' || existing.status === 'awaiting_images') {
      return NextResponse.json(
        {
          error:
            existing.status === 'awaiting_images'
              ? 'An autopilot run is paused at the Google Flow handoff — finish (or let expire) its image uploads before starting another.'
              : 'An autopilot run is already in progress — wait for it to finish before starting another.',
          existingId: existing.id
        },
        { status: 409 }
      )
    }
  }

  const job: AutopilotJobInternal = {
    id: randomUUID(),
    status: 'running',
    createdAt: Date.now(),
    settings,
    stages: makeStages(),
    live: {
      voiceover: {
        status: 'processing',
        completedChunks: 0,
        totalChunks: 0,
        currentLabel: null
      },
      images: {
        jobId: null,
        status: 'idle',
        total: 0,
        completed: 0,
        failed: 0,
        progress: 0,
        currentLabel: null,
        promptBatchesTotal: null,
        promptBatchesDone: null,
        styleDna: null,
        slots: []
      },
      video: {
        jobId: null,
        status: 'idle',
        stage: null,
        progress: 0
      }
    },
    artifacts: {}
  }
  autopilotJobs.set(job.id, job)

  // Fire-and-forget — the browser polls GET /api/autopilot?id=
  void runAutopilot(job, transcript)

  console.log(
    `[autopilot ${job.id}] STARTED (Flow mode) — ${transcript.length} chars, voice=${settings.voice}, style=${settings.visualStyle}/${settings.lighting}/${settings.composition}, music=${settings.music}`
  )

  return NextResponse.json({ autopilotId: job.id })
}

// ── GET: poll an autopilot run ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  cleanupExpiredAutopilotJobs()

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Missing id query param.' }, { status: 400 })
  }
  const job = getAutopilotJob(id)
  if (!job) {
    return NextResponse.json(
      {
        error:
          'Autopilot run not found (it may have expired — finished runs are kept 4 hours, Flow-handoff runs 12 hours).'
      },
      { status: 404 }
    )
  }

  const snap: AutopilotSnapshot = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    doneAt: job.doneAt,
    settings: job.settings,
    stages: job.stages,
    live: job.live,
    artifacts: job.artifacts,
    failedStage: job.failedStage,
    error: job.error
  }
  return NextResponse.json(snap)
}

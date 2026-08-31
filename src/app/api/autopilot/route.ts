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
import { POST as videoPOST, GET as videoGET } from '@/app/api/video/route'
import {
  STYLE_OPTIONS,
  LIGHTING_OPTIONS,
  COMPOSITION_OPTIONS
} from '@/lib/flow-studio/types'
import {
  STAGE_LABELS,
  type AutopilotJob,
  type AutopilotSettings,
  type AutopilotSnapshot,
  type AutopilotStage,
  type AutopilotStageKey
} from '@/lib/autopilot/types'
import type { ProviderName } from '@/lib/image-providers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_CHARS = 50

/** Allowed voices (mirror of /api/voiceover's ALLOWED_VOICES). */
const ALLOWED_VOICES = new Set([
  'en-US-ChristopherNeural',
  'en-US-AndrewNeural',
  'en-US-GuyNeural',
  'en-US-BrianNeural',
  'en-US-AriaNeural',
  'en-US-MichelleNeural',
  'en-GB-RyanNeural',
  'en-GB-SoniaNeural'
])

const ALLOWED_SPEEDS = new Set([0.85, 1.0, 1.15, 1.3])
const ALLOWED_MUSIC = new Set(['none', 'calm', 'ambient', 'upbeat'])
const ALLOWED_RESOLUTIONS = new Set(['1080p', '4k'])

/** Jobs are kept for 4 hours after completion, then reclaimed. */
const JOB_TTL_MS = 4 * 60 * 60 * 1000

// Per-stage poll cadence + hard deadlines (generous headroom for the LLM
// retry-queue worst case and big image batches).
const POLL = { rewrite: 1000, voiceover: 1200, images: 2000, video: 2000 }
const DEADLINE = {
  rewrite: 15 * 60 * 1000,
  voiceover: 12 * 60 * 1000,
  images: 3 * 60 * 60 * 1000, // matches the images route's own 3h TTL
  video: 2 * 60 * 60 * 1000 // matches the video route's own 2h TTL
}

const jobs = new Map<string, AutopilotJob>()

function cleanupExpiredJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - (job.doneAt ?? job.createdAt) > JOB_TTL_MS) {
      jobs.delete(id)
    }
  }
}

// ── Internal request helpers ─────────────────────────────────────────────────

const INTERNAL_BASE = 'http://autopilot.internal'

function jsonGET(url: string): NextRequest {
  return new NextRequest(new URL(url), { method: 'GET' })
}

function jsonPOST(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function callRoute(
  handler: (req: NextRequest) => Promise<NextResponse>,
  req: NextRequest
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await handler(req)
  let json: Record<string, unknown>
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = {}
  }
  return { ok: res.ok, status: res.status, json }
}

// ── Stage bookkeeping ────────────────────────────────────────────────────────

function makeStages(): AutopilotStage[] {
  return (Object.keys(STAGE_LABELS) as AutopilotStageKey[]).map((key) => ({
    key,
    label: STAGE_LABELS[key],
    status: 'pending' as const,
    detail: null,
    progress: null
  }))
}

function stage(job: AutopilotJob, key: AutopilotStageKey): AutopilotStage {
  return job.stages.find((s) => s.key === key)!
}

function beginStage(job: AutopilotJob, key: AutopilotStageKey, detail: string): void {
  const s = stage(job, key)
  s.status = 'active'
  s.detail = detail
  s.progress = null
  s.startedAt = Date.now()
}

function updateStage(
  job: AutopilotJob,
  key: AutopilotStageKey,
  detail: string,
  progress?: number | null
): void {
  const s = stage(job, key)
  if (s.status === 'active') {
    s.detail = detail
    if (progress !== undefined) s.progress = progress
  }
}

function finishStage(job: AutopilotJob, key: AutopilotStageKey, detail: string): void {
  const s = stage(job, key)
  s.status = 'done'
  s.detail = detail
  s.progress = 100
  s.doneAt = Date.now()
}

function failJob(job: AutopilotJob, key: AutopilotStageKey, message: string): void {
  const s = stage(job, key)
  s.status = 'error'
  s.detail = message
  s.doneAt = Date.now()
  job.status = 'failed'
  job.failedStage = key
  job.error = message
  job.doneAt = Date.now()
  console.error(`[autopilot ${job.id}] FAILED at "${key}": ${message}`)
}

// ── Visual direction (Flow Prompt Studio integration) ───────────────────────

/**
 * Build the visual-direction string from the Flow Prompt Studio option
 * catalogs (style / lighting / composition). This string steers the Style
 * DNA + every batch image prompt inside /api/images — i.e. the SAME
 * structured option catalogs that power the Flow Studio composer now
 * drive the automated pipeline's image generation.
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

// ── The orchestrator ─────────────────────────────────────────────────────────

class StageError extends Error {
  stage: AutopilotStageKey
  constructor(stageKey: AutopilotStageKey, message: string) {
    super(message)
    this.stage = stageKey
    this.name = 'StageError'
  }
}

interface ImageSlotRow {
  index: number
  status: 'pending' | 'processing' | 'waiting' | 'done' | 'error'
  provider?: string
}
interface ImageBatchRow {
  index: number
  total: number
  completed: number
  failed: number
  status: 'pending' | 'active' | 'done'
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
interface VideoStartData { jobId: string }

async function runAutopilot(job: AutopilotJob, transcript: string): Promise<void> {
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
      `Narration ready — ${formatDur(voiceover.durationSeconds)} across ${voiceover.chunkCount} segments (${(voiceover.sizeBytes / 1024 / 1024).toFixed(1)} MB).`
    )

    // ═══ Stage 3 + 4 — FLOW STUDIO PROMPTS + BATCH IMAGES ═══════════════════
    // One image job covers both UI stages:
    //   'styling'/'prompting' → stage 3 active (Flow Studio engine writes the
    //                            Style DNA + per-chunk prompts, batched 20/20)
    //   'processing'          → stage 4 active (junction-gated image batches)
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
    const imgStartData = imgStart.json as ImagesStartData | undefined
    if (!imgStart.ok || !imgStartData?.jobId) {
      throw new StageError(
        'prompts',
        (imgStart.json.error as string) ||
          `The image service refused the request (status ${imgStart.status}).`
      )
    }
    job.live.images.jobId = imgStartData.jobId
    job.artifacts.imageJobId = imgStartData.jobId

    const imagesDone = await new Promise<{
      total: number
      completed: number
      failed: number
      prompts: string[]
    }>((resolve, reject) => {
      const deadline = Date.now() + DEADLINE.images
      const tick = async (): Promise<void> => {
        if (Date.now() > deadline) {
          reject(new StageError('images', 'The image generation stage timed out.'))
          return
        }
        const poll = await callRoute(
          imagesGET,
          jsonGET(`${INTERNAL_BASE}/api/images?jobId=${encodeURIComponent(imgStartData.jobId)}`)
        )
        const data = poll.json as
          | {
              jobId: string
              status: 'styling' | 'prompting' | 'processing' | 'done' | 'error'
              total: number
              completed: number
              waiting: number
              failed: number
              progress: number
              currentLabel: string | null
              promptBatchesTotal: number | null
              promptBatchesDone: number | null
              styleDna: string | null
              batchesTotal: number | null
              currentBatch: number | null
              batchCompleted: number | null
              batchInterlude: boolean
              batchStates: ImageBatchRow[] | null
              slots: ImageSlotRow[]
              prompts: string[]
              error: string | null
            }
          | undefined

        if (!poll.ok || !data) {
          reject(
            new StageError(
              'images',
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
        job.live.images.batchesTotal = data.batchesTotal
        job.live.images.currentBatch = data.currentBatch
        job.live.images.batchCompleted = data.batchCompleted
        job.live.images.batchInterlude = data.batchInterlude
        job.live.images.batchStates = data.batchStates ?? null
        job.live.images.styleDna = data.styleDna
        job.live.images.slots = data.slots.map((s) => ({
          index: s.index,
          status: s.status,
          provider: s.provider as ProviderName | undefined
        }))
        job.artifacts.styleDna = data.styleDna ?? undefined

        if (data.status === 'error') {
          job.live.images.error = data.error ?? 'Image generation failed.'
          reject(new StageError('images', job.live.images.error))
          return
        }

        // Map the image job's internal phases onto UI stages 3/4.
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
        } else {
          // First time we reach 'processing'/'done' → prompts stage complete.
          if (stage(job, 'prompts').status === 'active') {
            if (data.prompts?.length) {
              job.artifacts.promptsSample = data.prompts.slice(0, 3)
            }
            finishStage(
              job,
              'prompts',
              `${data.total} Flow-Studio prompts ready — every image anchored to its exact narration chunk.`
            )
            beginStage(job, 'images', 'Starting batched image generation…')
          }
          if (data.status === 'processing') {
            const junction =
              data.batchesTotal && data.batchesTotal > 1
                ? ` · junction ${data.currentBatch ?? '?'}/${data.batchesTotal}${data.batchInterlude ? ' (breathing)' : ''}`
                : ''
            updateStage(
              job,
              'images',
              `${data.currentLabel ?? `Generating image ${data.completed + 1}/${data.total}`}${junction}`,
              data.progress
            )
          }
        }

        if (data.status === 'done') {
          if (stage(job, 'images').status === 'active') {
            finishStage(
              job,
              'images',
              `${data.completed}/${data.total} images generated${data.failed > 0 ? ` · ${data.failed} failed (video will skip those)` : ''}.`
            )
          }
          resolve({
            total: data.total,
            completed: data.completed,
            failed: data.failed,
            prompts: data.prompts ?? []
          })
          return
        }
        setTimeout(tick, POLL.images)
      }
      void tick()
    })

    job.artifacts.imageCount = imagesDone.completed
    job.artifacts.imageFailed = imagesDone.failed

    if (imagesDone.completed < 1) {
      throw new StageError(
        'images',
        'No images could be generated (all slots failed). The video cannot be assembled without frames — please try again.'
      )
    }

    // ═══ Stage 5 — VIDEO ASSEMBLY ═══════════════════════════════════════════
    beginStage(job, 'video', 'Preparing clips, captions and music…')
    const videoStart = await callRoute(
      videoPOST,
      jsonPOST(`${INTERNAL_BASE}/api/video`, {
        imageJobId: imgStartData.jobId,
        imageCount: imagesDone.completed,
        audioBase64: voiceover.audioBase64,
        audioDuration: voiceover.durationSeconds,
        mimeType: voiceover.mimeType,
        script: rewritten.rewritten,
        captionsEnabled: job.settings.captions,
        transitionsEnabled: job.settings.transitions,
        titleCardEnabled: job.settings.titleCard,
        textHighlightsEnabled: job.settings.highlights,
        outroEnabled: job.settings.outro,
        musicSource: job.settings.music === 'none' ? 'none' : 'library',
        musicTrack: job.settings.music === 'none' ? undefined : job.settings.music,
        resolution: job.settings.resolution
      })
    )
    const videoStartData = videoStart.json as VideoStartData | undefined
    if (!videoStart.ok || !videoStartData?.jobId) {
      throw new StageError(
        'video',
        (videoStart.json.error as string) ||
          `The video service refused the request (status ${videoStart.status}).`
      )
    }
    job.live.video.jobId = videoStartData.jobId

    const videoDone = await new Promise<{
      videoDuration?: number
      fileSize?: number
      videoWidth?: number
      videoHeight?: number
      titleCardText?: string
      outroCtaText?: string
      kenBurnsApplied?: boolean
      musicLabel?: string
      captionsApplied?: boolean
      variablePacingApplied?: boolean
      transitionsApplied?: boolean
      titleCardApplied?: boolean
      textHighlightsApplied?: boolean
      textHighlightsCount?: number
      outroApplied?: boolean
      resolution?: string
    }>((resolve, reject) => {
      const deadline = Date.now() + DEADLINE.video
      const tick = async (): Promise<void> => {
        if (Date.now() > deadline) {
          reject(new StageError('video', 'The video assembly stage timed out.'))
          return
        }
        const poll = await callRoute(
          videoGET,
          jsonGET(`${INTERNAL_BASE}/api/video?jobId=${encodeURIComponent(videoStartData.jobId)}`)
        )
        const data = poll.json as
          | {
              status: 'processing' | 'done' | 'error'
              stage: string
              progress: number
              etaSeconds?: number
              error?: string
              videoDuration?: number
              fileSize?: number
              videoWidth?: number
              videoHeight?: number
              titleCardText?: string
              outroCtaText?: string
              kenBurnsApplied?: boolean
              musicLabel?: string
              captionsApplied?: boolean
              variablePacingApplied?: boolean
              transitionsApplied?: boolean
              titleCardApplied?: boolean
              textHighlightsApplied?: boolean
              textHighlightsCount?: number
              outroApplied?: boolean
              resolution?: string
            }
          | undefined

        if (!poll.ok || !data) {
          reject(
            new StageError(
              'video',
              (poll.json.error as string) || 'Lost track of the video job.'
            )
          )
          return
        }

        job.live.video.status = data.status
        job.live.video.stage = data.stage
        job.live.video.progress = data.progress
        job.live.video.etaSeconds = data.etaSeconds
        job.live.video.videoDuration = data.videoDuration
        job.live.video.fileSize = data.fileSize
        job.live.video.videoWidth = data.videoWidth
        job.live.video.videoHeight = data.videoHeight
        job.live.video.titleCardText = data.titleCardText
        job.live.video.outroCtaText = data.outroCtaText

        if (data.status === 'error') {
          job.live.video.error = data.error ?? 'Video assembly failed.'
          reject(new StageError('video', job.live.video.error))
          return
        }

        if (data.status === 'processing') {
          const eta =
            typeof data.etaSeconds === 'number' && data.etaSeconds > 0
              ? ` · ~${formatEta(data.etaSeconds)} left`
              : ''
          updateStage(job, 'video', `${data.stage} — ${data.progress}%${eta}`, data.progress)
          setTimeout(tick, POLL.video)
        } else {
          resolve(data)
        }
      }
      void tick()
    })

    // ═══ COMPLETED ══════════════════════════════════════════════════════════
    const features: string[] = []
    if (videoDone.kenBurnsApplied) features.push('Ken Burns motion')
    if (videoDone.captionsApplied) features.push('Burn-in captions')
    if (videoDone.variablePacingApplied) features.push('Variable pacing')
    if (videoDone.transitionsApplied) features.push('Smart transitions')
    if (videoDone.titleCardApplied) features.push('Title card')
    if (videoDone.textHighlightsApplied) {
      features.push(`Text highlights ×${videoDone.textHighlightsCount ?? '?'}`)
    }
    if (videoDone.outroApplied) features.push('Outro card')
    if (videoDone.musicLabel) features.push(`${videoDone.musicLabel} music`)

    job.artifacts.video = {
      jobId: videoStartData.jobId,
      fileUrl: `/api/video/file?jobId=${encodeURIComponent(videoStartData.jobId)}`,
      downloadUrl: `/api/video/download?jobId=${encodeURIComponent(videoStartData.jobId)}`,
      videoDuration: videoDone.videoDuration,
      fileSize: videoDone.fileSize,
      videoWidth: videoDone.videoWidth,
      videoHeight: videoDone.videoHeight,
      titleCardText: videoDone.titleCardText,
      outroCtaText: videoDone.outroCtaText,
      featuresApplied: features
    }
    finishStage(
      job,
      'video',
      `Finished video ready — ${formatDur(videoDone.videoDuration ?? voiceover.durationSeconds)}${videoDone.videoWidth ? ` · ${videoDone.videoWidth}×${videoDone.videoHeight}` : ''}${videoDone.fileSize ? ` · ${(videoDone.fileSize / 1024 / 1024).toFixed(1)} MB` : ''}.`
    )
    job.status = 'completed'
    job.doneAt = Date.now()
    console.log(
      `[autopilot ${job.id}] COMPLETED in ${Math.round((job.doneAt - job.createdAt) / 1000)}s — ${imagesDone.completed} images, video job ${videoStartData.jobId}`
    )
  } catch (err) {
    if (err instanceof StageError) {
      failJob(job, err.stage, err.message)
    } else {
      const fallbackKey: AutopilotStageKey =
        stage(job, 'video').status === 'active'
          ? 'video'
          : stage(job, 'images').status === 'active'
            ? 'images'
            : 'prompts'
      failJob(job, fallbackKey, err instanceof Error ? err.message : String(err))
    }
  }
}

function formatDur(totalSeconds?: number): string {
  if (!totalSeconds || !Number.isFinite(totalSeconds)) return '—'
  const secs = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

function formatEta(seconds: number): string {
  if (seconds >= 90) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds)}s`
}

// ── POST: start an autopilot run ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  cleanupExpiredJobs()

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
  for (const existing of jobs.values()) {
    if (existing.status === 'running') {
      return NextResponse.json(
        {
          error: 'An autopilot run is already in progress — wait for it to finish before starting another.',
          existingId: existing.id
        },
        { status: 409 }
      )
    }
  }

  const job: AutopilotJob = {
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
        batchesTotal: null,
        currentBatch: null,
        batchCompleted: null,
        batchInterlude: false,
        batchStates: null,
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
  jobs.set(job.id, job)

  // Fire-and-forget — the browser polls GET /api/autopilot?id=
  void runAutopilot(job, transcript)

  console.log(
    `[autopilot ${job.id}] STARTED — ${transcript.length} chars, voice=${settings.voice}, style=${settings.visualStyle}/${settings.lighting}/${settings.composition}, music=${settings.music}`
  )

  return NextResponse.json({ autopilotId: job.id })
}

// ── GET: poll an autopilot run ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  cleanupExpiredJobs()

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Missing id query param.' }, { status: 400 })
  }
  const job = jobs.get(id)
  if (!job) {
    return NextResponse.json(
      {
        error: 'Autopilot run not found (it may have expired — runs are kept 4 hours after finishing).'
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
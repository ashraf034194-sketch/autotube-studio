// ── AutoTube Autopilot — shared job store & stage helpers ─────────────────────
//
// Extracted from src/app/api/autopilot/route.ts so that the new Flow-handoff
// endpoints (POST /api/autopilot/flow-upload, POST /api/autopilot/flow-finish)
// share the SAME in-memory job Map as the orchestrator. Google Flow has no
// public API, so the pipeline PAUSES at the image stage ('awaiting_images'):
// prompts are ready, the user generates images in Flow, uploads them, then
// video assembly resumes via runVideoStage().

import { NextRequest, NextResponse } from 'next/server'
import { POST as videoPOST, GET as videoGET } from '@/app/api/video/route'
import {
  STAGE_LABELS,
  type AutopilotJob,
  type AutopilotSettings,
  type AutopilotStage,
  type AutopilotStageKey
} from '@/lib/autopilot/types'

// ── Job store ────────────────────────────────────────────────────────────────

/**
 * Server-side resume context stored on a job when it pauses at the Flow
 * handoff. NEVER sent to the client (audioBase64 is large) — only used by
 * runVideoStage when the user finishes uploading.
 */
export interface FlowResumeContext {
  /** Full voiceover audio as base64 (for /api/video audioBase64). */
  audioBase64: string
  mimeType: string
  audioDuration: number
  /** Rewritten narration script (captions + variable pacing). */
  script: string
  /** The Flow-mode image job id. */
  imageJobId: string
}

export interface AutopilotJobInternal extends AutopilotJob {
  resume?: FlowResumeContext
}

export const autopilotJobs = new Map<string, AutopilotJobInternal>()

/** Completed/failed runs are kept 4 hours; awaiting-Flow runs get 12 hours
 *  (the manual Flow round-trip can take 30-60+ minutes for big batches). */
const JOB_TTL_MS = 4 * 60 * 60 * 1000
const AWAITING_TTL_MS = 12 * 60 * 60 * 1000

export function getAutopilotJob(id: string): AutopilotJobInternal | undefined {
  return autopilotJobs.get(id)
}

export function cleanupExpiredAutopilotJobs(): void {
  const now = Date.now()
  for (const [id, job] of autopilotJobs) {
    const ttl = job.status === 'awaiting_images' ? AWAITING_TTL_MS : JOB_TTL_MS
    if (job.status !== 'running' && now - (job.doneAt ?? job.createdAt) > ttl) {
      autopilotJobs.delete(id)
    }
  }
}

// ── Stage bookkeeping ────────────────────────────────────────────────────────

export function makeStages(): AutopilotStage[] {
  return (Object.keys(STAGE_LABELS) as AutopilotStageKey[]).map((key) => ({
    key,
    label: STAGE_LABELS[key],
    status: 'pending' as const,
    detail: null,
    progress: null
  }))
}

export function findStage(job: AutopilotJob, key: AutopilotStageKey): AutopilotStage {
  return job.stages.find((s) => s.key === key)!
}

export function beginStage(job: AutopilotJob, key: AutopilotStageKey, detail: string): void {
  const s = findStage(job, key)
  s.status = 'active'
  s.detail = detail
  s.progress = null
  s.startedAt = Date.now()
}

export function updateStage(
  job: AutopilotJob,
  key: AutopilotStageKey,
  detail: string,
  progress?: number | null
): void {
  const s = findStage(job, key)
  if (s.status === 'active') {
    s.detail = detail
    if (progress !== undefined) s.progress = progress
  }
}

export function finishStage(job: AutopilotJob, key: AutopilotStageKey, detail: string): void {
  const s = findStage(job, key)
  s.status = 'done'
  s.detail = detail
  s.progress = 100
  s.doneAt = Date.now()
}

export function failJob(job: AutopilotJobInternal, key: AutopilotStageKey, message: string): void {
  const s = findStage(job, key)
  s.status = 'error'
  s.detail = message
  s.doneAt = Date.now()
  job.status = 'failed'
  job.failedStage = key
  job.error = message
  job.doneAt = Date.now()
  console.error(`[autopilot ${job.id}] FAILED at "${key}": ${message}`)
}

// ── Internal route-call helpers (same-process, no HTTP self-calls) ───────────

export const INTERNAL_BASE = 'http://autopilot.internal'

export function jsonGET(url: string): NextRequest {
  return new NextRequest(new URL(url), { method: 'GET' })
}

export function jsonPOST(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export async function callRoute(
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

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatDur(totalSeconds?: number): string {
  if (!totalSeconds || !Number.isFinite(totalSeconds)) return '—'
  const secs = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

export function formatEta(seconds: number): string {
  if (seconds >= 90) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds)}s`
}

// ── Stage 5 — video assembly (resumed after the Flow handoff) ────────────────

const POLL = { video: 2000 }
const DEADLINE = { video: 2 * 60 * 60 * 1000 } // matches the video route's own 2h TTL

/**
 * Run stage 5 (video assembly) to completion on the CURRENT job, using the
 * resume context stored when the pipeline paused at the Flow handoff. Called
 * by POST /api/autopilot/flow-finish once the user has uploaded ≥ 1 image.
 */
export async function runVideoStage(job: AutopilotJobInternal): Promise<void> {
  const resume = job.resume
  if (!resume) {
    failJob(job, 'video', 'Internal error: resume context missing for the video stage.')
    return
  }
  try {
    beginStage(job, 'video', 'Preparing clips, captions and music…')
    const videoStart = await callRoute(
      videoPOST,
      jsonPOST(`${INTERNAL_BASE}/api/video`, {
        imageJobId: resume.imageJobId,
        imageCount: job.artifacts.imageCount ?? 0,
        audioBase64: resume.audioBase64,
        audioDuration: resume.audioDuration,
        mimeType: resume.mimeType,
        script: resume.script,
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
    const videoStartData = videoStart.json as { jobId?: string } | undefined
    if (!videoStart.ok || !videoStartData?.jobId) {
      throw new Error(
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
          reject(new Error('The video assembly stage timed out.'))
          return
        }
        const poll = await callRoute(
          videoGET,
          jsonGET(`${INTERNAL_BASE}/api/video?jobId=${encodeURIComponent(videoStartData!.jobId!)}`)
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
          reject(new Error((poll.json.error as string) || 'Lost track of the video job.'))
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
          reject(new Error(job.live.video.error))
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

    // ═══ COMPLETED ═══
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
      `Finished video ready — ${formatDur(videoDone.videoDuration ?? resume.audioDuration)}${videoDone.videoWidth ? ` · ${videoDone.videoWidth}×${videoDone.videoHeight}` : ''}${videoDone.fileSize ? ` · ${(videoDone.fileSize / 1024 / 1024).toFixed(1)} MB` : ''}.`
    )
    job.status = 'completed'
    job.doneAt = Date.now()
    job.resume = undefined // free the audio buffer
    console.log(
      `[autopilot ${job.id}] COMPLETED (Flow handoff) — ${job.artifacts.imageCount ?? '?'} images, video job ${videoStartData.jobId}`
    )
  } catch (err) {
    failJob(job, 'video', err instanceof Error ? err.message : String(err))
  }
}

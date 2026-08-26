'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Film,
  Loader2,
  AlertCircle,
  RefreshCw,
  Check,
  Download,
  Play,
  Clock,
  HardDrive,
  Clapperboard,
  Wand2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/hooks/use-toast'

// ─── Types ─────────────────────────────────────────────────────────────────

type Stage = 'preparing' | 'assembling' | 'finalizing' | 'done' | 'error'

interface JobSnapshot {
  jobId: string
  status: 'processing' | 'done' | 'error'
  stage: Stage
  progress: number
  imageCount: number
  audioDuration: number
  fileSize?: number
  videoDuration?: number
  etaSeconds?: number
  error?: string
  createdAt: number
  doneAt?: number
}

interface FinalVideoCardProps {
  /** Image job id (from AI Images phase) — null until images are done. */
  imageJobId: string | null
  imageCount: number | null
  /** Voiceover payload — null until generated. */
  voiceover: {
    audioBase64: string
    mimeType: string
    durationSeconds: number
  } | null
  /** Fired when the video job transitions between idle/generating/done/error. */
  onStatusChange?: (status: 'idle' | 'generating' | 'done' | 'error') => void
}

// ─── fetchJson ──────────────────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init)
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, json }
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '-'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  if (m === 0) return `${sec}s`
  return `${m}m ${sec.toString().padStart(2, '0')}s`
}

function formatEta(s: number | undefined): string {
  if (!s || s < 1) return 'calculating…'
  if (s < 60) return `~${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m < 2) return `~${m}m ${sec}s`
  return `~${m}m`
}

// ─── Stage label / description ───────────────────────────────────────────────

const STAGE_LABEL: Record<Stage, string> = {
  preparing: 'Preparing inputs',
  assembling: 'Assembling video',
  finalizing: 'Finalizing MP4',
  done: 'Done',
  error: 'Error'
}

const STAGE_DESC: Record<Stage, string> = {
  preparing: 'Verifying images and staging audio…',
  assembling: 'Encoding 1920×1080 H.264 with crossfade transitions…',
  finalizing: 'Writing moov atom for web playback…',
  done: 'Your video is ready to preview and download.',
  error: 'The video assembly failed.'
}

// ─── Realistic time estimate (for big jobs) ──────────────────────────────────

function estimateBuildSeconds(imageCount: number, audioDuration: number): number {
  // Empirically: ~0.04s per image-second of output (30fps H.264 medium preset,
  // single-pass concat-filter on this box). Plus ~3s fixed overhead.
  const outSeconds = audioDuration
  const perImageSecond = 0.045
  return Math.round(outSeconds * perImageSecond * Math.sqrt(imageCount) + 3)
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FinalVideoCard({
  imageJobId,
  imageCount,
  voiceover,
  onStatusChange
}: FinalVideoCardProps) {
  const { toast } = useToast()
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const notifyStatus = useCallback(
    (s: 'idle' | 'generating' | 'done' | 'error') => {
      onStatusChange?.(s)
    },
    [onStatusChange]
  )

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  // ── Prereqs ──
  const canGenerate =
    !!imageJobId &&
    !!imageCount &&
    imageCount > 0 &&
    !!voiceover &&
    !!voiceover.audioBase64 &&
    voiceover.durationSeconds > 0 &&
    status !== 'generating'

  const missingReason = !voiceover
    ? 'Generate the voiceover first.'
    : !imageJobId || !imageCount
      ? 'Generate the AI images first.'
      : status === 'generating'
        ? 'Video is currently assembling…'
        : null

  // ── Polling ──
  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling()
      const tick = async () => {
        try {
          const { ok, status: httpStatus, json } = await fetchJson(
            `/api/video?jobId=${encodeURIComponent(jobId)}`,
            { method: 'GET' }
          )
          if (!ok) {
            throw new Error((json as { error?: string }).error || `Poll failed (status ${httpStatus})`)
          }
          const data = json as JobSnapshot
          setJob(data)
          if (data.status === 'done') {
            stopPolling()
            setStatus('done')
            notifyStatus('done')
            toast({
              title: 'Video ready',
              description: `Your ${formatSeconds(data.videoDuration ?? 0)} video is ready to download.`
            })
          } else if (data.status === 'error') {
            stopPolling()
            setStatus('error')
            setErrorMsg(data.error || 'Video assembly failed.')
            notifyStatus('error')
          }
        } catch (err) {
          stopPolling()
          const message = err instanceof Error ? err.message : 'Lost track of the video job.'
          setStatus('error')
          setErrorMsg(message)
          notifyStatus('error')
        }
      }
      tick()
      pollRef.current = setInterval(tick, 1500)
    },
    [notifyStatus, stopPolling, toast]
  )

  // ── Generate ──
  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !voiceover || !imageJobId || !imageCount) return

    setStatus('generating')
    setErrorMsg(null)
    setJob(null)
    notifyStatus('generating')

    try {
      const { ok, status: httpStatus, json } = await fetchJson('/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageJobId,
          imageCount,
          audioBase64: voiceover.audioBase64,
          audioDuration: voiceover.durationSeconds,
          mimeType: voiceover.mimeType
        })
      })
      if (!ok) {
        throw new Error((json as { error?: string }).error || `Request failed (status ${httpStatus})`)
      }
      const data = json as { jobId: string }
      setJob({
        jobId: data.jobId,
        status: 'processing',
        stage: 'preparing',
        progress: 0,
        imageCount,
        audioDuration: voiceover.durationSeconds,
        createdAt: Date.now()
      })
      startPolling(data.jobId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start the video job.'
      setStatus('error')
      setErrorMsg(message)
      notifyStatus('error')
      toast({
        variant: 'destructive',
        title: 'Could not start video',
        description: message
      })
    }
  }, [canGenerate, imageJobId, imageCount, notifyStatus, startPolling, toast, voiceover])

  const handleRetry = useCallback(() => {
    setStatus('idle')
    setErrorMsg(null)
    setJob(null)
    notifyStatus('idle')
  }, [notifyStatus])

  // ── Download URL ──
  const downloadUrl = job && status === 'done' ? `/api/video/download?jobId=${encodeURIComponent(job.jobId)}` : null

  // ── Estimated time (shown before user starts, to set expectations) ──
  const estimatedBuild =
    imageCount && voiceover ? estimateBuildSeconds(imageCount, voiceover.durationSeconds) : null

  // ── Render ──
  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600/15 ring-1 ring-red-600/30">
              <Clapperboard className="h-5 w-5 text-red-400" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-lg text-zinc-100">Final Video Assembly</CardTitle>
              <CardDescription className="text-zinc-400">
                Stitch the voiceover + every image into a single 1920×1080 H.264 MP4 with smooth crossfade transitions.
              </CardDescription>
            </div>
          </div>
          {status === 'done' && (
            <Badge className="gap-1.5 border-emerald-500/40 bg-emerald-500/15 text-emerald-300">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Ready
            </Badge>
          )}
          {status === 'generating' && (
            <Badge className="gap-1.5 border-red-500/40 bg-red-500/15 text-red-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Assembling
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Stats row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={<Film className="h-4 w-4" aria-hidden="true" />}
            label="Images"
            value={imageCount ? String(imageCount) : '—'}
            hint={imageCount ? `@ 4s each` : 'pending'}
          />
          <StatTile
            icon={<Clock className="h-4 w-4" aria-hidden="true" />}
            label="Audio"
            value={voiceover ? formatSeconds(voiceover.durationSeconds) : '—'}
            hint={voiceover ? 'voiceover' : 'pending'}
          />
          <StatTile
            icon={<Wand2 className="h-4 w-4" aria-hidden="true" />}
            label="Est. build"
            value={estimatedBuild ? formatSeconds(estimatedBuild) : '—'}
            hint={estimatedBuild ? 'FFmpeg' : 'pending'}
          />
          <StatTile
            icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
            label="Output"
            value={status === 'done' && job?.fileSize ? formatBytes(job.fileSize) : '—'}
            hint="MP4 · 1080p"
          />
        </div>

        {/* Action area */}
        {status === 'idle' && (
          <div className="space-y-3">
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="w-full bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
            >
              <Clapperboard className="h-4 w-4" aria-hidden="true" />
              Generate Video
            </Button>
            {missingReason && (
              <p className="text-center text-xs text-zinc-500">{missingReason}</p>
            )}
            {canGenerate && estimatedBuild && (
              <p className="text-center text-xs text-zinc-500">
                Heavy FFmpeg encode — estimated {formatSeconds(estimatedBuild)} for {imageCount} images. The page stays live while it runs in the background.
              </p>
            )}
          </div>
        )}

        {/* Progress area */}
        {status === 'generating' && job && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium text-zinc-200">
                <Loader2 className="h-4 w-4 animate-spin text-red-400" aria-hidden="true" />
                {STAGE_LABEL[job.stage]}…
                <span className="text-zinc-500">({job.progress}%)</span>
              </span>
              <span className="text-zinc-400">
                {job.etaSeconds ? `ETA ${formatEta(job.etaSeconds)}` : 'working…'}
              </span>
            </div>
            <Progress value={job.progress} className="h-2.5 bg-zinc-800" />
            <p className="text-xs text-zinc-500">{STAGE_DESC[job.stage]}</p>
            <p className="text-xs text-zinc-600">
              Images {job.imageCount} · Audio {formatSeconds(job.audioDuration)} · Stage:{' '}
              <span className="text-zinc-400">{job.stage}</span>
            </p>
          </div>
        )}

        {/* Done — video player + download */}
        {status === 'done' && job && downloadUrl && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="space-y-4"
          >
            <Alert className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">
              <Check className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Video assembled successfully</AlertTitle>
              <AlertDescription className="text-emerald-200/80">
                {job.imageCount} images · {formatSeconds(job.videoDuration ?? 0)} ·{' '}
                {formatBytes(job.fileSize ?? 0)} · 1920×1080 H.264 MP4
              </AlertDescription>
            </Alert>

            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black">
              <video
                ref={videoRef}
                src={downloadUrl}
                controls
                playsInline
                className="aspect-video w-full bg-black"
                preload="metadata"
              >
                Your browser does not support the video tag.
              </video>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button asChild className="bg-red-600 text-white hover:bg-red-500">
                <a href={downloadUrl} download={`autotube-${job.jobId}.mp4`}>
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download MP4
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStatus('idle')
                  setJob(null)
                  notifyStatus('idle')
                }}
                className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Rebuild
              </Button>
              <span className="ml-auto text-xs text-zinc-500">
                <Play className="mr-1 inline h-3 w-3" aria-hidden="true" />
                Preview above · Download for full quality
              </span>
            </div>
          </motion.div>
        )}

        {/* Error */}
        {status === 'error' && (
          <Alert variant="destructive" className="border-red-500/40 bg-red-500/10 text-red-200">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Video assembly failed</AlertTitle>
            <AlertDescription className="text-red-200/80">
              {errorMsg ?? 'Unknown error.'}
              {job?.error && (
                <span className="mt-1 block font-mono text-[11px] text-red-300/60">
                  {job.error.slice(0, 300)}
                </span>
              )}
            </AlertDescription>
            <div className="mt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleRetry}
                className="border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Retry
              </Button>
            </div>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Small stat tile ─────────────────────────────────────────────────────────

function StatTile({
  icon,
  label,
  value,
  hint
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
      <div className="text-[11px] text-zinc-500">{hint}</div>
    </div>
  )
}

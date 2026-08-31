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
  Wand2,
  Music,
  Upload,
  Volume2,
  Sparkles,
  Captions,
  Gauge,
  Shuffle,
  Type,
  Highlighter,
  ThumbsUp,
  Monitor,
  AlertTriangle
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
  kenBurnsApplied?: boolean
  musicLabel?: string
  captionsApplied?: boolean
  variablePacingApplied?: boolean
  transitionsApplied?: boolean
  // Phase 6 P2 — Title card + text highlights
  titleCardApplied?: boolean
  titleCardText?: string
  textHighlightsApplied?: boolean
  textHighlightsCount?: number
  // Phase 6 P3 — Outro end card
  outroApplied?: boolean
  outroCtaText?: string
  // Phase 6 P4 — Output resolution + ffprobe-verified geometry
  resolution?: '1080p' | '4k'
  videoWidth?: number
  videoHeight?: number
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
  /**
   * Phase 5B — The rewritten narration script. Sent to /api/video so the
   * backend can split it into imageCount segments for both the burn-in
   * captions AND variable per-clip pacing (longer segments get more time).
   */
  script?: string | null
  /** Fired when the video job transitions between idle/generating/done/error. */
  onStatusChange?: (status: 'idle' | 'generating' | 'done' | 'error') => void
}

// ─── Music library (mirrors the backend's LIBRARY_TRACKS set) ────────────────
//
// Three royalty-free tracks synthesised with FFmpeg. The MP3s live in
// /public/music/<id>.mp3 and are streamable via /music/<id>.mp3.

interface LibraryTrack {
  id: 'calm' | 'ambient' | 'upbeat'
  label: string
  description: string
  emoji: string
}

const LIBRARY_TRACKS: LibraryTrack[] = [
  {
    id: 'calm',
    label: 'Calm',
    description: 'Slow ambient pad · A major triad · low-pass filtered',
    emoji: '🌙'
  },
  {
    id: 'ambient',
    label: 'Ambient',
    description: 'Airy pad · D minor · high-pass + slow tremolo',
    emoji: '🌫️'
  },
  {
    id: 'upbeat',
    label: 'Upbeat',
    description: 'Pulsing rhythm · C major · faster tremolo (1.5 Hz)',
    emoji: '✨'
  }
]

// ─── fetchJson with retry ───────────────────────────────────────────────────
//
// Robust fetch wrapper that retries up to 3 times on:
//   - fetch() throwing (network error — "Failed to fetch")
//   - HTTP 5xx server errors (transient)
//
// This handles transient dev-server issues (e.g. server briefly unreachable,
// route mid-compile, HMR reconnect) that previously surfaced to the user as
// a bare "Failed to fetch" error with no recovery path.

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown }> {
  const MAX_ATTEMPTS = 3
  const RETRY_DELAY_MS = 1500
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init)
      let json: unknown = null
      try {
        json = await res.json()
      } catch {
        /* ignore — non-JSON response */
      }
      // Retry on 5xx (server errors are often transient: route mid-compile,
      // dev server restarting, etc.). Don't retry 4xx (client error).
      if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      return { ok: res.ok, status: res.status, json }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      // fetch() threw — network-level error (e.g. "Failed to fetch"). Retry
      // if attempts remain; surface a clearer message to the user.
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
    }
  }
  throw lastErr ?? new Error('Network request failed after multiple attempts')
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

const STAGE_DESC_BASE: Record<Stage, string> = {
  preparing: 'Verifying images and staging audio…',
  assembling: 'Encoding H.264 video with Ken Burns motion + crossfade transitions…',
  finalizing: 'Writing moov atom for web playback…',
  done: 'Your video is ready to preview and download.',
  error: 'The video assembly failed.'
}

/** Phase 6 P4 — resolution-aware stage description. Shows 'Encoding in 4K...'
 *  when the user opted into 4K, mirroring the user's requested label. */
function stageDescription(stage: Stage, resolution: '1080p' | '4k'): string {
  if (stage === 'assembling') {
    return resolution === '4k'
      ? 'Encoding in 4K (3840×2160) — this takes 2-3× longer than 1080p, please be patient…'
      : 'Encoding 1920×1080 H.264 with Ken Burns motion + crossfade transitions…'
  }
  return STAGE_DESC_BASE[stage]
}

// ─── Realistic time estimate (for big jobs) ──────────────────────────────────

/** Phase 6 P4 — resolution-aware build-time estimate. 4K has ~4× the
 *  pixels → ~2.5× the encode time (not 4× because some of the cost is
 *  fixed overhead, not pixel-bound). */
function estimateBuildSeconds(imageCount: number, audioDuration: number, resolution: '1080p' | '4k' = '1080p'): number {
  // Empirically: ~0.045s per image-second of output (30fps H.264 medium preset,
  // single-pass concat-filter on this box). Plus ~3s fixed overhead.
  const outSeconds = audioDuration
  const perImageSecond = 0.045
  const resMultiplier = resolution === '4k' ? 2.5 : 1
  return Math.round(outSeconds * perImageSecond * Math.sqrt(imageCount) * resMultiplier + 3)
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FinalVideoCard({
  imageJobId,
  imageCount,
  voiceover,
  script,
  onStatusChange
}: FinalVideoCardProps) {
  const { toast } = useToast()
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // ── Phase 5A — Background music state ──
  // 'none' (off) by default — the video builds without music as before.
  // 'library' uses one of the bundled royalty-free tracks.
  // 'upload' uses a user-provided MP3 staged via /api/video/music/upload.
  const [musicSource, setMusicSource] = useState<'none' | 'library' | 'upload'>('none')
  const [libraryTrack, setLibraryTrack] = useState<'calm' | 'ambient' | 'upbeat'>('calm')
  const [uploadedFile, setUploadedFile] = useState<{ fileId: string; fileName: string; durationSeconds: number } | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // <audio> ref for the in-card music preview player.
  const previewAudioRef = useRef<HTMLAudioElement>(null)

  // Phase 5A fix — Track which library track is currently being previewed
  // so the button label can toggle between "Preview" and "Stop", and the
  // user gets visual confirmation that playback is happening. This was the
  // root cause of the user-reported "preview play nahi ho raha" issue: the
  // audio was actually playing (currentTime was advancing) but there was no
  // visual feedback, so the user thought the button was broken.
  const [previewingTrack, setPreviewingTrack] = useState<'calm' | 'ambient' | 'upbeat' | null>(null)

  // ── Phase 5B — On-screen captions ──
  // 'off' by default — optional feature. When ON, the rewritten script is
  // split into imageCount segments and burned into each clip via FFmpeg's
  // drawtext filter (white text + thick black outline, bottom-center).
  // Variable pacing is always-on when the script is available (it doesn't
  // change the visual style — just distributes durations more intelligently).
  const [captionsEnabled, setCaptionsEnabled] = useState(false)

  // ── Phase 6 P1 — Smart Transitions ──
  // 'off' by default — optional feature. When ON, Pass 2 uses FFmpeg's xfade
  // filter to blend consecutive clips with content-aware transitions: gentle
  // fade/dissolve when the narration stays on the same topic, sharper
  // slide/wipe when the topic changes. Replaces the legacy fade-through-black.
  const [transitionsEnabled, setTransitionsEnabled] = useState(false)

  // ── Phase 6 P2 — Title Card ──
  // 'off' by default — optional feature. When ON, the backend calls the LLM
  // to generate a short catchy title from the rewritten script, encodes a 2.5s
  // intro clip (first image blurred+darkened + the title text), and prepends
  // it to the video. The voiceover is delayed by 2.5s so the title card plays
  // silently (or with music at full volume) at the start.
  const [titleCardEnabled, setTitleCardEnabled] = useState(false)

  // ── Phase 6 P2 — Text Highlights ──
  // 'off' by default — optional feature. When ON, the backend calls the LLM
  // to identify 3-5 key moments (stats, quotes) in the script, then burns a
  // bold yellow text overlay onto those specific clips (fades in/out over the
  // first ~2.5s, positioned in the upper-third so it never overlaps with the
  // bottom captions).
  const [textHighlightsEnabled, setTextHighlightsEnabled] = useState(false)

  // ── Phase 6 P3 — Outro End Card ──
  // 'off' by default — optional feature. When ON, the backend calls the LLM
  // to generate a short topic-relevant CTA (e.g. "Subscribe for more 1%
  // habits"), encodes a 3.5s outro clip (last image blurred+darkened +
  // "Thanks for watching" + the CTA, both fading in/out), and appends it to
  // the end of the video. The music (if on) continues through the outro and
  // fades out gracefully at the very end.
  const [outroEnabled, setOutroEnabled] = useState(false)

  // Phase 6 P4 — Output resolution selector. Default '1080p' (Full HD).
  // '4k' (Ultra HD) is opt-in: ~2-3× slower encode + ~4× per-clip memory.
  // The two-pass sequential pipeline keeps each step bounded so 4K won't OOM.
  const [resolution, setResolution] = useState<'1080p' | '4k'>('1080p')

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

    // Validate music upload state before firing the request.
    if (musicSource === 'upload' && !uploadedFile) {
      toast({
        variant: 'destructive',
        title: 'Music not uploaded',
        description: 'Upload an audio file (MP3/WAV) or switch to a library track.'
      })
      return
    }

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
          mimeType: voiceover.mimeType,
          // Phase 5A — music:
          musicSource,
          musicTrack: musicSource === 'library' ? libraryTrack : undefined,
          musicFileId: musicSource === 'upload' && uploadedFile ? uploadedFile.fileId : undefined,
          // Phase 5B — captions + variable pacing:
          // Always send the script if we have it so the backend can use it
          // for variable pacing (even when captions are off). The backend
          // only burns captions when captionsEnabled is true.
          script: typeof script === 'string' ? script : undefined,
          captionsEnabled,
          transitionsEnabled,
          // Phase 6 P2 — Title card + text highlights (the backend calls the
          // LLM to generate the actual title text + identify the highlight
          // moments — the frontend just toggles the feature on/off).
          titleCardEnabled,
          textHighlightsEnabled,
          // Phase 6 P3 — Outro end card (the backend calls the LLM to generate
          // a topic-relevant CTA — the frontend just toggles the feature on/off).
          outroEnabled,
          // Phase 6 P4 — Output resolution. '1080p' default, '4k' opt-in.
          resolution
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
      const isNetworkErr =
        err instanceof Error &&
        (err.message === 'Failed to fetch' ||
          err.message.includes('Network request failed') ||
          err.message.includes('fetch failed'))
      const message = isNetworkErr
        ? 'Could not reach the video API after 3 retries. The dev server may have been briefly unreachable — please try again.'
        : err instanceof Error
          ? err.message
          : 'Could not start the video job.'
      setStatus('error')
      setErrorMsg(message)
      notifyStatus('error')
      toast({
        variant: 'destructive',
        title: 'Could not start video',
        description: message
      })
    }
  }, [
    canGenerate,
    imageJobId,
    imageCount,
    notifyStatus,
    startPolling,
    toast,
    voiceover,
    musicSource,
    libraryTrack,
    uploadedFile,
    script,
    captionsEnabled,
    transitionsEnabled,
    titleCardEnabled,
    textHighlightsEnabled,
    outroEnabled,
    resolution
  ])

  // ── Phase 5A: handle a user-uploaded music file ──
  const handleMusicUpload = useCallback(
    async (file: File) => {
      if (!file) return

      // Client-side sanity: size + extension.
      if (file.size > 30 * 1024 * 1024) {
        toast({
          variant: 'destructive',
          title: 'File too large',
          description: 'Max 30MB. Pick a smaller music file.'
        })
        return
      }
      const ext = (file.name.toLowerCase().split('.').pop() ?? '').trim()
      const allowed = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']
      if (!allowed.includes(ext)) {
        toast({
          variant: 'destructive',
          title: 'Unsupported file',
          description: `Allowed: ${allowed.join(', ')}. You uploaded ".${ext}".`
        })
        return
      }

      setIsUploading(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch('/api/video/music/upload', { method: 'POST', body: fd })
        const data = (await res.json()) as {
          fileId?: string
          fileName?: string
          durationSeconds?: number
          error?: string
        }
        if (!res.ok || !data.fileId) {
          throw new Error(data.error || `Upload failed (status ${res.status})`)
        }
        setUploadedFile({
          fileId: data.fileId,
          fileName: data.fileName ?? file.name,
          durationSeconds: data.durationSeconds ?? 0
        })
        toast({
          title: 'Music uploaded',
          description: `${data.fileName} · ${formatSeconds(data.durationSeconds ?? 0)} ready for use.`
        })
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Upload failed',
          description: err instanceof Error ? err.message : 'Unknown error'
        })
      } finally {
        setIsUploading(false)
      }
    },
    [toast]
  )

  const handleRetry = useCallback(() => {
    setStatus('idle')
    setErrorMsg(null)
    setJob(null)
    notifyStatus('idle')
  }, [notifyStatus])

  // ── Phase 5A fix: Preview/Stop a library track via the hidden <audio> ──
  //
  // The original inline handler silently swallowed play() rejections
  // (`.catch(() => {})`), so the user had no idea whether playback was
  // actually happening. In practice the audio WAS playing (currentTime was
  // advancing) but there was no visual feedback, so the user thought the
  // button was broken ("preview play nahi ho raha").
  //
  // Fix: surface errors via toast, toggle button label to "Stop", show a
  // pulsing equaliser indicator on the currently-playing track.
  const handlePreviewTrack = useCallback(
    async (trackId: 'calm' | 'ambient' | 'upbeat') => {
      const a = previewAudioRef.current
      if (!a) return

      // If this track is already playing → pause + reset, clear state.
      if (previewingTrack === trackId && !a.paused) {
        a.pause()
        a.currentTime = 0
        setPreviewingTrack(null)
        return
      }

      // Otherwise: load this track and play. Use load() after setting src
      // to explicitly trigger the media resource selection algorithm so
      // play() doesn't race against an unfinished load.
      const wantSrc = `/music/${trackId}.mp3`
      a.src = wantSrc
      a.setAttribute('data-track', trackId)
      a.load()
      try {
        await a.play()
        setPreviewingTrack(trackId)
        const track = LIBRARY_TRACKS.find((t) => t.id === trackId)
        toast({
          title: 'Previewing track',
          description: `${track?.label ?? trackId} · click again to stop`
        })
      } catch (err) {
        // Browser autoplay policy shouldn't block this (user clicked),
        // but other failures (network, decode) can happen — surface them.
        setPreviewingTrack(null)
        const reason = err instanceof Error ? err.message : String(err)
        toast({
          variant: 'destructive',
          title: 'Preview failed',
          description: `Could not play ${trackId}.mp3 — ${reason}`
        })
      }
    },
    [previewingTrack, toast]
  )

  // When the audio element finishes naturally, clear the playing indicator.
  useEffect(() => {
    const a = previewAudioRef.current
    if (!a) return
    const onEnded = () => setPreviewingTrack(null)
    const onPause = () => {
      // If the user paused via right-click context menu, sync state.
      if (a.currentTime === 0) setPreviewingTrack(null)
    }
    a.addEventListener('ended', onEnded)
    a.addEventListener('pause', onPause)
    return () => {
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('pause', onPause)
    }
  }, [])

  // ── Download URL ──
  const downloadUrl = job && status === 'done' ? `/api/video/download?jobId=${encodeURIComponent(job.jobId)}` : null

  // ── Estimated time (shown before user starts, to set expectations) ──
  const estimatedBuild =
    imageCount && voiceover ? estimateBuildSeconds(imageCount, voiceover.durationSeconds, resolution) : null

  // ── Render ──
  return (
    <Card className="border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600/15 ring-1 ring-red-600/30">
              <Clapperboard className="h-5 w-5 text-red-400" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-lg text-zinc-100">Final Video Assembly</CardTitle>
              <CardDescription className="text-zinc-400">
                Stitch voiceover + images into a single {resolution === '4k' ? '3840×2160 (4K)' : '1920×1080 (Full HD)'} H.264 MP4.
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
            hint={`MP4 · ${resolution === '4k' ? '4K' : '1080p'}`}
          />
        </div>

        {/* Action area */}
        {status === 'idle' && (
          <div className="space-y-4">
            {/* ── Phase 5A — Professional polish panel ── */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              {/* Ken Burns — always on, informational chip */}
              <div className="mb-3 flex items-center gap-2 text-xs text-zinc-400">
                <Sparkles className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                <span>
                  <span className="text-zinc-200">Ken Burns motion</span> is enabled — every image
                  gets a subtle, varied zoom/pan (documentary style).
                </span>
              </div>

              {/* Phase 5B — Variable pacing (informational chip).
                  Always-on when the script is available (no toggle) because
                  it's a pure quality improvement with no visual side-effects. */}
              <div className="mb-3 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
                <Gauge className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                <span>
                  <span className="text-zinc-200">Variable pacing</span>
                  {script && script.trim().length >= 20 ? (
                    <> is on — longer narration segments get more time (3–5s/image, total = voiceover length).</>
                  ) : (
                    <> needs the rewritten script — generate one to enable per-image timing.</>
                  )}
                </span>
              </div>

              {/* Phase 5B — Captions toggle */}
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex items-center gap-2">
                  <Captions className="h-4 w-4 text-sky-400" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-zinc-100">On-screen captions</div>
                    <div className="text-[11px] text-zinc-500">
                      Burned-in (YouTube Shorts style) · sync with voiceover · optional
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={captionsEnabled}
                  aria-label="Toggle on-screen captions"
                  onClick={() => setCaptionsEnabled((c) => !c)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    captionsEnabled ? 'bg-sky-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      captionsEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {captionsEnabled && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {script && script.trim().length >= 20 ? (
                    <>Captions will be drawn from the rewritten script — one segment per image, bold white text with black outline at the bottom of the frame.</>
                  ) : (
                    <span className="text-amber-400/80">
                      No script available — captions need the rewritten narration. Generate one in step 1.
                    </span>
                  )}
                </p>
              )}

              {/* Phase 6 P4 — Output resolution selector (1080p default, 4K opt-in). */}
              <div className="border-t border-zinc-800 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                    <div>
                      <div className="text-sm font-medium text-zinc-100">Output resolution</div>
                      <div className="text-[11px] text-zinc-500">
                        {resolution === '4k'
                          ? '3840×2160 Ultra HD · ~2-3× slower + more memory'
                          : '1920×1080 Full HD · fast default'}
                      </div>
                    </div>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Output resolution"
                    className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={resolution === '1080p'}
                      aria-label="1080p Full HD"
                      onClick={() => setResolution('1080p')}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        resolution === '1080p'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      1080p
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={resolution === '4k'}
                      aria-label="4K Ultra HD"
                      onClick={() => setResolution('4k')}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        resolution === '4k'
                          ? 'bg-cyan-600 text-white shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      4K
                    </button>
                  </div>
                </div>
                {resolution === '4k' && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-400/90">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    <span>
                      <span className="font-medium">4K heads-up:</span> processing takes{' '}
                      <span className="font-semibold">2-3× longer</span> and uses more memory.
                      The two-pass pipeline stays memory-safe (each clip encoded sequentially,
                      no full-batch buffering) so it won&apos;t crash — just be patient. All
                      other features (Ken Burns, transitions, captions, title card, highlights,
                      outro, music) work identically at 4K.
                    </span>
                  </p>
                )}
              </div>

              {/* Phase 6 P1 — Smart Transitions toggle */}
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex items-center gap-2">
                  <Shuffle className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Smart transitions</div>
                    <div className="text-[11px] text-zinc-500">
                      Content-aware fade / slide / wipe between clips · optional
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={transitionsEnabled}
                  aria-label="Toggle smart transitions"
                  onClick={() => setTransitionsEnabled((c) => !c)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    transitionsEnabled ? 'bg-amber-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      transitionsEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {transitionsEnabled && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {script && script.trim().length >= 20 ? (
                    <>Transitions are chosen per cut by narration similarity — gentle fade/dissolve within a scene, sharper slide/wipe when the topic changes. Replaces fade-through-black.</>
                  ) : (
                    <span className="text-amber-400/80">
                      No script available — transitions will use a fixed rotation. Generate a rewritten script for content-aware selection.
                    </span>
                  )}
                </p>
              )}

              {/* Phase 6 P2 — Title Card toggle */}
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex items-center gap-2">
                  <Type className="h-4 w-4 text-red-400" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Title card</div>
                    <div className="text-[11px] text-zinc-500">
                      LLM-generated title at the start (2.5s) · optional
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={titleCardEnabled}
                  aria-label="Toggle title card"
                  onClick={() => setTitleCardEnabled((c) => !c)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    titleCardEnabled ? 'bg-red-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      titleCardEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {titleCardEnabled && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {script && script.trim().length >= 20 ? (
                    <>An AI title is auto-generated from the rewritten script (e.g. “The Power of Small Habits”). It fades in over a blurred+darkened first image, then the narration begins.</>
                  ) : (
                    <span className="text-amber-400/80">
                      No script available — the title is generated from the rewritten narration. Generate one in step 3.
                    </span>
                  )}
                </p>
              )}

              {/* Phase 6 P2 — Text Highlights toggle */}
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex items-center gap-2">
                  <Highlighter className="h-4 w-4 text-yellow-400" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Text highlights</div>
                    <div className="text-[11px] text-zinc-500">
                      Bold overlay on key moments (stats, quotes) · optional
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={textHighlightsEnabled}
                  aria-label="Toggle text highlights"
                  onClick={() => setTextHighlightsEnabled((c) => !c)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    textHighlightsEnabled ? 'bg-yellow-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      textHighlightsEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {textHighlightsEnabled && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {script && script.trim().length >= 20 ? (
                    <>The AI scans the narration for statistics + power statements (e.g. “37 times better”) and overlays a short bold text on those specific clips — max 5 per video, upper-third so captions stay clear.</>
                  ) : (
                    <span className="text-amber-400/80">
                      No script available — highlights need the rewritten narration. Generate one in step 3.
                    </span>
                  )}
                </p>
              )}

              {/* Outro end card toggle (Phase 6 P3) */}
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex items-center gap-2">
                  <ThumbsUp className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Outro end card</div>
                    <div className="text-[11px] text-zinc-500">
                      “Thanks for watching” + subscribe CTA at the end · optional
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={outroEnabled}
                  aria-label="Toggle outro end card"
                  onClick={() => setOutroEnabled((c) => !c)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    outroEnabled ? 'bg-emerald-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      outroEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {outroEnabled && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {script && script.trim().length >= 20 ? (
                    <>A 3.5s end card is appended after the last clip — the last image is blurred + darkened, with “Thanks for watching” and a short subscribe CTA (auto-generated from the script topic, e.g. “Subscribe for more 1% habits”) fading in. Music keeps playing and fades out gracefully.</>
                  ) : (
                    <span className="text-amber-400/80">
                      No script available — the outro CTA is auto-generated from the narration. Generate one in step 3.
                    </span>
                  )}
                </p>
              )}

              {/* Music toggle */}
              <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex items-center gap-2">
                  <Music className="h-4 w-4 text-fuchsia-400" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Background music</div>
                    <div className="text-[11px] text-zinc-500">
                      Auto-ducked under voiceover · optional
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={musicSource !== 'none'}
                  aria-label="Toggle background music"
                  onClick={() => {
                    // Turning music off → also stop any in-flight preview.
                    if (musicSource !== 'none') {
                      const a = previewAudioRef.current
                      if (a) {
                        a.pause()
                        a.currentTime = 0
                        a.removeAttribute('src')
                        a.load()
                      }
                      setPreviewingTrack(null)
                    }
                    setMusicSource((s) => (s === 'none' ? 'library' : 'none'))
                  }}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    musicSource !== 'none' ? 'bg-fuchsia-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      musicSource !== 'none' ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              {/* Music source options — only shown when music is enabled */}
              {musicSource !== 'none' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ duration: 0.2 }}
                  className="mt-3 space-y-3 border-t border-zinc-800 pt-3"
                >
                  {/* Source tab: library vs upload */}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        // Switching away from library → stop preview playback.
                        if (musicSource === 'library' && previewingTrack) {
                          const a = previewAudioRef.current
                          if (a) {
                            a.pause()
                            a.currentTime = 0
                          }
                          setPreviewingTrack(null)
                        }
                        setMusicSource('library')
                      }}
                      className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                        musicSource === 'library'
                          ? 'border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-200'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      Free Library
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (musicSource === 'library' && previewingTrack) {
                          const a = previewAudioRef.current
                          if (a) {
                            a.pause()
                            a.currentTime = 0
                          }
                          setPreviewingTrack(null)
                        }
                        setMusicSource('upload')
                      }}
                      className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                        musicSource === 'upload'
                          ? 'border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-200'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      Upload MP3
                    </button>
                  </div>

                  {musicSource === 'library' && (
                    <div className="space-y-2">
                      {LIBRARY_TRACKS.map((track) => {
                        const isPlayingThis = previewingTrack === track.id
                        return (
                          <div
                            key={track.id}
                            className={`flex items-start gap-3 rounded-md border p-3 transition-colors ${
                              libraryTrack === track.id
                                ? 'border-fuchsia-500/50 bg-fuchsia-500/10'
                                : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
                            } ${isPlayingThis ? 'ring-1 ring-fuchsia-500/40' : ''}`}
                          >
                            <label className="flex flex-1 min-w-0 cursor-pointer items-start gap-3">
                              <input
                                type="radio"
                                name="library-track"
                                value={track.id}
                                checked={libraryTrack === track.id}
                                onChange={() => setLibraryTrack(track.id)}
                                className="sr-only"
                              />
                              <div className="text-xl leading-none">{track.emoji}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                                  {track.label}
                                  {isPlayingThis && (
                                    <span className="flex items-end gap-0.5" aria-label="Now playing">
                                      <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-fuchsia-400" style={{ animationDelay: '0ms' }} />
                                      <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-fuchsia-400" style={{ animationDelay: '150ms' }} />
                                      <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-fuchsia-400" style={{ animationDelay: '300ms' }} />
                                      <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-fuchsia-400" style={{ animationDelay: '450ms' }} />
                                    </span>
                                  )}
                                </div>
                                <div className="truncate text-[11px] text-zinc-500">
                                  {track.description}
                                </div>
                              </div>
                            </label>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                handlePreviewTrack(track.id)
                              }}
                              className={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                isPlayingThis
                                  ? 'border-fuchsia-500/60 bg-fuchsia-500/15 text-fuchsia-200'
                                  : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                              }`}
                              aria-label={isPlayingThis ? `Stop previewing ${track.label}` : `Preview ${track.label} track`}
                            >
                              {isPlayingThis ? (
                                <>
                                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-fuchsia-300 align-middle" aria-hidden="true" />
                                  Stop
                                </>
                              ) : (
                                <>
                                  <Volume2 className="mr-1 inline h-3 w-3" aria-hidden="true" />
                                  Preview
                                </>
                              )}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {musicSource === 'upload' && (
                    <div className="space-y-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/flac,.mp3,.wav,.m4a,.aac,.ogg,.flac"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) handleMusicUpload(f)
                          // Clear so the same file can be re-selected later.
                          if (fileInputRef.current) fileInputRef.current.value = ''
                        }}
                        className="hidden"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="w-full border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                      >
                        {isUploading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            Uploading…
                          </>
                        ) : (
                          <>
                            <Upload className="h-4 w-4" aria-hidden="true" />
                            Choose audio file
                          </>
                        )}
                      </Button>
                      {uploadedFile ? (
                        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                          <div className="font-medium">{uploadedFile.fileName}</div>
                          <div className="text-emerald-200/70">
                            {formatSeconds(uploadedFile.durationSeconds)} · ready for use
                          </div>
                        </div>
                      ) : (
                        <p className="text-center text-[11px] text-zinc-500">
                          Max 30MB · MP3 / WAV / M4A / AAC / OGG / FLAC
                        </p>
                      )}
                    </div>
                  )}

                  {/* Ducking note */}
                  <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    <Volume2 className="h-3 w-3" aria-hidden="true" />
                    Music is auto-ducked under the voiceover (sidechain compression) —
                    louder during intro/outro, quieter during narration.
                  </p>
                </motion.div>
              )}
            </div>

            <Button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="w-full bg-gradient-to-r from-red-600 to-orange-500 text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-orange-400 hover:shadow-red-600/40 disabled:opacity-50"
            >
              <Clapperboard className="h-4 w-4" aria-hidden="true" />
              Generate Video
            </Button>
            {missingReason && (
              <p className="text-center text-xs text-zinc-500">{missingReason}</p>
            )}
            {canGenerate && estimatedBuild && (
              <p className="text-center text-xs text-zinc-500">
                Heavy FFmpeg encode — estimated {formatSeconds(estimatedBuild)} for {imageCount} images. Runs in the background.
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
            <p className="text-xs text-zinc-500">{stageDescription(job.stage, job.resolution ?? '1080p')}</p>
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
                {formatBytes(job.fileSize ?? 0)} ·{' '}
                {job.videoWidth && job.videoHeight
                  ? `${job.videoWidth}×${job.videoHeight}`
                  : job.resolution === '4k'
                    ? '3840×2160'
                    : '1920×1080'}{' '}
                H.264 MP4
              </AlertDescription>
            </Alert>

            {/* Phase 5A — feature chips */}
            <div className="flex flex-wrap gap-2">
              {job.kenBurnsApplied && (
                <Badge className="gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-300">
                  <Sparkles className="h-3 w-3" aria-hidden="true" /> Ken Burns motion
                </Badge>
              )}
              {job.variablePacingApplied && (
                <Badge className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                  <Gauge className="h-3 w-3" aria-hidden="true" /> Variable pacing
                </Badge>
              )}
              {job.captionsApplied && (
                <Badge className="gap-1.5 border-sky-500/40 bg-sky-500/10 text-sky-300">
                  <Captions className="h-3 w-3" aria-hidden="true" /> Captions
                </Badge>
              )}
              {job.transitionsApplied && (
                <Badge className="gap-1.5 border-orange-500/40 bg-orange-500/10 text-orange-300">
                  <Shuffle className="h-3 w-3" aria-hidden="true" /> Smart transitions
                </Badge>
              )}
              {job.titleCardApplied && (
                <Badge className="gap-1.5 border-red-500/40 bg-red-500/10 text-red-300">
                  <Type className="h-3 w-3" aria-hidden="true" /> Title card
                </Badge>
              )}
              {job.textHighlightsApplied && (
                <Badge className="gap-1.5 border-yellow-500/40 bg-yellow-500/10 text-yellow-300">
                  <Highlighter className="h-3 w-3" aria-hidden="true" /> Highlights: {job.textHighlightsCount ?? 0}
                </Badge>
              )}
              {job.outroApplied && (
                <Badge className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                  <ThumbsUp className="h-3 w-3" aria-hidden="true" /> Outro
                </Badge>
              )}
              {job.musicLabel && (
                <Badge className="gap-1.5 border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300">
                  <Music className="h-3 w-3" aria-hidden="true" />
                  Music: {job.musicLabel === 'upload' ? 'uploaded' : job.musicLabel}
                </Badge>
              )}
              {!job.musicLabel && (
                <Badge className="gap-1.5 border-zinc-700 bg-zinc-900/60 text-zinc-400">
                  No background music
                </Badge>
              )}
              {/* Phase 6 P4 — Resolution badge. Shows the ffprobe-verified
                  geometry when available; otherwise the requested label. */}
              <Badge className="gap-1.5 border-cyan-500/40 bg-cyan-500/10 text-cyan-300">
                <Monitor className="h-3 w-3" aria-hidden="true" />
                {job.videoWidth && job.videoHeight
                  ? `${job.resolution === '4k' ? '4K' : '1080p'} · ${job.videoWidth}×${job.videoHeight}`
                  : job.resolution === '4k'
                    ? '4K · 3840×2160'
                    : '1080p · 1920×1080'}
              </Badge>
            </div>

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
              <Button asChild className="bg-gradient-to-r from-red-600 to-orange-500 text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-orange-400 hover:shadow-red-600/40">
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

        {/* Hidden audio element used by the music library Preview buttons. */}
        <audio ref={previewAudioRef} preload="none" className="hidden" aria-hidden="true" />
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

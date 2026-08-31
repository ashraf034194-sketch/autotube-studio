'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Youtube,
  FileText,
  WandSparkles,
  Check,
  Lock,
  Loader2,
  AlertCircle,
  Sparkles,
  Type,
  Clock3,
  Play,
  RotateCcw,
  Download,
  Eraser,
  Mic,
  ImageIcon,
  Clapperboard,
  Film,
  Zap,
  ShieldCheck,
  Palette,
  Music,
  Settings2,
  ChevronDown
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useToast } from '@/hooks/use-toast'
import {
  STYLE_OPTIONS,
  LIGHTING_OPTIONS,
  COMPOSITION_OPTIONS
} from '@/lib/flow-studio/types'
import type {
  AutopilotSnapshot,
  AutopilotSettings,
  ImageSlotLive
} from '@/lib/autopilot/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_CHARS = 50

const SAMPLE_SCRIPT = `Hey everyone, welcome back to the channel. Today we are diving into something that quietly shapes almost everything you do: habits. Researchers estimate that around forty percent of the actions you perform every single day are not conscious decisions at all. They are habits, running on autopilot.

So how does this autopilot actually work? Every habit follows a three step loop. First, there is a cue, something in your environment that triggers the behavior. Second, there is the routine, which is the behavior itself. And third, there is the reward, the small hit of satisfaction that teaches your brain to repeat the loop again next time.

The good news is that you can hack this loop. Want to stop scrolling your phone at night? Make the cue invisible. Leave the charger in another room. Want to start exercising? Make the reward obvious. Track your streaks and celebrate the small wins.

Remember, you do not rise to the level of your goals. You fall to the level of your systems. Thanks for watching, and I will see you in the next one.`

const VOICE_OPTIONS = [
  { value: 'en-US-ChristopherNeural', label: 'Christopher · deep male narrator' },
  { value: 'en-US-AndrewNeural', label: 'Andrew · warm male' },
  { value: 'en-US-GuyNeural', label: 'Guy · energetic news anchor' },
  { value: 'en-US-BrianNeural', label: 'Brian · smooth male' },
  { value: 'en-US-AriaNeural', label: 'Aria · professional female' },
  { value: 'en-US-MichelleNeural', label: 'Michelle · warm female' },
  { value: 'en-GB-RyanNeural', label: 'Ryan · British male' },
  { value: 'en-GB-SoniaNeural', label: 'Sonia · British female' }
]

const SPEED_OPTIONS = [
  { value: '0.85', label: '0.85× · relaxed' },
  { value: '1.0', label: '1.0× · normal' },
  { value: '1.15', label: '1.15× · brisk' },
  { value: '1.3', label: '1.3× · fast' }
]

const MUSIC_OPTIONS = [
  { value: 'none', label: 'No music' },
  { value: 'calm', label: 'Calm · slow ambient pad' },
  { value: 'ambient', label: 'Ambient · airy pad' },
  { value: 'upbeat', label: 'Upbeat · pulsing rhythm' }
]

const RESOLUTION_OPTIONS = [
  { value: '1080p', label: '1080p · Full HD (fast)' },
  { value: '4k', label: '4K · Ultra HD (slow)' }
]

const DEFAULT_SETTINGS: AutopilotSettings = {
  voice: 'en-US-ChristopherNeural',
  speed: 1.0,
  visualStyle: 'cinematic',
  customStyle: '',
  lighting: 'cinematic-light',
  composition: 'medium-shot',
  customComposition: '',
  music: 'none',
  resolution: '1080p',
  captions: true,
  transitions: true,
  titleCard: true,
  highlights: true,
  outro: true
}

const STAGE_ICONS: Record<string, typeof WandSparkles> = {
  rewrite: WandSparkles,
  voiceover: Mic,
  prompts: Palette,
  images: ImageIcon,
  video: Clapperboard
}

const STAGE_TAGLINES: Record<string, string> = {
  rewrite: 'The script doctor rewrites your transcript into a fresh, original narration script.',
  voiceover: 'A neural voice narrates the rewritten script, split into perfectly timed segments.',
  prompts: 'The Flow Prompt Studio engine designs a Style DNA and writes one image prompt per narration chunk.',
  images: 'Images are generated batch-wise (junctions of 20) — each anchored to its exact narration chunk.',
  video: 'FFmpeg assembles clips, captions, music and motion into the finished MP4.'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/** Fetch wrapper that never chokes on non-JSON (e.g. HTML error pages). */
async function fetchJson(
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  const raw = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw)
  } catch {
    console.error(`[${url}] Non-JSON response (status ${res.status}):`, raw.slice(0, 300))
    throw new Error(
      res.status >= 500
        ? 'The server hit an internal error while processing this request. Please try again in a moment.'
        : `The server returned an unexpected response (status ${res.status}). Please try again.`
    )
  }
  return { ok: res.ok, status: res.status, json }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const { toast } = useToast()

  const [transcript, setTranscript] = useState('')
  const [settings, setSettings] = useState<AutopilotSettings>(DEFAULT_SETTINGS)
  const [runId, setRunId] = useState<string | null>(null)
  const [snap, setSnap] = useState<AutopilotSnapshot | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

  const isRunning = snap === null ? false : snap.status === 'running'
  const busy = starting || isRunning
  const terminalStatus = snap?.status === 'completed' || snap?.status === 'failed'
  type SnapStatus = 'running' | 'completed' | 'failed' | null
  const notifRef = useRef<SnapStatus | null>(null)

  // 1s clock while a run is active (drives the elapsed timer).
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])

  // Poll the autopilot snapshot while the run is active.
  useEffect(() => {
    if (!runId || terminalStatus) return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`/api/autopilot?id=${encodeURIComponent(runId)}`, {
          cache: 'no-store'
        })
        if (!res.ok) {
          if (res.status === 404) {
            if (!cancelled) {
              setSnap(null)
              setStartError('The autopilot run was lost (it may have expired). Please start again.')
              setRunId(null)
            }
            return
          }
          return // transient — keep polling
        }
        const data = (await res.json()) as AutopilotSnapshot
        if (!cancelled) setSnap(data)
      } catch {
        // transient network blip — keep polling
      }
    }

    void poll()
    const id = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [runId, terminalStatus])

  // Terminal-transition toasts (fire exactly once per run).
  useEffect(() => {
    const s = snap?.status ?? null
    if (!s || s === 'running') {
      notifRef.current = s
      return
    }
    if (notifRef.current !== s) {
      notifRef.current = s
      if (s === 'completed') {
        toast({
          title: 'Video ready 🎬',
          description: 'The autopilot finished your video — scroll to the player and download it.'
        })
      } else if (s === 'failed') {
        toast({
          variant: 'destructive',
          title: 'Autopilot failed',
          description: snap?.error ?? 'The pipeline hit an error.'
        })
      }
    }
  }, [snap?.status, snap?.error, toast])

  // ── Derived input stats ──
  const inputWords = useMemo(
    () => (transcript.trim() ? transcript.trim().split(/\s+/).length : 0),
    [transcript]
  )
  const inputChars = transcript.length
  const estVoSeconds = Math.round((inputWords / 150) * 60)
  const estImages = Math.max(1, Math.round(estVoSeconds / 4))
  const tooShort = inputChars > 0 && inputChars < MIN_CHARS

  // ── Start the autopilot ──
  const startAutopilot = useCallback(async () => {
    if (busy) return
    if (inputChars < MIN_CHARS) {
      setStartError(`Please paste a script of at least ${MIN_CHARS} characters.`)
      return
    }
    setStartError(null)
    setSnap(null)
    setStarting(true)
    try {
      const { ok, json } = await fetchJson('/api/autopilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, settings })
      })
      const autopilotId = json.autopilotId as string | undefined
      if (!ok || !autopilotId) {
        throw new Error((json.error as string) || 'The autopilot could not be started.')
      }
      setRunId(autopilotId)
      toast({
        title: 'Autopilot engaged',
        description: 'Script received. The pipeline now runs end-to-end by itself — sit back.'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The autopilot could not be started.'
      setStartError(message)
      toast({ variant: 'destructive', title: 'Could not start', description: message })
    } finally {
      setStarting(false)
    }
  }, [busy, inputChars, transcript, settings, toast])

  const resetRun = useCallback(() => {
    setRunId(null)
    setSnap(null)
    setStartError(null)
    notifRef.current = null
  }, [])

  const update = useCallback(<K extends keyof AutopilotSettings>(
    key: K,
    value: AutopilotSettings[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  const elapsedSec = snap ? Math.max(0, Math.round(((snap.doneAt ?? nowTick) - snap.createdAt) / 1000)) : 0

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* ── Header ── */}
      <header className="border-b border-zinc-800/70 bg-zinc-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 border border-amber-500/30">
              <Youtube className="h-5 w-5 text-amber-400" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight">AutoTube Studio</h1>
              <p className="text-[11px] text-zinc-500">Autopilot · end-to-end video pipeline</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="hidden border-emerald-500/30 bg-emerald-500/10 text-emerald-400 sm:inline-flex"
            >
              <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
              Zero API keys
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-400"
            >
              <Zap className="mr-1 h-3 w-3" aria-hidden="true" />
              Fully automated
            </Badge>
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {/* Hero */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-6 sm:mb-8"
          aria-labelledby="hero-heading"
        >
          <h2
            id="hero-heading"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            Paste a script. <span className="text-amber-400">Get a finished video.</span>
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            Your only job is the script. The autopilot agent rewrites it, narrates it, writes
            image prompts with the Flow&nbsp;Prompt&nbsp;Studio engine, generates the full image
            batch, and edits everything into a finished MP4 — automatically.
          </p>
          <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-zinc-400" aria-label="Pipeline stages">
            {['Script', 'Rewrite', 'Voiceover', 'Prompts', 'Images', 'Video'].map((step, i) => (
              <li key={step} className="flex items-center gap-1.5">
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1">
                  {step}
                </span>
                {i < 5 && <ChevronDown className="h-3 w-3 text-zinc-600" aria-hidden="true" />}
              </li>
            ))}
          </ol>
        </motion.section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* ══ LEFT: input + settings ══ */}
          <div className="space-y-6">
            {/* Script card */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <Card className="border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileText className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                      Your Script
                    </CardTitle>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setTranscript(SAMPLE_SCRIPT)}
                        disabled={busy}
                        className="h-9 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
                      >
                        Load sample
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setTranscript('')}
                        disabled={!transcript || busy}
                        aria-label="Clear script"
                        className="h-9 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
                      >
                        <Eraser className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden sm:inline">Clear</span>
                      </Button>
                    </div>
                  </div>
                  <CardDescription>
                    The ONLY thing you do. Everything after this runs by itself.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    value={transcript}
                    onChange={(e) => setTranscript(e.target.value)}
                    placeholder="Paste your video script or transcript here… (or click “Load sample” to try it instantly)"
                    aria-label="Video script input"
                    disabled={busy}
                    className="min-h-[220px] resize-y border-zinc-800 bg-zinc-950/70 text-sm leading-relaxed placeholder:text-zinc-600 focus-visible:ring-amber-500/60 sm:min-h-[260px]"
                  />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500">
                    <span className="inline-flex items-center gap-1.5">
                      <Type className="h-3.5 w-3.5" aria-hidden="true" />
                      {inputWords.toLocaleString()} words
                    </span>
                    <span>{inputChars.toLocaleString()} characters</span>
                    <span className="inline-flex items-center gap-1.5">
                      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                      ~{formatDuration(estVoSeconds)} voiceover
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      ~{estImages} images
                    </span>
                    {tooShort && (
                      <span className="text-amber-500">Minimum {MIN_CHARS} characters required</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* Production settings */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15 }}
            >
              <Card className="border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Settings2 className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                    Production Settings
                  </CardTitle>
                  <CardDescription>
                    Sensible defaults — tweak only if you want. The agent honors every choice.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Narration */}
                  <fieldset className="space-y-3" disabled={busy}>
                    <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Narration
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="voice" className="text-xs text-zinc-400">Voice</Label>
                        <Select
                          value={settings.voice}
                          onValueChange={(v) => update('voice', v)}
                        >
                          <SelectTrigger id="voice" className="h-10 border-zinc-800 bg-zinc-950/70">
                            <SelectValue placeholder="Voice" />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-zinc-900">
                            {VOICE_OPTIONS.map((v) => (
                              <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="speed" className="text-xs text-zinc-400">Speed</Label>
                        <Select
                          value={String(settings.speed)}
                          onValueChange={(v) => update('speed', Number(v))}
                        >
                          <SelectTrigger id="speed" className="h-10 border-zinc-800 bg-zinc-950/70">
                            <SelectValue placeholder="Speed" />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-zinc-900">
                            {SPEED_OPTIONS.map((v) => (
                              <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </fieldset>

                  {/* Visual direction (Flow Studio) */}
                  <fieldset className="space-y-3" disabled={busy}>
                    <legend className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      <Palette className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                      Visual Direction · Flow Prompt Studio
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="style" className="text-xs text-zinc-400">Visual style</Label>
                        <Select
                          value={settings.visualStyle}
                          onValueChange={(v) => update('visualStyle', v)}
                        >
                          <SelectTrigger id="style" className="h-10 border-zinc-800 bg-zinc-950/70">
                            <SelectValue placeholder="Style" />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-zinc-900">
                            {STYLE_OPTIONS.filter((o) => o.id !== 'custom').map((o) => (
                              <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                            ))}
                            <SelectItem value="custom">Custom style…</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {settings.visualStyle === 'custom' ? (
                        <div className="space-y-1.5">
                          <Label htmlFor="custom-style" className="text-xs text-zinc-400">
                            Describe the look
                          </Label>
                          <Input
                            id="custom-style"
                            value={settings.customStyle}
                            onChange={(e) => update('customStyle', e.target.value)}
                            placeholder="e.g. dark moody documentary, muted colors"
                            className="h-10 border-zinc-800 bg-zinc-950/70"
                          />
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <Label htmlFor="lighting" className="text-xs text-zinc-400">Lighting</Label>
                          <Select
                            value={settings.lighting}
                            onValueChange={(v) => update('lighting', v)}
                          >
                            <SelectTrigger id="lighting" className="h-10 border-zinc-800 bg-zinc-950/70">
                              <SelectValue placeholder="Lighting" />
                            </SelectTrigger>
                            <SelectContent className="border-zinc-800 bg-zinc-900">
                              {LIGHTING_OPTIONS.map((o) => (
                                <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="space-y-1.5">
                        <Label htmlFor="composition" className="text-xs text-zinc-400">Composition</Label>
                        <Select
                          value={settings.composition}
                          onValueChange={(v) => update('composition', v)}
                        >
                          <SelectTrigger id="composition" className="h-10 border-zinc-800 bg-zinc-950/70">
                            <SelectValue placeholder="Composition" />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-zinc-900">
                            {COMPOSITION_OPTIONS.filter((o) => o.id !== 'custom').map((o) => (
                              <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                            ))}
                            <SelectItem value="custom">Custom composition…</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {settings.composition === 'custom' ? (
                        <div className="space-y-1.5">
                          <Label htmlFor="custom-comp" className="text-xs text-zinc-400">
                            Describe the framing
                          </Label>
                          <Input
                            id="custom-comp"
                            value={settings.customComposition}
                            onChange={(e) => update('customComposition', e.target.value)}
                            placeholder="e.g. over-the-shoulder shots, centered hero framing"
                            className="h-10 border-zinc-800 bg-zinc-950/70"
                          />
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <Label className="text-xs text-zinc-400">Aspect ratio</Label>
                          <div className="flex h-10 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 text-sm text-zinc-400">
                            <Film className="h-3.5 w-3.5" aria-hidden="true" />
                            16:9
                            <span className="text-[11px] text-zinc-600">· locked for the video</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-zinc-600">
                      These options come straight from the Flow Prompt Studio catalogs — the agent
                      blends them into the Style DNA that steers every image of the batch.
                    </p>
                  </fieldset>

                  {/* Post-production */}
                  <fieldset className="space-y-3" disabled={busy}>
                    <legend className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      <Music className="h-3.5 w-3.5" aria-hidden="true" />
                      Post-production
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="music" className="text-xs text-zinc-400">Background music</Label>
                        <Select
                          value={settings.music}
                          onValueChange={(v) => update('music', v as AutopilotSettings['music'])}
                        >
                          <SelectTrigger id="music" className="h-10 border-zinc-800 bg-zinc-950/70">
                            <SelectValue placeholder="Music" />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-zinc-900">
                            {MUSIC_OPTIONS.map((m) => (
                              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="resolution" className="text-xs text-zinc-400">Resolution</Label>
                        <Select
                          value={settings.resolution}
                          onValueChange={(v) => update('resolution', v as AutopilotSettings['resolution'])}
                        >
                          <SelectTrigger id="resolution" className="h-10 border-zinc-800 bg-zinc-950/70">
                            <SelectValue placeholder="Resolution" />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-zinc-900">
                            {RESOLUTION_OPTIONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(
                        [
                          ['captions', 'Burn-in captions'],
                          ['transitions', 'Smart transitions'],
                          ['titleCard', 'Title card'],
                          ['highlights', 'Key-moment highlights'],
                          ['outro', 'Outro end card']
                        ] as [keyof AutopilotSettings, string][]
                      ).map(([key, label]) => (
                        <label
                          key={key}
                          className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-2.5"
                        >
                          <span className="text-xs text-zinc-300">{label}</span>
                          <Switch
                            checked={Boolean(settings[key])}
                            onCheckedChange={(checked) => update(key, checked as never)}
                            disabled={busy}
                            aria-label={label}
                          />
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </CardContent>
              </Card>
            </motion.div>

            {/* Start button */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.2 }}
            >
              <Card className="border-amber-500/25 bg-gradient-to-b from-amber-500/10 to-zinc-900/40 backdrop-blur-sm">
                <CardContent className="space-y-3 p-4 sm:p-6">
                  {startError && (
                    <Alert variant="destructive" role="alert">
                      <AlertCircle className="h-4 w-4" aria-hidden="true" />
                      <AlertTitle>Could not start the autopilot</AlertTitle>
                      <AlertDescription>{startError}</AlertDescription>
                    </Alert>
                  )}
                  {busy ? (
                    <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                      <Loader2 className="h-5 w-5 animate-spin text-amber-400" aria-hidden="true" />
                      <div className="text-sm">
                        <p className="font-medium text-amber-300">
                          {starting ? 'Engaging autopilot…' : 'Autopilot is running'}
                        </p>
                        <p className="text-xs text-amber-200/70">
                          {starting
                            ? 'Creating the pipeline run…'
                            : `Elapsed ${formatDuration(elapsedSec)} — the agent works on its own; this page updates live.`}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="lg"
                      onClick={startAutopilot}
                      disabled={inputChars < MIN_CHARS}
                      className="h-12 w-full bg-amber-500 text-zinc-950 text-base font-semibold hover:bg-amber-400 focus-visible:ring-amber-500/60"
                    >
                      <Play className="mr-2 h-5 w-5" aria-hidden="true" />
                      Start Full Autopilot
                    </Button>
                  )}
                  <p className="text-center text-[11px] leading-relaxed text-zinc-500">
                    One click = rewrite → voiceover → Flow-Studio prompts → full image batch →
                    edited video. Duplicate clicks are ignored while a run is active.
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          </div>

          {/* ══ RIGHT: live pipeline console ══ */}
          <div className="space-y-6">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.12 }}
            >
              <Card className="border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Sparkles className="h-4 w-4 text-amber-400" aria-hidden="true" />
                      Live Pipeline
                    </CardTitle>
                    {snap && (
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            snap.status === 'completed'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                              : snap.status === 'failed'
                                ? 'border-red-500/30 bg-red-500/10 text-red-400'
                                : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                          }
                        >
                          {snap.status === 'running' && (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                          )}
                          {snap.status === 'completed' && (
                            <Check className="mr-1 h-3 w-3" aria-hidden="true" />
                          )}
                          {snap.status.toUpperCase()}
                        </Badge>
                        <span className="text-xs tabular-nums text-zinc-500">
                          {formatDuration(elapsedSec)}
                        </span>
                      </div>
                    )}
                  </div>
                  <CardDescription>
                    The agent runs every stage by itself — watch it work.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!snap ? (
                    <div className="space-y-4 py-4" aria-live="polite">
                      <p className="flex items-center gap-2 text-sm text-zinc-400">
                        <WandSparkles className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                        Waiting for your script…
                      </p>
                      <ol className="space-y-2">
                        {(['rewrite', 'voiceover', 'prompts', 'images', 'video'] as const).map(
                          (key, i) => {
                            const Icon = STAGE_ICONS[key]
                            return (
                              <li
                                key={key}
                                className="flex items-start gap-3 rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-3"
                              >
                                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-400">
                                  {i + 1}
                                </span>
                                <div className="min-w-0">
                                  <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                                    <Icon className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                                    {STAGE_LABELS_LOCAL[key]}
                                  </p>
                                  <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                                    {STAGE_TAGLINES[key]}
                                  </p>
                                </div>
                              </li>
                            )
                          }
                        )}
                      </ol>
                    </div>
                  ) : (
                    <div className="space-y-4" aria-live="polite">
                      {snap.stages.map((stage) => {
                        const Icon = STAGE_ICONS[stage.key]
                        const border =
                          stage.status === 'done'
                            ? 'border-emerald-500/25'
                            : stage.status === 'active'
                              ? 'border-amber-500/40'
                              : stage.status === 'error'
                                ? 'border-red-500/40'
                                : 'border-zinc-800/60'
                        return (
                          <div key={stage.key} className={`rounded-lg border ${border} bg-zinc-950/40 p-3`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex min-w-0 items-start gap-2.5">
                                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900">
                                  {stage.status === 'done' ? (
                                    <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                                  ) : stage.status === 'active' ? (
                                    <Loader2 className="h-4 w-4 animate-spin text-amber-400" aria-hidden="true" />
                                  ) : stage.status === 'error' ? (
                                    <AlertCircle className="h-4 w-4 text-red-400" aria-hidden="true" />
                                  ) : (
                                    <Lock className="h-3.5 w-3.5 text-zinc-600" aria-hidden="true" />
                                  )}
                                </span>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-zinc-200">
                                    {stage.label}
                                  </p>
                                  <p className="mt-0.5 truncate text-xs text-zinc-500" title={stage.detail ?? undefined}>
                                    {stage.detail ?? STAGE_TAGLINES[stage.key]}
                                  </p>
                                </div>
                              </div>
                              {stage.progress !== null && stage.status === 'active' && (
                                <span className="shrink-0 text-xs tabular-nums text-amber-400">
                                  {stage.progress}%
                                </span>
                              )}
                            </div>
                            {stage.status === 'active' && (
                              <Progress
                                value={stage.progress ?? 15}
                                className="mt-2.5 h-1.5 bg-zinc-800 [&>div]:bg-amber-500"
                                aria-label={`${stage.label} progress`}
                              />
                            )}

                            {/* ── Stage extras ── */}
                            {stage.key === 'rewrite' && stage.status === 'done' && snap.artifacts.rewrittenScript && (
                              <Collapsible className="mt-2">
                                <CollapsibleTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 px-2 text-xs text-zinc-400 hover:text-zinc-200"
                                  >
                                    <ChevronDown className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                                    View rewritten script ({snap.artifacts.rewrittenWordCount?.toLocaleString()} words)
                                  </Button>
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                  <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-3 text-xs leading-relaxed text-zinc-300 scroll-smooth">
                                    {snap.artifacts.rewrittenScript}
                                  </div>
                                </CollapsibleContent>
                              </Collapsible>
                            )}

                            {stage.key === 'voiceover' && stage.status === 'done' && snap.artifacts.voiceover && (
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                                <span>Voice: {snap.artifacts.voiceover.voice}</span>
                                <span>{snap.artifacts.voiceover.chunkCount} segments</span>
                                <span>{formatDuration(snap.artifacts.voiceover.durationSeconds)}</span>
                                <span>{formatBytes(snap.artifacts.voiceover.sizeBytes)}</span>
                              </div>
                            )}

                            {stage.key === 'prompts' && (stage.status === 'active' || stage.status === 'done') && snap.live.images.styleDna && (
                              <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/70 p-2.5">
                                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-amber-500/80">
                                  Style DNA
                                </p>
                                <p className="text-[11px] leading-relaxed text-zinc-400">
                                  {snap.live.images.styleDna}
                                </p>
                              </div>
                            )}

                            {stage.key === 'images' &&
                              (stage.status === 'active' || stage.status === 'done') &&
                              snap.live.images.jobId && (
                                <ImageBatchPanel
                                  jobId={snap.live.images.jobId}
                                  slots={snap.live.images.slots}
                                  total={snap.live.images.total}
                                  completed={snap.live.images.completed}
                                  failed={snap.live.images.failed}
                                  batchStates={snap.live.images.batchStates}
                                  batchInterlude={snap.live.images.batchInterlude}
                                />
                              )}
                          </div>
                        )
                      })}

                      {/* Failure panel */}
                      {snap.status === 'failed' && (
                        <Alert variant="destructive" role="alert">
                          <AlertCircle className="h-4 w-4" aria-hidden="true" />
                          <AlertTitle>
                            Autopilot stopped at “{snap.stages.find((s) => s.key === snap.failedStage)?.label ?? 'unknown stage'}”
                          </AlertTitle>
                          <AlertDescription className="space-y-2">
                            <p>{snap.error}</p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                resetRun()
                                await startAutopilot()
                              }}
                              className="h-9 border-red-500/40 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200"
                            >
                              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                              Retry from the top
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Completion panel */}
                      {snap.status === 'completed' && snap.artifacts.video && (
                        <CompletionPanel snap={snap} onNewVideo={resetRun} />
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </div>

        {/* How it works */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.25 }}
          className="mt-8"
          aria-labelledby="how-heading"
        >
          <h3 id="how-heading" className="mb-3 text-lg font-semibold">
            How the agent works
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: WandSparkles,
                title: 'Script doctor rewrite',
                body: 'The LLM rewrites your transcript into a fresh, original narration — same message, new wording (quarantined vocabulary-overlap check included).'
              },
              {
                icon: Mic,
                title: 'Timed neural voiceover',
                body: 'Edge-TTS narrates the rewrite in segments and measures each segment’s exact timing, so every image lands on the words it visualizes.'
              },
              {
                icon: Palette,
                title: 'Flow Prompt Studio engine',
                body: 'The same structured prompt discipline built for Flow — Style DNA + one fidelity-guarded prompt per narration chunk, batched 20 at a time.'
              },
              {
                icon: ImageIcon,
                title: 'Junction-gated image batches',
                body: 'Images generate 20 at a time with breathing pauses between junctions — a multi-provider chain with automatic retries keeps the batch alive.'
              },
              {
                icon: Clapperboard,
                title: 'Automatic video editing',
                body: 'FFmpeg cuts clips to voiceover timing, adds Ken Burns motion, captions, transitions, title/outro cards and music — then encodes the final MP4.'
              },
              {
                icon: ShieldCheck,
                title: 'Zero API keys',
                body: 'Every AI call runs on the platform’s bundled providers. You never enter a key, and the pipeline never bypasses a quota or rate limit.'
              }
            ].map((f) => (
              <Card key={f.title} className="border-zinc-800/60 bg-zinc-900/40">
                <CardContent className="p-4">
                  <f.icon className="mb-2 h-5 w-5 text-amber-400" aria-hidden="true" />
                  <h4 className="text-sm font-semibold text-zinc-200">{f.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">{f.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </motion.section>
      </main>

      {/* ── Sticky footer ── */}
      <footer className="mt-auto border-t border-zinc-800/70 bg-zinc-950">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-center text-xs text-zinc-500 sm:flex-row sm:px-6 sm:text-left">
          <p>
            AutoTube Studio · Autopilot — script to finished video, fully automated. Generation
            runs on the platform’s bundled AI providers; no user API keys.
          </p>
          <p className="text-zinc-600">Runs are kept for 4 hours after finishing.</p>
        </div>
      </footer>
    </div>
  )
}

// ─── Image batch panel (thumbnails grid) ─────────────────────────────────────

function ImageBatchPanel({
  jobId,
  slots,
  total,
  completed,
  failed,
  batchStates,
  batchInterlude
}: {
  jobId: string
  slots: ImageSlotLive[]
  total: number
  completed: number
  failed: number
  batchStates: AutopilotSnapshot['live']['images']['batchStates']
  batchInterlude: boolean
}) {
  const showThumbs = slots.length > 0
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span className="tabular-nums">
          {completed}/{total} done
        </span>
        {failed > 0 && <span className="text-red-400/80">{failed} failed</span>}
        {batchInterlude && (
          <span className="inline-flex items-center gap-1 text-amber-400/80">
            <Clock3 className="h-3 w-3 animate-pulse" aria-hidden="true" />
            breathing between junctions
          </span>
        )}
      </div>
      {batchStates && batchStates.length > 1 && (
        <div className="flex flex-wrap gap-1" aria-label="Batch junction states">
          {batchStates.map((b) => (
            <span
              key={b.index}
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${
                b.status === 'done'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : b.status === 'active'
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'bg-zinc-800/60 text-zinc-500'
              }`}
              title={`Junction ${b.index + 1}: ${b.completed}/${b.total} done, ${b.failed} failed`}
            >
              B{b.index + 1}
            </span>
          ))}
        </div>
      )}
      {showThumbs && (
        <div
          className="grid max-h-96 grid-cols-3 gap-1.5 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-1.5 sm:grid-cols-4 md:grid-cols-6 scroll-smooth [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700"
          role="img"
          aria-label={`Generated frames grid — ${completed} of ${total} complete`}
        >
          {slots.map((slot) => (
            <ThumbCell key={slot.index} slot={slot} jobId={jobId} />
          ))}
        </div>
      )}
    </div>
  )
}

function ThumbCell({ slot, jobId }: { slot: ImageSlotLive; jobId: string }) {
  if (slot.status === 'done') {
    return (
      <div className="group relative aspect-video overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
        <img
          src={`/api/image?jobId=${encodeURIComponent(jobId)}&index=${slot.index}`}
          alt={`Generated frame ${slot.index + 1}`}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-mono text-zinc-200 backdrop-blur-sm">
          #{slot.index + 1}
        </span>
      </div>
    )
  }
  if (slot.status === 'error') {
    return (
      <div
        className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-red-500/30 bg-red-500/5"
        title="This slot failed — the video will skip it"
      >
        <AlertCircle className="h-4 w-4 text-red-400/70" aria-hidden="true" />
      </div>
    )
  }
  if (slot.status === 'waiting') {
    return (
      <div className="relative flex aspect-video animate-pulse items-center justify-center overflow-hidden rounded-md border border-amber-500/30 bg-amber-500/5">
        <Clock3 className="h-4 w-4 text-amber-400/70" aria-hidden="true" />
      </div>
    )
  }
  return (
    <div className="relative flex aspect-video animate-pulse items-center justify-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/60">
      <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-hidden="true" />
    </div>
  )
}

// ─── Completion panel (final video) ──────────────────────────────────────────

function CompletionPanel({
  snap,
  onNewVideo
}: {
  snap: AutopilotSnapshot
  onNewVideo: () => void
}) {
  const video = snap.artifacts.video!
  const a = snap.artifacts
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15">
          <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        </span>
        <div>
          <h4 className="text-sm font-semibold text-emerald-300">Your video is ready</h4>
          <p className="text-xs text-emerald-200/60">
            Fully generated and edited by the agent — no manual steps were needed.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black">
        <video
          controls
          preload="metadata"
          className="aspect-video w-full"
          src={video.fileUrl}
          aria-label="Finished video player"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400">
          <a href={video.downloadUrl} download={`autotube-${video.jobId.slice(0, 8)}.mp4`}>
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
            Download MP4
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onNewVideo}
          className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
        >
          <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
          Make another video
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ['Duration', formatDuration(video.videoDuration ?? a.voiceover?.durationSeconds ?? 0)],
          ['Resolution', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : (snap.settings.resolution ?? '—')],
          ['File size', formatBytes(video.fileSize)],
          ['Images used', String(a.imageCount ?? 0)]
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border border-zinc-800/70 bg-zinc-950/60 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</p>
            <p className="mt-0.5 font-medium tabular-nums text-zinc-300">{value}</p>
          </div>
        ))}
      </div>

      {video.featuresApplied.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Editing features applied">
          {video.featuresApplied.map((f) => (
            <Badge
              key={f}
              variant="outline"
              className="border-emerald-500/25 bg-emerald-500/10 text-[10px] text-emerald-300"
            >
              {f}
            </Badge>
          ))}
        </div>
      )}

      {video.titleCardText && (
        <p className="text-xs text-zinc-500">
          <span className="text-zinc-400">Title card:</span> “{video.titleCardText}”
          {video.outroCtaText ? (
            <>
              {'  '}· <span className="text-zinc-400">Outro CTA:</span> “{video.outroCtaText}”
            </>
          ) : null}
        </p>
      )}
    </motion.div>
  )
}

// Local copy of stage labels (keeps this file self-contained for rendering).
const STAGE_LABELS_LOCAL: Record<string, string> = {
  rewrite: 'Rewriting script',
  voiceover: 'Generating voiceover',
  prompts: 'Flow Studio · writing image prompts',
  images: 'Generating images (batched)',
  video: 'Assembling final video'
}

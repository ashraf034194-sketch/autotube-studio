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
  ChevronDown,
  ExternalLink,
  ClipboardCopy,
  Upload,
  X,
  Bot,
  Monitor,
  LogIn,
  Square,
  FlaskConical,
  Send,
  Keyboard,
  Power,
  RefreshCw,
  Mail,
  Smartphone,
  QrCode
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

/** localStorage key remembering that the user hid the 3-step guide. */
const ONBOARDING_KEY = 'autotube_onboarding_dismissed_v1'

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
  images: 'The Flow Bridge drives the real Google Flow page and fills every image slot automatically — the manual handoff below is the fallback.',
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
  const [guideOpen, setGuideOpen] = useState(false)

  const isRunning = snap === null ? false : snap.status === 'running'
  const isAwaiting = snap?.status === 'awaiting_images'
  const busy = starting || isRunning || isAwaiting
  const terminalStatus = snap?.status === 'completed' || snap?.status === 'failed'
  type SnapStatus = 'running' | 'awaiting_images' | 'completed' | 'failed' | null
  const notifRef = useRef<SnapStatus | null>(null)

  // Show the 3-step new-user guide unless this browser dismissed it before.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(ONBOARDING_KEY) !== '1') setGuideOpen(true)
    } catch {
      setGuideOpen(true) // private mode etc. — default to showing the guide
    }
  }, [])

  // 1s clock while a run is active or paused at the Flow handoff (drives the
  // elapsed timer — honest about total wall-clock including your Flow work).
  useEffect(() => {
    if (!isRunning && !isAwaiting) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning, isAwaiting])

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

  // Terminal/pause-transition toasts (fire exactly once per run).
  useEffect(() => {
    const s = snap?.status ?? null
    if (!s || s === 'running') {
      notifRef.current = s
      return
    }
    if (notifRef.current !== s) {
      const prev = notifRef.current
      notifRef.current = s
      if (s === 'awaiting_images') {
        toast({
          title: 'Prompts ready',
          description: `${snap?.live.images.total ?? 0} image prompts are written — the Flow Bridge is generating them from your connected Google Flow now (manual handoff available as fallback).`
        })
      } else if (s === 'completed' && prev === 'awaiting_images') {
        toast({
          title: 'Video ready',
          description: 'Your Flow images are edited into the finished video — scroll to the player and download it.'
        })
      } else if (s === 'completed') {
        toast({
          title: 'Video ready',
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
  }, [snap?.status, snap?.live.images.total, snap?.error, toast])

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
              Google Flow images
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
            Your only job is the script. The autopilot agent rewrites it, narrates it, and writes
            image prompts with the Flow&nbsp;Prompt&nbsp;Studio engine. A second tab keeps the
            real Google&nbsp;Flow open — the Flow&nbsp;Bridge drives it for you with your own
            logged-in account — and the agent edits everything into a finished MP4. No bridge?
            The manual handoff still works.
          </p>
          <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-zinc-400" aria-label="Pipeline stages">
            {['Script', 'Rewrite', 'Voiceover', 'Prompts', 'Flow Images', 'Video'].map((step, i) => (
              <li key={step} className="flex items-center gap-1.5">
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1">
                  {step}
                </span>
                {i < 5 && <ChevronDown className="h-3 w-3 text-zinc-600" aria-hidden="true" />}
              </li>
            ))}
          </ol>
          {!runId && !guideOpen && (
            <button
              type="button"
              onClick={() => {
                // Explicit re-open also forgets the dismissal, so a page
                // reload keeps the guide visible until it is hidden again.
                try {
                  window.localStorage.removeItem(ONBOARDING_KEY)
                } catch {
                  /* private mode — session-only either way */
                }
                setGuideOpen(true)
              }}
              className="mt-3 text-[11px] font-medium text-amber-400/80 underline-offset-2 transition-colors hover:text-amber-300 hover:underline"
            >
              New here? Show the 3-step guide
            </button>
          )}
        </motion.section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* ══ LEFT: input + settings ══ */}
          {/* min-w-0: grid items default to min-width:auto — without this, the
              field-sizing-content textarea's intrinsic width blows out mobile. */}
          <div className="min-w-0 space-y-6">
            {/* New-user onboarding — the app explains itself (see component) */}
            {!runId && guideOpen && (
              <OnboardingGuide
                transcript={transcript}
                onDismiss={() => {
                  try {
                    window.localStorage.setItem(ONBOARDING_KEY, '1')
                  } catch {
                    /* private mode — hide for this session only */
                  }
                  setGuideOpen(false)
                }}
              />
            )}
            {/* Connect-first: open & sign in to the REAL Google Flow BEFORE
                starting — confirmation banner appears when connected. */}
            {!runId && <FlowConnectCard />}
            {/* Script card */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <Card className="border-zinc-800/60 bg-zinc-900/40 text-zinc-100 backdrop-blur-sm">
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
                    className="min-h-[220px] resize-y border-zinc-800 bg-zinc-950/70 text-zinc-100 caret-amber-400 text-sm leading-relaxed placeholder:text-zinc-600 focus-visible:ring-amber-500/60 sm:min-h-[260px]"
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
              <Card className="border-zinc-800/60 bg-zinc-900/40 text-zinc-100 backdrop-blur-sm">
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
                            className="h-10 border-zinc-800 bg-zinc-950/70 text-zinc-100"
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
                            className="h-10 border-zinc-800 bg-zinc-950/70 text-zinc-100"
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
              <Card className="border-amber-500/25 bg-gradient-to-b from-amber-500/10 to-zinc-900/40 text-zinc-100 backdrop-blur-sm">
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
                          {starting
                            ? 'Engaging autopilot…'
                            : isAwaiting
                              ? 'Flow Bridge is generating your images'
                              : 'Autopilot is running'}
                        </p>
                        <p className="text-xs text-amber-200/70">
                          {starting
                            ? 'Creating the pipeline run…'
                            : isAwaiting
                              ? `Prompts are ready — the Flow Bridge fills the slots below automatically when connected (elapsed ${formatDuration(elapsedSec)}).`
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
                    One click = rewrite → voiceover → Flow-Studio prompts → Google Flow image
                    generation → edited video. Multiple people can run this at the same time —
                    every user gets their own pipeline.
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          </div>

          {/* ══ RIGHT: live pipeline console ══ */}
          <div className="min-w-0 space-y-6">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.12 }}
            >
              <Card className="border-zinc-800/60 bg-zinc-900/40 text-zinc-100 backdrop-blur-sm">
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
                          {snap.status === 'awaiting_images' && (
                            <Clock3 className="mr-1 h-3 w-3" aria-hidden="true" />
                          )}
                          {snap.status === 'completed' && (
                            <Check className="mr-1 h-3 w-3" aria-hidden="true" />
                          )}
                          {snap.status === 'awaiting_images'
                            ? 'AWAITING FLOW IMAGES'
                            : snap.status.toUpperCase()}
                        </Badge>
                        <span className="text-xs tabular-nums text-zinc-500">
                          {formatDuration(elapsedSec)}
                        </span>
                      </div>
                    )}
                  </div>
                  <CardDescription>
                    Every stage runs by itself. The Flow Bridge even automates the Google Flow
                    image stage while it stays connected — manual handoff is the fallback.
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

                            {stage.key === 'images' && stage.status === 'active' && isAwaiting && (
                              <FlowHandoffPanel
                                key={`${snap.id}-${snap.live.images.jobId ?? ''}`}
                                snap={snap}
                              />
                            )}

                            {stage.key === 'images' &&
                              stage.status === 'done' &&
                              snap.live.images.jobId && (
                                <ImageBatchPanel
                                  jobId={snap.live.images.jobId}
                                  slots={snap.live.images.slots}
                                  total={snap.live.images.total}
                                  completed={snap.live.images.completed}
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
                title: 'Google Flow, driven automatically',
                body: 'Google Flow (Imagen) is the only image source — Pexels, Unsplash and the bundled AI generator were removed. The Flow Bridge keeps the real Flow open in a logged-in Chromium and fills every slot for you; manual handoff remains the fallback.'
              },
              {
                icon: Clapperboard,
                title: 'Automatic video editing',
                body: 'FFmpeg cuts clips to voiceover timing, adds Ken Burns motion, captions, transitions, title/outro cards and music — then encodes the final MP4.'
              },
              {
                icon: ShieldCheck,
                title: 'Zero API keys',
                body: 'Every AI call runs on the platform’s bundled text models. You never enter a key, and the pipeline never bypasses a quota or rate limit. Google Flow has no API — that’s why the handoff is manual by design.'
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
            AutoTube Studio · Autopilot — script to finished video. Text AI runs on the
            platform’s bundled models; images come from your own Google Flow account, driven
            by the Flow Bridge (manual fallback included). No API keys.
          </p>
          <p className="text-zinc-600">Runs are kept 4 hours after finishing (Flow handoffs 12 hours).</p>
        </div>
      </footer>
    </div>
  )
}

// ─── New-user onboarding — the self-explaining 3-step guide ───────────────────
//
// "Complete autopilot" is only an honest pitch if the app explains ITSELF: a
// brand-new user should never need a human walkthrough. This card is the whole
// product in 3 steps with LIVE status lights:
//   1. Paste your script        — turns green at ≥ MIN_CHARS.
//   2. Sign in to Google once   — shows the REAL Flow Bridge connection + login
//                                 state, polled live. Explains the one-time
//                                 sign-in that happens during the first run.
//   3. Walk away                — the promise the pipeline keeps.
// Dismissal is remembered in localStorage; the hero link re-opens it.

interface OnboardingGuideProps {
  transcript: string
  onDismiss: () => void
}

function OnboardingGuide({ transcript, onDismiss }: OnboardingGuideProps) {
  const [bridge, setBridge] = useState<BridgeStatusClient | null>(null)

  // Light bridge health poll (5s) — only while this card is mounted.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch('/api/flow-bridge/status')
        if (alive) setBridge((await res.json()) as BridgeStatusClient)
      } catch {
        /* offline — the chip below covers it */
      }
    }
    void tick()
    const id = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const scriptReady = transcript.trim().length >= MIN_CHARS
  const bridgeOffline = !bridge || bridge.offline === true || bridge.ok !== true
  const simMode = !bridgeOffline && bridge?.mode === 'simulation'
  const loginReady = !bridgeOffline && (simMode || bridge?.loginState === 'ready')
  const needsLogin = !bridgeOffline && !simMode && bridge?.loginState === 'needs-login'

  const loginChip = bridgeOffline
    ? 'Bridge offline — manual fallback'
    : simMode
      ? 'Simulation — no login needed'
      : loginReady
        ? 'Google signed in'
        : needsLogin
          ? 'Sign-in needed (once)'
          : 'Checked during first run'

  const step2Body = bridgeOffline
    ? 'The Flow Bridge service is not connected right now. Your run will pause at the image stage and switch to the manual handoff (copy prompts → upload images) — everything else stays automatic.'
    : simMode
      ? 'Simulation mode is ON: runs would use placeholder frames, NOT real Flow images. Turn it off (run panel → “testing tools”) before making a real video.'
      : 'Use the “Google Flow Connect” card below: press “Sign in with Google”, then log into your Google account in the live view — ONE time only (if email is blocked, Google’s page offers the phone-tap and QR-code methods — scan the QR with your phone, no password needed). The bridge remembers you for every future run. When it shows “connected”, every image will come from the real Flow.'

  const allSet = scriptReady && loginReady

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Card
        className="border-emerald-500/25 bg-emerald-500/[0.04] text-zinc-100 backdrop-blur-sm"
        aria-label="New user guide — 3 steps"
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
              New here? 3 steps — then it&rsquo;s fully automatic
            </CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              aria-label="Hide the 3-step guide"
              className="h-8 w-8 shrink-0 p-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <CardDescription className="text-xs text-zinc-400">
            One-time setup. After this, every video is: paste script → one click → finished MP4.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <ol className="space-y-2.5">
            <li className="flex gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-3">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300"
              >
                1
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                  Paste your script
                  <StatusLight done={scriptReady} label={scriptReady ? 'Ready' : 'Waiting for script'} />
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  Any topic, 50+ characters. Tip: press{' '}
                  <span className="font-medium text-zinc-200">Load sample</span> below to try it right
                  now.
                </p>
              </div>
            </li>

            <li className="flex gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-3">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300"
              >
                2
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                  Sign in to Google — one time
                  <StatusLight done={loginReady} label={loginChip} />
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">{step2Body}</p>
              </div>
            </li>

            <li className="flex gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-3">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300"
              >
                3
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                  Walk away — that&rsquo;s it
                  <StatusLight done label="Automatic" pulse={false} />
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  Rewrite, voiceover, Flow images and final video assembly all run by themselves.
                  Your MP4 appears with a download button at the end.
                </p>
              </div>
            </li>
          </ol>

          {allSet && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300"
            >
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              You&rsquo;re all set — press &ldquo;Start Autopilot&rdquo; below. That&rsquo;s your only click.
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/** Small live status pill: green check when done, amber pulse while waiting. */
function StatusLight({
  done,
  label,
  pulse = true
}: {
  done: boolean
  label: string
  pulse?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        done
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
      }`}
    >
      {done ? (
        <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400${pulse ? ' animate-pulse' : ''}`}
        />
      )}
      {label}
    </span>
  )
}

// ─── Google Flow Connect card — connect BEFORE starting the autopilot ─────────
//
// The owner's requested flow, made literal: at the very start the system asks
// the user to open the real Google Flow and connect; the moment the bridge
// reports "logged in", the user gets the explicit confirmation that images
// will be generated & downloaded from the real Flow — and only then presses
// "Start Full Autopilot". Shown only while no run is active. During a run the
// FlowBridgePanel (pause UI) takes over with the same live-view controls.

/** Google "G" mark for the "Sign in with Google" button (standard sign-in glyph). */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/**
 * Google's own alternative sign-in methods — surfaced in the UI whenever the
 * sign-in page is actually up, because "email sign-in is blocked" is the most
 * common login failure for a remote-controlled browser. All three methods are
 * provided by Google itself on the page shown in the live view; nothing is
 * bypassed.
 */
function GoogleSigninMethods() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        email sign-in not working? — google&rsquo;s own alternatives
      </p>
      <ul className="space-y-1.5">
        <li className="flex gap-2">
          <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
          <span className="text-[11px] leading-relaxed text-zinc-400">
            <span className="font-semibold text-zinc-300">Email + password:</span> click the page
            below to focus the field, type your email in the box under the live view, send it, then
            the password the same way.
          </span>
        </li>
        <li className="flex gap-2">
          <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
          <span className="text-[11px] leading-relaxed text-zinc-400">
            <span className="font-semibold text-zinc-300">Phone tap — no password typed here:</span>{' '}
            after your email, click <span className="font-medium text-zinc-300">&ldquo;Try another way&rdquo;</span>{' '}
            on the page and approve the prompt on your phone.
          </span>
        </li>
        <li className="flex gap-2">
          <QrCode className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
          <span className="text-[11px] leading-relaxed text-zinc-400">
            <span className="font-semibold text-zinc-300">QR code — no email, no password:</span> on
            the page choose the passkey option / &ldquo;Try another way&rdquo; →{' '}
            <span className="font-medium text-zinc-300">&ldquo;Sign in with a QR code&rdquo;</span>{' '}
            → scan the QR shown in the live view with your phone camera → tap Allow. This browser
            signs straight in.
          </span>
        </li>
      </ul>
    </div>
  )
}

function FlowConnectCard() {
  const { toast } = useToast()
  const [bridge, setBridge] = useState<BridgeStatusClient | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [frameBad, setFrameBad] = useState(false)
  const [frameTs, setFrameTs] = useState(0)

  // Bridge health polling (3s)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch('/api/flow-bridge/status')
        if (alive) setBridge((await res.json()) as BridgeStatusClient)
      } catch {
        /* offline — covered below */
      }
      if (alive) setTimeout(tick, 3000)
    }
    void tick()
    return () => {
      alive = false
    }
  }, [])

  const offline = !bridge || bridge.offline === true || bridge.ok !== true
  const mode: 'real' | 'simulation' = bridge?.mode ?? 'real'
  const simOn = !offline && mode === 'simulation'
  const connected = !offline && !simOn && bridge?.loginState === 'ready'
  const needsLogin = !offline && !simOn && bridge?.loginState === 'needs-login'
  const browserRunning = !!bridge?.browserRunning && !offline

  // Live-view frame refresh (2.2s) while the browser is up and login isn't
  // confirmed yet — once connected the live view collapses away.
  useEffect(() => {
    if (!browserRunning || connected) return
    setFrameBad(false)
    const iv = setInterval(() => setFrameTs(Date.now()), 2200)
    return () => clearInterval(iv)
  }, [browserRunning, connected])

  const control = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      setBusy(action)
      try {
        const res = await fetch('/api/flow-bridge/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...payload })
        })
        const json = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error || 'The bridge refused the action.')
        return true
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Bridge action failed',
          description: err instanceof Error ? err.message : 'Action failed.'
        })
        return false
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  const onFrameClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    void control('click', { x, y })
  }

  const sendTyped = () => {
    const text = typed.trim()
    if (!text) return
    void control('type', { text })
    setTyped('')
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.05 }}
    >
      <Card className="border-zinc-800/60 bg-zinc-900/40 text-zinc-100 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
            Google Flow Connect
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                connected
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : simOn
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400'
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  connected ? 'bg-emerald-400' : simOn ? 'bg-amber-400' : offline ? 'bg-zinc-500' : 'animate-pulse bg-amber-400'
                }`}
              />
              {connected ? 'connected' : simOn ? 'test mode' : offline ? 'bridge offline' : needsLogin ? 'sign-in needed' : 'checking…'}
            </span>
          </CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Connect the real Google Flow once — after this, every image in every video is generated
            inside your own Flow account automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {connected ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs leading-relaxed text-emerald-300"
            >
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>
                <span className="font-semibold">Google Flow connected.</span> When you press{' '}
                <span className="font-semibold">Start Full Autopilot</span>, every image will be
                generated and downloaded from the real Google&nbsp;Flow — no other image source
                exists in this system. Video assembly starts by itself when the last image lands.
              </p>
            </div>
          ) : simOn ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
              <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>
                <span className="font-semibold">Simulation mode is ON.</span> Runs would use
                clearly-labelled placeholder frames, NOT real Flow images. Turn it off in the
                run panel&rsquo;s &ldquo;testing tools&rdquo; before starting a real video.
              </p>
            </div>
          ) : offline ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-xs leading-relaxed text-zinc-400">
              <p>
                <span className="font-semibold text-zinc-300">Flow Bridge is offline.</span> The
                autopilot can still start — it will pause at the image stage with the manual
                handoff (copy prompts → generate in Flow → upload). Start the bridge on this
                machine with{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-amber-300">
                  bun run dev
                </code>{' '}
                inside{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-amber-300">
                  mini-services/flow-bridge
                </code>
                .
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-zinc-400">
                Press <span className="font-semibold text-zinc-200">Sign in with Google</span> —
                Google&rsquo;s own sign-in page opens in the bridge browser below. Sign in ONE time
                (email, phone tap, or QR code — whatever Google allows); the bridge remembers you
                for every future run.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-9 bg-white text-zinc-900 hover:bg-zinc-200"
                  onClick={() => void control('google-signin')}
                  disabled={busy === 'google-signin'}
                >
                  {busy === 'google-signin' ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <GoogleG className="mr-1.5 h-4 w-4" />
                  )}
                  Sign in with Google
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => void control('open-app')}
                  disabled={busy === 'open-app'}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Flow app
                </Button>
              </div>
              {needsLogin && <GoogleSigninMethods />}
              <p className="text-[10px] leading-relaxed text-zinc-600">
                Honest note: Google sometimes blocks password sign-ins from automated browsers —
                that&rsquo;s exactly what the phone-tap and QR-code options above are for
                (Google&rsquo;s own sign-in methods). After one successful login the profile remembers
                you. If every method is blocked, run the bridge on your own machine instead.
              </p>
            </>
          )}

          {/* Live view for the sign-in (collapses away once connected) */}
          {browserRunning && !connected && !simOn && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                <span className="flex items-center gap-1">
                  <Monitor className="h-3 w-3" aria-hidden="true" />
                  live view — click to control
                </span>
                <button
                  type="button"
                  className="flex items-center gap-1 normal-case text-zinc-500 hover:text-zinc-300"
                  onClick={() => void control('close-browser')}
                  title="Stop the background browser to free memory — the login persists and it relaunches when needed"
                  aria-label="Stop the background browser to free memory"
                >
                  <Power className={`h-3 w-3 ${busy === 'close-browser' ? 'animate-pulse' : ''}`} aria-hidden="true" />
                  stop
                </button>
              </div>
              <div className="relative overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                <img
                  src={`/api/flow-bridge/frame?v=${frameTs}`}
                  alt="Live view of the bridge browser (Google sign-in page or the real Google Flow)"
                  className="aspect-[16/10] w-full cursor-crosshair select-none object-cover"
                  onClick={onFrameClick}
                  onError={() => setFrameBad(true)}
                  draggable={false}
                />
                {frameBad && (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 text-[11px] text-zinc-400">
                    live view unavailable — retrying…
                  </div>
                )}
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      sendTyped()
                    }
                  }}
                  placeholder="type your email / password here, then press Enter…"
                  className="h-8 border-zinc-700 bg-zinc-950 text-[11px] placeholder:text-zinc-600"
                  aria-label="Text to type into the live page (Google sign-in or Flow)"
                  maxLength={500}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 border-zinc-700 bg-transparent px-2 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={sendTyped}
                  disabled={!typed.trim() || busy === 'type'}
                  aria-label="Send the typed text to the live page"
                >
                  <Send className="h-3 w-3" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 border-zinc-700 bg-transparent px-2 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => void control('key', { key: 'Enter' })}
                  title="Press Enter on the live page"
                  aria-label="Press Enter on the live page"
                >
                  <Keyboard className="h-3 w-3" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

// ─── Image batch panel (uploaded thumbnails grid) ─────────────────────────────

function ImageBatchPanel({
  jobId,
  slots,
  total,
  completed
}: {
  jobId: string
  slots: ImageSlotLive[]
  total: number
  completed: number
}) {
  const showThumbs = slots.length > 0
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span className="tabular-nums">
          {completed}/{total} images from Google Flow
        </span>
      </div>
      {showThumbs && (
        <div
          className="grid max-h-96 grid-cols-3 gap-1.5 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-1.5 sm:grid-cols-4 md:grid-cols-6 scroll-smooth [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700"
          role="img"
          aria-label={`Uploaded Flow frames grid — ${completed} of ${total} complete`}
        >
          {slots.map((slot) => (
            <FlowThumbCell key={slot.index} slot={slot} jobId={jobId} />
          ))}
        </div>
      )}
    </div>
  )
}

function FlowThumbCell({ slot, jobId }: { slot: ImageSlotLive; jobId: string }) {
  if (slot.status === 'done') {
    return (
      <div className="group relative aspect-video overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
        <img
          src={`/api/image?jobId=${encodeURIComponent(jobId)}&index=${slot.index}`}
          alt={`Flow frame ${slot.index + 1}`}
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
        title={slot.error ?? 'This image could not be processed'}
      >
        <AlertCircle className="h-4 w-4 text-red-400/70" aria-hidden="true" />
      </div>
    )
  }
  // Pending Flow slot — a calm empty cell (the image comes from the user's
  // Google Flow session, not from a server-side generator).
  return (
    <div
      className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-dashed border-zinc-800 bg-zinc-900/40"
      title="Waiting for its Google Flow image"
    >
      <span className="font-mono text-[10px] text-zinc-600">#{slot.index + 1}</span>
    </div>
  )
}

// ─── Flow Bridge — automatic generation panel (the "second tab") ─────────────
//
// One tab is THIS app. The other tab is the REAL Google Flow, kept open inside
// the bridge's logged-in Chromium (mini-services/flow-bridge, :3031). Google
// Flow has no public API and a web page cannot control another site's tab —
// the bridge process is the compliant missing link. This panel is the remote
// control for that second tab:
//   • live view  — a live screenshot of the real Flow page; click it to click
//                  Flow, type below to type into Flow (used for the Google
//                  sign-in, once — the profile persists after that)
//   • engine     — sends every pending prompt to the bridge, saves each
//                  finished image into its slot below, then auto-resumes
//                  video assembly. Zero clicks.
//   • simulation — a clearly-labelled TEST mode with placeholder frames, so
//                  the whole pipeline can be verified without Google.

interface BridgeStatusClient {
  ok: boolean
  offline?: boolean
  mode?: 'real' | 'simulation'
  browserRunning?: boolean
  chromiumFound?: boolean
  pageUrl?: string | null
  loginState?: 'unknown' | 'needs-login' | 'ready'
  queue?: { pending: number; activeId: string | null; done: number; failed: number }
  lastError?: string | null
}

interface AutoRunClient {
  autopilotId: string
  status: 'none' | 'starting' | 'running' | 'completed' | 'partial' | 'error' | 'stopped'
  mode?: string
  total?: number
  doneCount?: number
  failedCount?: number
  currentSlot?: number | null
  currentPrompt?: string | null
  lastError?: string | null
  logs?: { t: number; msg: string }[]
  finishing?: boolean
}

function FlowBridgePanel({ snap }: { snap: AutopilotSnapshot }) {
  const { toast } = useToast()
  const [bridge, setBridge] = useState<BridgeStatusClient | null>(null)
  const [auto, setAuto] = useState<AutoRunClient | null>(null)
  const [frameBad, setFrameBad] = useState(false)
  const [frameTs, setFrameTs] = useState(0)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [autoStart, setAutoStart] = useState(true)
  const [showLogs, setShowLogs] = useState(false)
  const autoStartedRef = useRef(false)

  // Bridge health polling (2.5s)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch('/api/flow-bridge/status')
        if (alive) setBridge((await res.json()) as BridgeStatusClient)
      } catch {
        /* offline — the stale state below covers it */
      }
      if (alive) timer = setTimeout(tick, 2500)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Auto-run state polling (2s)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/flow-bridge/auto?autopilotId=${encodeURIComponent(snap.id)}`)
        if (alive) setAuto((await res.json()) as AutoRunClient)
      } catch {
        /* ignore */
      }
      if (alive) timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [snap.id])

  const browserRunning = !!bridge?.browserRunning && bridge?.offline !== true && bridge?.ok === true

  // Live-view frame refresh (2.2s) while the browser is up
  useEffect(() => {
    if (!browserRunning) return
    setFrameBad(false)
    const iv = setInterval(() => setFrameTs(Date.now()), 2200)
    return () => clearInterval(iv)
  }, [browserRunning])

  const offline = !bridge || bridge.offline === true || bridge.ok !== true
  const mode: 'real' | 'simulation' = bridge?.mode ?? 'real'
  const simOn = mode === 'simulation'
  const needsLogin = !offline && mode === 'real' && bridge?.loginState !== 'ready'
  // AUTO-START only ever fires for the REAL bridge, logged in. Simulation
  // (placeholder frames — "raw images, not from Flow") must NEVER start by
  // itself: it is a deliberate, clearly-labelled testing action.
  const readyForAuto = !offline && mode === 'real' && bridge?.loginState === 'ready'
  // The manual engine button stays available in simulation (explicit test).
  const canStartEngine = !offline && (simOn || (mode === 'real' && bridge?.loginState === 'ready'))

  const autoStatus = auto?.status ?? 'none'
  const engineOn = autoStatus === 'running' || autoStatus === 'starting'
  const totalSlots = auto?.total ?? snap.live.images.total
  const doneCount = auto?.doneCount ?? snap.live.images.completed
  const engineProgress = totalSlots > 0 ? Math.round((doneCount / totalSlots) * 100) : 0

  const control = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      setBusy(action)
      try {
        const res = await fetch('/api/flow-bridge/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...payload })
        })
        const json = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error || 'The bridge refused the action.')
        return true
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Bridge action failed',
          description: err instanceof Error ? err.message : 'Action failed.'
        })
        return false
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  const startAuto = useCallback(
    async (silent: boolean) => {
      if (busy || engineOn) return
      setBusy('auto')
      try {
        const res = await fetch('/api/flow-bridge/auto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autopilotId: snap.id })
        })
        const json = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error || 'Could not start the engine.')
        if (!silent) {
          toast({
            title: 'Flow Bridge is generating',
            description: 'Slots fill below by themselves — video assembly resumes when done.'
          })
        }
      } catch (err) {
        if (!silent) {
          toast({
            variant: 'destructive',
            title: 'Auto-generation failed',
            description: err instanceof Error ? err.message : 'Engine error.'
          })
        }
      } finally {
        setBusy(null)
      }
    },
    [busy, engineOn, snap.id, toast]
  )

  const stopAuto = useCallback(async () => {
    if (busy) return
    setBusy('stop')
    try {
      const res = await fetch('/api/flow-bridge/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autopilotId: snap.id, action: 'stop' })
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error || 'Could not stop the engine.')
      toast({
        title: 'Engine stopping',
        description: 'It finishes the image in flight, then halts. Manual handoff stays available.'
      })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Stop failed',
        description: err instanceof Error ? err.message : 'Could not stop the engine.'
      })
    } finally {
      setBusy(null)
    }
  }, [busy, snap.id, toast])

  // FULL AUTOPILOT — as soon as the REAL bridge is logged in, the engine
  // starts itself (one-time guard; opt out above). Simulation is deliberately
  // excluded — test generation only starts from an explicit click. Note the
  // orchestrator ALSO tries to start the engine server-side the moment a run
  // pauses, so this is a browser-side safety net, not the only trigger.
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return
    if (autoStatus !== 'none') return
    if (readyForAuto) {
      autoStartedRef.current = true
      void startAuto(true)
    }
  }, [autoStart, autoStatus, readyForAuto, startAuto])

  const onFrameClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    void control('click', { x, y })
  }

  const sendTyped = () => {
    const text = typed.trim()
    if (!text) return
    void control('type', { text })
    setTyped('')
  }

  const statusColor = offline
    ? 'bg-zinc-500'
    : simOn
      ? 'bg-amber-400'
      : needsLogin
        ? 'bg-amber-400'
        : 'bg-emerald-400'
  const statusText = offline
    ? 'offline'
    : simOn
      ? 'test mode'
      : needsLogin
        ? 'needs Google login'
        : 'connected · logged in'

  return (
    <section
      className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3"
      aria-label="Flow Bridge — automatic generation from the real Google Flow"
    >
      {/* ── header ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-emerald-300">
          <Bot className="h-4 w-4" aria-hidden="true" />
          Flow Bridge — automatic generation
          <span className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] font-normal text-zinc-300">
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} aria-hidden="true" />
            {statusText}
          </span>
          {simOn && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
              placeholders, not real Flow
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
          <label
            className="flex cursor-pointer items-center gap-1.5"
            title="Start the engine automatically as soon as the REAL bridge is connected and logged in (never in simulation)"
          >
            <Switch checked={autoStart} onCheckedChange={setAutoStart} aria-label="Auto-start when the bridge is ready" />
            auto-start
          </label>
          {/* The simulation switch was demoted from this header into the
              “Testing” collapsible below after a user mistook placeholder
              frames for real Flow output — it must be a deliberate action. */}
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── left: engine ── */}
        <div className="min-w-0 space-y-2.5">
          {offline ? (
            <div className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-400">
              <Power className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <p>
                <span className="font-semibold text-zinc-300">Flow Bridge is offline.</span> Start
                it on this machine with{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-amber-300">
                  bun run dev
                </code>{' '}
                inside{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-amber-300">
                  mini-services/flow-bridge
                </code>{' '}
                — then this panel turns into the live second tab and generation goes hands-off. The
                manual handoff below works meanwhile.
              </p>
            </div>
          ) : needsLogin ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/80">
                <LogIn className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                <p>
                  <span className="font-semibold text-amber-300">One-time Google login.</span> Press{' '}
                  <span className="font-semibold">Sign in with Google</span> next to the live view
                  (email — or, if that is blocked, Google’s own alternatives: approve on your phone,
                  or scan the QR code with your phone — no password typed here). The login persists
                  in the bridge’s profile. If every method is blocked, the bridge must run on your
                  own machine instead.
                </p>
              </div>
              <GoogleSigninMethods />
            </div>
          ) : null}

          {/* engine controls */}
          <div className="flex flex-wrap items-center gap-2">
            {engineOn ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 border-red-500/40 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200"
                onClick={() => void stopAuto()}
                disabled={busy === 'stop' || auto?.finishing}
              >
                <Square className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Stop engine
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className={
                  simOn
                    ? 'h-8 border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                    : 'h-8 bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
                }
                onClick={() => void startAuto(false)}
                disabled={!canStartEngine || busy === 'auto' || autoStatus === 'completed'}
                title={
                  canStartEngine
                    ? simOn
                      ? 'Test the pipeline with clearly-labelled placeholder frames (not real Flow)'
                      : 'Send every pending prompt to the real Google Flow via the bridge'
                    : 'The bridge must be running (and logged in for real mode) first'
                }
              >
                {busy === 'auto' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Bot className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                )}
                {autoStatus === 'completed'
                  ? 'Generated'
                  : simOn
                    ? 'Start TEST generation (placeholders)'
                    : 'Start auto-generation'}
              </Button>
            )}
            {auto?.finishing && (
              <span className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                resuming video assembly…
              </span>
            )}
            {engineOn && auto?.currentSlot != null && (
              <span className="text-[11px] text-zinc-400">
                generating <span className="font-mono text-emerald-400">#{auto.currentSlot + 1}</span>/{totalSlots} ·{' '}
                {simOn ? 'placeholder' : 'real Flow'}
              </span>
            )}
          </div>

          {/* progress */}
          {(engineOn || autoStatus === 'completed' || autoStatus === 'partial') && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-zinc-400">
                <span>
                  {doneCount}/{totalSlots} images generated
                  {auto?.failedCount ? ` · ${auto.failedCount} failed` : ''}
                </span>
                <span className="tabular-nums">{engineProgress}%</span>
              </div>
              <Progress
                value={engineProgress}
                className="h-1.5 [&>div]:bg-emerald-500"
                aria-label="Flow Bridge generation progress"
              />
              {engineOn && auto?.currentPrompt && (
                <p className="line-clamp-1 font-mono text-[10px] text-zinc-500" title={auto.currentPrompt}>
                  {auto.currentPrompt}
                </p>
              )}
            </div>
          )}

          {/* terminal states */}
          {autoStatus === 'completed' && (
            <p className="flex items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              All {doneCount} images generated — video assembly resumed automatically.
            </p>
          )}
          {autoStatus === 'partial' && (
            <p className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
              {doneCount}/{totalSlots} generated ({auto?.failedCount ?? 0} failed). Press “Assemble
              video” below, or start the engine again for the rest.
            </p>
          )}
          {(autoStatus === 'error' || (autoStatus === 'stopped' && auto?.lastError)) && auto?.lastError && (
            <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2 text-[11px] leading-relaxed text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {auto.lastError}
            </p>
          )}

          {/* logs */}
          {auto?.logs && auto.logs.length > 0 && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                onClick={() => setShowLogs((v) => !v)}
                aria-expanded={showLogs}
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showLogs ? 'rotate-180' : ''}`} aria-hidden="true" />
                engine log ({auto.logs.length})
              </button>
              {showLogs && (
                <div className="mt-1 max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-2 font-mono text-[10px] leading-relaxed text-zinc-500 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
                  {auto.logs.map((l, i) => (
                    <p key={i}>
                      <span className="text-zinc-600">
                        {new Date(l.t).toLocaleTimeString([], { hour12: false })}
                      </span>{' '}
                      {l.msg}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-zinc-600">
            Google Flow has no public API — the bridge drives its real web UI inside a logged-in
            Chromium, spending your own Flow credits at Flow’s natural pace. Nothing is bypassed.
          </p>

          {/* ── Testing (deliberate, clearly separated) ── */}
          <Collapsible className="rounded-md border border-zinc-800 bg-zinc-950/40">
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-300">
              <FlaskConical className="h-3 w-3" aria-hidden="true" />
              testing tools
              <ChevronDown className="ml-auto h-3 w-3 transition-transform [[data-state=open]>&]:rotate-180" aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-3 pb-3">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                <Switch
                  checked={simOn}
                  disabled={offline || busy === 'mode'}
                  onCheckedChange={(v) => void control('mode', { mode: v ? 'simulation' : 'real' })}
                  aria-label="Simulation mode (placeholder images, not real Flow)"
                />
                simulation mode
              </label>
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                Replaces real generation with clearly-labelled placeholder frames so the whole
                pipeline can be tested without Google. Never auto-starts — press “Start TEST
                generation” above deliberately. Turn it OFF before real runs.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* ── right: live view of the REAL Google Flow tab ── */}
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <span className="flex items-center gap-1">
              <Monitor className="h-3 w-3" aria-hidden="true" />
              live Flow tab
            </span>
            {browserRunning && (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1 normal-case text-zinc-500 hover:text-zinc-300"
                  onClick={() => void control('reload')}
                  title="Reload the Flow page"
                >
                  <RefreshCw className={`h-3 w-3 ${busy === 'reload' ? 'animate-spin' : ''}`} aria-hidden="true" />
                  reload
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 normal-case text-zinc-500 hover:text-zinc-300"
                  onClick={() => void control('close-browser')}
                  title="Stop the background browser to free memory — the login persists and it relaunches when needed"
                  aria-label="Stop the background browser to free memory"
                >
                  <Power className={`h-3 w-3 ${busy === 'close-browser' ? 'animate-pulse' : ''}`} aria-hidden="true" />
                  stop
                </button>
              </span>
            )}
          </div>
          <div className="relative overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
            {browserRunning ? (
              <>
                <img
                  src={`/api/flow-bridge/frame?v=${frameTs}`}
                  alt="Live view of the bridge browser (Google sign-in page or the real Google Flow)"
                  className="aspect-[16/10] w-full cursor-crosshair select-none object-cover"
                  onClick={onFrameClick}
                  onError={() => setFrameBad(true)}
                  draggable={false}
                />
                {frameBad && (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 text-[11px] text-zinc-400">
                    live view unavailable — retrying…
                  </div>
                )}
                <span className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-zinc-950/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-400">
                  <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />
                  live · click to control
                </span>
              </>
            ) : (
              <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1 px-4 text-center">
                <Monitor className="h-5 w-5 text-zinc-700" aria-hidden="true" />
                <p className="text-[11px] text-zinc-500">the second tab appears here</p>
                <p className="text-[10px] text-zinc-600">stopped for memory — click “Open Google Flow” to relaunch it</p>
              </div>
            )}
          </div>

          {/* login + typing controls */}
          {browserRunning && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 bg-white px-2 text-[10px] text-zinc-900 hover:bg-zinc-200"
                  onClick={() => void control('google-signin')}
                  disabled={busy === 'google-signin'}
                >
                  {busy === 'google-signin' ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <GoogleG className="mr-1 h-3.5 w-3.5" />
                  )}
                  Sign in with Google
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-zinc-700 bg-transparent px-2 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => void control('login')}
                  disabled={busy === 'login'}
                >
                  <LogIn className="mr-1 h-3 w-3" aria-hidden="true" />
                  Open Google Flow
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-zinc-700 bg-transparent px-2 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => void control('open-app')}
                  disabled={busy === 'open-app'}
                >
                  <ExternalLink className="mr-1 h-3 w-3" aria-hidden="true" />
                  Flow app
                </Button>
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      sendTyped()
                    }
                  }}
                  placeholder="type email / text into the live page…"
                  className="h-7 border-zinc-700 bg-zinc-950 text-[11px] placeholder:text-zinc-600"
                  aria-label="Text to type into the live page (Google sign-in or Flow)"
                  maxLength={500}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-zinc-700 bg-transparent px-2 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={sendTyped}
                  disabled={!typed.trim() || busy === 'type'}
                  aria-label="Send the typed text to the live page"
                >
                  <Send className="h-3 w-3" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-zinc-700 bg-transparent px-2 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => void control('key', { key: 'Enter' })}
                  title="Press Enter on the live page"
                  aria-label="Press Enter on the live page"
                >
                  <Keyboard className="h-3 w-3" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Google Flow handoff panel (the pause UI) ─────────────────────────────────

const FLOW_URL = 'https://labs.google/fx/tools/flow'

/**
 * The Google Flow handoff panel — rendered while the run is paused in
 * 'awaiting_images'. Google Flow (labs.google/fx/tools/flow) has no public
 * API, so this is the compliant 3-step bridge:
 *   1. copy the prompts (one by one, or all at once / as .txt)
 *   2. open Google Flow and generate the images with your own account
 *   3. drag & drop the exported images back here
 * Then press "Assemble video" and the pipeline resumes automatically.
 */
function FlowHandoffPanel({ snap }: { snap: AutopilotSnapshot }) {
  const { toast } = useToast()
  const images = snap.live.images
  const jobId = images.jobId
  const prompts = images.prompts ?? []
  const slots = images.slots
  const completed = images.completed
  const total = images.total

  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!jobId || files.length === 0 || uploading || finishing) return
      setUploading(true)
      setError(null)
      try {
        const form = new FormData()
        form.set('autopilotId', snap.id)
        for (const f of files) form.append('files', f)
        const res = await fetch('/api/autopilot/flow-upload', {
          method: 'POST',
          body: form
        })
        const json = (await res.json()) as {
          ok?: boolean
          saved?: number
          failed?: number
          errors?: string[]
          completed?: number
          total?: number
          error?: string
        }
        if (!res.ok || !json.ok) {
          throw new Error(json.error || `Upload failed (status ${res.status}).`)
        }
        toast({
          title: `${json.saved ?? 0} image${(json.saved ?? 0) === 1 ? '' : 's'} received`,
          description: `${json.completed ?? 0}/${json.total ?? '?'} slots filled${
            json.failed ? ` · ${json.failed} file${json.failed === 1 ? '' : 's'} failed` : ''
          }`
        })
        if (json.errors?.length) {
          setError(json.errors.join(' · ').slice(0, 300))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed.'
        setError(msg)
        toast({ variant: 'destructive', title: 'Upload failed', description: msg })
      } finally {
        setUploading(false)
      }
    },
    [jobId, snap.id, toast, uploading, finishing]
  )

  const removeSlot = useCallback(
    async (slotIndex: number) => {
      if (uploading || finishing) return
      try {
        const res = await fetch('/api/autopilot/flow-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autopilotId: snap.id, action: 'remove', slotIndex })
        })
        const json = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error || 'Could not remove the image.')
        toast({
          title: `Image #${slotIndex + 1} removed`,
          description: 'The slot is empty again — you can re-upload it.'
        })
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Remove failed',
          description: err instanceof Error ? err.message : 'Could not remove the image.'
        })
      }
    },
    [finishing, uploading, snap.id, toast]
  )

  const assemble = useCallback(async () => {
    if (completed < 1 || finishing || uploading) return
    setFinishing(true)
    setError(null)
    try {
      const res = await fetch('/api/autopilot/flow-finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autopilotId: snap.id })
      })
      const json = (await res.json()) as { ok?: boolean; imageCount?: number; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error || 'Could not start assembly.')
      toast({
        title: 'Assembling your video',
        description: `${json.imageCount ?? completed} Flow images — the agent is editing the final MP4 now.`
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not start assembly.'
      setError(msg)
      toast({ variant: 'destructive', title: 'Assembly failed', description: msg })
    } finally {
      setFinishing(false)
    }
  }, [completed, finishing, uploading, snap.id, toast])

  const copyPrompt = useCallback(
    async (text: string, idx: number) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopiedIdx(idx)
        setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500)
      } catch {
        toast({
          variant: 'destructive',
          title: 'Copy failed',
          description: 'Select the prompt text and copy manually.'
        })
      }
    },
    [toast]
  )

  const copyAllPrompts = useCallback(async () => {
    if (prompts.length === 0) return
    try {
      await navigator.clipboard.writeText(prompts.join('\n\n'))
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 1800)
      toast({
        title: 'All prompts copied',
        description: `${prompts.length} prompts are on your clipboard.`
      })
    } catch {
      toast({ variant: 'destructive', title: 'Copy failed', description: 'Use the .txt download instead.' })
    }
  }, [prompts, toast])

  const downloadPrompts = useCallback(() => {
    if (prompts.length === 0) return
    const text = prompts.map((p, i) => `--- Prompt ${i + 1} ---\n${p}`).join('\n\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `flow-prompts-${snap.id.slice(0, 8)}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [prompts, snap.id])

  const emptyCount = total - completed

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
      {/* Header + stats + primary actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
          <ImageIcon className="h-4 w-4" aria-hidden="true" />
          Google Flow handoff — {completed}/{total} images received
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button asChild size="sm" className="h-8 bg-amber-500 text-zinc-950 hover:bg-amber-400">
            <a href={FLOW_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Open Google Flow
            </a>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
            onClick={copyAllPrompts}
            disabled={prompts.length === 0}
          >
            {copiedAll ? (
              <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            ) : (
              <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copiedAll ? 'Copied!' : 'Copy all prompts'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
            onClick={downloadPrompts}
            disabled={prompts.length === 0}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            .txt
          </Button>
        </div>
      </div>

      {/* Automatic engine — the Flow Bridge drives the REAL Google Flow tab */}
      <FlowBridgePanel snap={snap} />

      {/* Manual handoff — always-available fallback */}
      <p className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Manual handoff — fallback if the bridge is offline
      </p>

      {/* 3-step instructions */}
      <ol className="grid gap-1.5 text-[11px] leading-relaxed text-zinc-400 sm:grid-cols-3">
        <li className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
          <span className="font-semibold text-amber-400/90">1. Copy</span> — copy a prompt
          (or all of them) below. Each one is anchored to its exact narration chunk.
        </li>
        <li className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
          <span className="font-semibold text-amber-400/90">2. Generate</span> — paste it
          into Google Flow and generate the image with your Flow account (16:9). Download
          the result.
        </li>
        <li className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
          <span className="font-semibold text-amber-400/90">3. Upload</span> — drag &amp; drop
          the exported images into the box below. Press "Assemble video" when ready.
        </li>
      </ol>

      {/* Prompt list */}
      {prompts.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-500/80">
            {prompts.length} prompts (slot # = order)
          </p>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-1.5 scroll-smooth [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            {prompts.map((p, i) => {
              const done = slots[i]?.status === 'done'
              const copied = copiedIdx === i
              const expanded = expandedIdx === i
              return (
                <div
                  key={i}
                  className={`group flex items-start gap-2 rounded-md border px-2 py-1.5 ${
                    done
                      ? 'border-emerald-500/25 bg-emerald-500/5'
                      : 'border-zinc-800/70 bg-zinc-900/40'
                  }`}
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                      done ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-400'
                    }`}
                    title={done ? 'Image received' : 'Waiting for its image'}
                  >
                    #{i + 1}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left text-[11px] leading-relaxed text-zinc-300"
                    onClick={() => setExpandedIdx(expanded ? null : i)}
                    aria-expanded={expanded}
                    title={slots[i]?.chunkText ?? undefined}
                  >
                    <span className={expanded ? '' : 'line-clamp-2'}>{p}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {done && <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      onClick={() => copyPrompt(p, i)}
                      aria-label={`Copy prompt ${i + 1}`}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                      ) : (
                        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span className="ml-1 hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Dropzone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload your Google Flow images (drag and drop or click to browse)"
        onClick={() => !uploading && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
            e.preventDefault()
            fileInputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
          if (files.length === 0) {
            setError('No image files were dropped — export images from Google Flow first.')
            return
          }
          void uploadFiles(files)
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragging
            ? 'border-amber-400 bg-amber-500/10'
            : 'border-zinc-700 bg-zinc-950/50 hover:border-amber-500/50 hover:bg-amber-500/5'
        } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
      >
        {uploading ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-amber-400" aria-hidden="true" />
            <p className="text-xs font-medium text-amber-300">Receiving your Flow images…</p>
            <p className="text-[11px] text-zinc-500">
              Each image is normalized to JPEG before it lands in its slot.
            </p>
          </>
        ) : (
          <>
            <Upload className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <p className="text-xs font-medium text-zinc-300">
              Drop your Google Flow images here — or click to browse
            </p>
            <p className="text-[11px] text-zinc-500">
              {emptyCount > 0
                ? `${emptyCount} slot${emptyCount === 1 ? '' : 's'} still empty · files fill slots in filename order`
                : 'All slots are filled — assemble when ready'}
            </p>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = '' // allow re-selecting the same file
            if (files.length > 0) void uploadFiles(files)
          }}
        />
      </div>

      {error && (
        <p className="text-[11px] leading-relaxed text-red-400" role="alert">
          {error}
        </p>
      )}

      {/* Uploaded images grid */}
      {slots.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-500/80">
            Received images (hover to remove)
          </p>
          <div className="grid max-h-72 grid-cols-3 gap-1.5 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-1.5 sm:grid-cols-4 md:grid-cols-6 scroll-smooth [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            {slots.map((slot) => (
              <div key={slot.index} className="group relative">
                <FlowThumbCell slot={slot} jobId={jobId ?? ''} />
                {slot.status === 'done' && (
                  <button
                    type="button"
                    aria-label={`Remove image ${slot.index + 1}`}
                    onClick={() => removeSlot(slot.index)}
                    className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded bg-red-500/80 text-white shadow group-hover:flex"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Assemble */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/70 pt-2.5">
        <p className="text-[11px] leading-relaxed text-zinc-500">
          {completed < total
            ? `You can assemble with fewer images — pacing adapts (${completed}/${total} received).`
            : 'All images received — assemble when ready.'}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={assemble}
          disabled={completed < 1 || uploading || finishing}
          className="h-9 bg-amber-500 text-zinc-950 hover:bg-amber-400"
        >
          {finishing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Clapperboard className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {finishing
            ? 'Starting assembly…'
            : `Assemble video · ${completed} image${completed === 1 ? '' : 's'}`}
        </Button>
      </div>
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
  images: 'Google Flow · image handoff',
  video: 'Assembling final video'
}

'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Youtube,
  FileText,
  WandSparkles,
  Lock,
  Check,
  Copy,
  Download,
  Eraser,
  Loader2,
  AlertCircle,
  Sparkles,
  Clock3,
  Type,
  ShieldCheck,
  Repeat,
  Mic,
  Headphones,
  RefreshCw,
  ChevronLeft,
  ChevronRight
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
import { VoiceoverPlayer } from '@/components/voiceover-player'
import { ProviderChainCard } from '@/components/provider-chain-card'
import { AIImagesCard } from '@/components/ai-images-card'
import { FinalVideoCard } from '@/components/final-video-card'
import { useToast } from '@/hooks/use-toast'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_CHARS = 50

const SAMPLE_TRANSCRIPT = `Hey everyone, welcome back to the channel. Today we are diving into something that quietly shapes almost everything you do: habits. Researchers estimate that around forty percent of the actions you perform every single day are not conscious decisions at all. They are habits, running on autopilot.

So how does this autopilot actually work? Every habit follows a three step loop. First, there is a cue, something in your environment that triggers the behavior. Second, there is the routine, which is the behavior itself. And third, there is the reward, the small hit of satisfaction that teaches your brain to repeat the loop again next time.

The good news is that you can hack this loop. Want to stop scrolling your phone at night? Make the cue invisible. Leave the charger in another room. Want to start exercising? Make the reward obvious. Track your streaks and celebrate the small wins.

Remember, you do not rise to the level of your goals. You fall to the level of your systems. Thanks for watching, and I will see you in the next one.`

type StepStatus = 'done' | 'active' | 'locked'

interface VoiceoverChunk {
  text: string
  startMs: number
  endMs: number
}

interface VoiceoverResult {
  url: string
  audioBase64: string
  mimeType: string
  durationSeconds: number
  sizeBytes: number
  voice: string
  speed: number
  generatedFromText: string
  /** Per-segment script text + audio timing — consumed by /api/images to
   *  achieve exact script-to-image alignment (image N = chunk N). */
  chunks: VoiceoverChunk[]
}

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
  { value: 0.85, label: '0.85× · relaxed' },
  { value: 1.0, label: '1.0× · normal' },
  { value: 1.15, label: '1.15× · brisk' },
  { value: 1.3, label: '1.3× · fast' }
]

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'that', 'this', 'it', 'as', 'you',
  'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'not', 'do',
  'does', 'did', 'so', 'if', 'then', 'than', 'from', 'by', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'its', 'about', 'into', 'over', 'after',
  'before', 'what', 'when', 'how', 'why', 'all', 'any', 'each', 'just', 'also',
  'more', 'most', 'some', 'such', 'no', 'nor', 'only', 'own', 'same', 'too',
  'very', 'now', 'there', 'here', 'out', 'up', 'down', 'again', 'get', 'got'
])

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch wrapper that never chokes on non-JSON (e.g. HTML error pages). */
async function fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
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

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Rough vocabulary overlap (stopword-filtered Jaccard). Lower = more original. */
function vocabularyOverlap(a: string, b: string): number | null {
  const extract = (t: string) =>
    new Set(
      (t.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
        (w) => !STOPWORDS.has(w) && w.length > 2
      )
    )
  const wa = extract(a)
  const wb = extract(b)
  if (wa.size === 0 || wb.size === 0) return null
  let inter = 0
  wa.forEach((w) => {
    if (wb.has(w)) inter++
  })
  const union = new Set([...wa, ...wb]).size
  return Math.round((inter / union) * 100)
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const { toast } = useToast()

  const [transcript, setTranscript] = useState('')
  const [output, setOutput] = useState('')
  const [isRewriting, setIsRewriting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [rewriteProgress, setRewriteProgress] = useState<{ done: number; total: number } | null>(null)
  // Retry-queue waiting state: when the LLM wrapper enters its smart queue
  // (all 3 tiers — Z.ai + Cloudflare + Groq — momentarily overloaded), the
  // polling loop sets this so the UI can render
  // "Waiting for AI capacity, retrying in Xs..." with a LIVE countdown
  // instead of an error toast. The user NEVER sees "very busy" anymore.
  const [waitingInfo, setWaitingInfo] = useState<{
    round: number
    maxRounds: number
    retryInSecs: number
    endsAt: number
    lastError: string
  } | null>(null)
  // Rate-limit cooldown: after a 429 the user must wait before retrying.
  // (Legacy — kept for backward compat with any path that still surfaces a
  // 429 directly. The retry-queue should make this unreachable for LLM calls.)
  const [retryCooldownUntil, setRetryCooldownUntil] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Voiceover (Phase 2)
  const [selectedVoice, setSelectedVoice] = useState('en-US-ChristopherNeural')
  const [selectedSpeed, setSelectedSpeed] = useState(1.0)
  const [voiceover, setVoiceover] = useState<VoiceoverResult | null>(null)
  const [isGeneratingVoiceover, setIsGeneratingVoiceover] = useState(false)
  const [voiceoverError, setVoiceoverError] = useState<string | null>(null)
  const [voiceoverProgress, setVoiceoverProgress] = useState<{
    done: number
    total: number
    label: string | null
  } | null>(null)

  // AI Images (Phase 3)
  const [imagesStatus, setImagesStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [imageJobId, setImageJobId] = useState<string | null>(null)
  const [imageCount, setImageCount] = useState<number | null>(null)

  // Final Video (Phase 4)
  const [videoStatus, setVideoStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')

  // Wizard step (1-indexed; starts on step 2 "Transcript" since step 1 "YouTube Link" is locked/coming-soon)
  const [currentStep, setCurrentStep] = useState(2)

  const outputRef = useRef<HTMLDivElement>(null)
  const voiceoverUrlRef = useRef<string | null>(null)

  // Revoke the audio blob URL when the page unmounts
  useEffect(() => {
    return () => {
      if (voiceoverUrlRef.current) URL.revokeObjectURL(voiceoverUrlRef.current)
    }
  }, [])

  // Wizard auto-advance: image generation done → jump to step 6 (Final Video)
  useEffect(() => {
    if (imagesStatus === 'done') {
      setCurrentStep(6)
    }
  }, [imagesStatus])

  // Tick a 1s clock while a rate-limit cooldown OR a retry-queue wait is
  // active, and clear them when they expire. The same interval drives both —
  // the waiting countdown re-renders every second so the user sees the timer
  // tick down live (no need to poll the server every second).
  useEffect(() => {
    if (retryCooldownUntil == null && waitingInfo == null) return
    const now = Date.now()
    if (retryCooldownUntil != null && now >= retryCooldownUntil) {
      setRetryCooldownUntil(null)
    }
    if (waitingInfo != null && now >= waitingInfo.endsAt) {
      // Wait elapsed — the next poll will either show a fresh wait round
      // (if the queue is still running) or flip back to 'processing'.
      // Don't clear waitingInfo here — let the next poll overwrite it so
      // there's no UI flicker between "0s" and the next round's new value.
    }
    const id = setInterval(() => {
      setNowTick(Date.now())
      if (retryCooldownUntil != null && Date.now() >= retryCooldownUntil) {
        setRetryCooldownUntil(null)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [retryCooldownUntil, waitingInfo])

  // Input stats (live)
  const inputWords = useMemo(() => countWords(transcript), [transcript])
  const inputChars = transcript.length
  const inputDuration = inputWords / 2.5 // ~150 words per minute narration

  // Output stats
  const outputWords = useMemo(() => countWords(output), [output])
  const outputDuration = outputWords / 2.5
  // Rate-limit cooldown display (recomputed each tick).
  const onRewriteCooldown = retryCooldownUntil != null && nowTick < retryCooldownUntil
  const rewriteCooldownSecs = onRewriteCooldown
    ? Math.ceil((retryCooldownUntil! - nowTick) / 1000)
    : 0
  const overlap = useMemo(
    () => (output ? vocabularyOverlap(transcript, output) : null),
    [transcript, output]
  )
  const lengthDelta =
    inputWords > 0 && outputWords > 0
      ? Math.round(((outputWords - inputWords) / inputWords) * 100)
      : null

  // Pipeline progress (dynamic)
  const hasTranscript = transcript.trim().length >= MIN_CHARS
  const pipelineSteps: { id: number; label: string; status: StepStatus }[] = [
    { id: 1, label: 'YouTube Link', status: 'locked' },
    { id: 2, label: 'Transcript', status: hasTranscript ? 'done' : 'active' },
    { id: 3, label: 'Rewrite Script', status: output ? 'done' : hasTranscript ? 'active' : 'locked' },
    { id: 4, label: 'Voiceover', status: voiceover ? 'done' : output ? 'active' : 'locked' },
    {
      id: 5,
      label: 'AI Images',
      status:
        imagesStatus === 'done'
          ? 'done'
          : imagesStatus === 'generating' || voiceover
            ? 'active'
            : 'locked'
    },
    {
      id: 6,
      label: 'Final Video',
      status:
        videoStatus === 'done'
          ? 'done'
          : videoStatus === 'generating' || imageJobId
            ? 'active'
            : 'locked'
    }
  ]

  // Warn when the script was edited after the voiceover was generated
  const scriptEditedAfterVoiceover =
    voiceover !== null && output.trim() !== voiceover.generatedFromText

  // ── Wizard: can the user advance from the current step? ─────────────────────
  // Each step has a clear "completeness" gate that lights up the Next button.
  const canAdvanceFromCurrentStep = (() => {
    switch (currentStep) {
      case 2:
        return hasTranscript // transcript >= MIN_CHARS
      case 3:
        return !!output.trim() // rewrite output exists
      case 4:
        return !!voiceover // voiceover generated
      case 5:
        return imagesStatus === 'done' // images generated
      case 6:
        return false // last step — no "next"
      default:
        return false
    }
  })()

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const handleRewrite = useCallback(async () => {
    const text = transcript.trim()

    if (text.length < MIN_CHARS) {
      toast({
        variant: 'destructive',
        title: 'Transcript too short',
        description: `Please paste a transcript of at least ${MIN_CHARS} characters before rewriting.`
      })
      return
    }

    // Block rapid retries while a rate-limit cooldown is active.
    if (retryCooldownUntil && Date.now() < retryCooldownUntil) {
      const secs = Math.ceil((retryCooldownUntil - Date.now()) / 1000)
      toast({
        variant: 'destructive',
        title: 'Please wait a moment',
        description: `The AI service just rate-limited us. Try again in ${secs}s.`
      })
      return
    }

    setIsRewriting(true)
    setErrorMsg(null)
    setOutput('')
    setRewriteProgress(null)
    setWaitingInfo(null)

    try {
      // 1) Start the async rewrite job — returns immediately with a jobId
      const { ok, status, json } = await fetchJson('/api/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text })
      })

      const startData = json.data as { jobId: string; totalSections: number } | undefined
      if (!ok || !json.success || !startData) {
        throw new Error((json.error as string) || `Request failed with status ${status}`)
      }

      setRewriteProgress({ done: 0, total: startData.totalSections })

      // 2) Poll for progress until the job finishes.
      //
      // The polling deadline STARTS at 28 minutes (generous — the rewrite
      // job's server-side TTL is 30min). Every time the poll returns a
      // 'waiting' status (LLM retry-queue active), the deadline is EXTENDED
      // by the wait's remaining seconds + a 30s safety margin — so the
      // polling loop NEVER gives up while the retry-queue is still spinning,
      // even in the pathological worst case (6 rounds × 2min = 12min per
      // section × multiple sections).
      let deadline = Date.now() + 28 * 60 * 1000
      let result: { rewritten: string; originalWordCount: number; rewrittenWordCount: number } | null = null

      while (Date.now() < deadline) {
        await sleep(1500)

        const poll = await fetchJson(`/api/rewrite?jobId=${encodeURIComponent(startData.jobId)}`, { method: 'GET' })
        const pollData = poll.json.data as
          | { status: 'processing'; completedSections: number; totalSections: number }
          | {
              status: 'waiting'
              completedSections: number
              totalSections: number
              waiting: {
                round: number
                maxRounds: number
                retryInSecs: number
                retryInSecsRemaining: number
                startedAt: number
                endsAt: number
                lastError: string
              } | null
            }
          | ({ status: 'done'; rewritten: string; originalWordCount: number; rewrittenWordCount: number })
          | undefined

        if (!poll.json.success || !pollData) {
          throw new Error((poll.json.error as string) || 'Lost track of the rewrite job. Please try again.')
        }

        if (pollData.status === 'processing') {
          // Normal progress — clear any lingering waiting state.
          if (waitingInfo != null) setWaitingInfo(null)
          setRewriteProgress({ done: pollData.completedSections, total: pollData.totalSections })
          continue
        }

        if (pollData.status === 'waiting') {
          // LLM retry-queue active (all 3 tiers momentarily overloaded).
          // Surface the live countdown to the UI — DO NOT throw, DO NOT
          // show an error toast. The request is still in flight, just
          // queued waiting for any tier to recover. Extend the polling
          // deadline so we don't time out mid-queue.
          const w = pollData.waiting
          if (w) {
            setWaitingInfo({
              round: w.round,
              maxRounds: w.maxRounds,
              retryInSecs: w.retryInSecs,
              endsAt: w.endsAt,
              lastError: w.lastError
            })
            // Extend deadline to (wait end + 30s safety) OR current deadline+5min,
            // whichever is larger — so we never time out while queue is active.
            const extended = w.endsAt + 30_000
            if (extended > deadline) deadline = extended
          }
          setRewriteProgress({ done: pollData.completedSections, total: pollData.totalSections })
          continue
        }

        if (pollData.status === 'done') {
          result = pollData
          break
        }
      }

      if (!result) {
        throw new Error(
          'The rewrite is taking longer than expected — the AI service may be rate-limiting us. Please wait about a minute and try again.'
        )
      }

      setOutput(result.rewritten)
      // Clear any lingering waiting state on success.
      setWaitingInfo(null)

      // Wizard auto-advance: rewrite done → jump to step 4 (Voiceover)
      setCurrentStep(4)

      toast({
        title: 'Script rewritten',
        description: `Original ${result.originalWordCount} words → Rewritten ${result.rewrittenWordCount} words.`
      })

      // Scroll output into view on small screens
      if (window.innerWidth < 1024) {
        outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } catch (err) {
      const raw =
        err instanceof Error
          ? err.message
          : 'Something went wrong while rewriting the script.'

      // Daily-quota exhaustion (precise message from the server's headers).
      // A 30s cooldown is pointless here (resets in hours), so we don't set one.
      const isDailyExhausted = /daily request quota|0 of \d+ daily/i.test(raw)

      // Transient rate-limit / busy signals — apply a 30s cooldown.
      // (Now mostly unreachable for LLM calls — the smart retry-queue
      // absorbs all "very busy" conditions BEFORE the user sees them —
      // but kept as a defensive cooldown for any residual 429 path.)
      const isRateLimited =
        !isDailyExhausted &&
        /rate[\s_-]?limit|too many requests|429|busy right now|temporarily overloaded after extensive/i.test(raw)

      const message = isRateLimited && !isDailyExhausted
        ? 'All AI providers are temporarily overloaded after extensive automatic retrying. Please try again in a few minutes.'
        : raw

      setErrorMsg(message)
      if (isRateLimited && !isDailyExhausted) {
        setNowTick(Date.now())
        setRetryCooldownUntil(Date.now() + 30_000)
      }
      toast({
        variant: 'destructive',
        title: isDailyExhausted
          ? 'Daily quota used up'
          : isRateLimited
            ? 'AI capacity exhausted'
            : 'Rewrite failed',
        description: message
      })
    } finally {
      setIsRewriting(false)
      setRewriteProgress(null)
      setWaitingInfo(null)
    }
  }, [transcript, toast, retryCooldownUntil, waitingInfo])

  const handleCopy = useCallback(async () => {
    if (!output) return
    try {
      await navigator.clipboard.writeText(output)
      toast({ title: 'Copied', description: 'Rewritten script copied to clipboard.' })
    } catch {
      toast({
        variant: 'destructive',
        title: 'Copy failed',
        description: 'Could not access the clipboard. Please select and copy manually.'
      })
    }
  }, [output, toast])

  const handleDownload = useCallback(() => {
    if (!output) return
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'rewritten-script.txt'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast({ title: 'Downloaded', description: 'rewritten-script.txt saved.' })
  }, [output, toast])

  const handleGenerateVoiceover = useCallback(async () => {
    const text = output.trim()

    if (text.length < 20) {
      toast({
        variant: 'destructive',
        title: 'No script to narrate',
        description: 'Rewrite a script first — the voiceover narrates the rewritten script text.'
      })
      return
    }

    setIsGeneratingVoiceover(true)
    setVoiceoverError(null)
    setVoiceoverProgress(null)

    try {
      // 1) Start the async voiceover job — returns immediately with a jobId.
      //    The actual TTS + ffmpeg work runs detached in the background, so the
      //    HTTP connection can never time out (the old synchronous version
      //    returned 502 on any script long enough to push past ~60s of work).
      const startRes = await fetchJson('/api/voiceover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: selectedVoice, speed: selectedSpeed })
      })

      const startData = startRes.json.data as { jobId: string; total: number } | undefined
      if (!startRes.ok || !startRes.json.success || !startData) {
        throw new Error(
          (startRes.json.error as string) || `Request failed with status ${startRes.status}`
        )
      }

      setVoiceoverProgress({ done: 0, total: startData.total, label: 'Starting synthesis' })

      // 2) Poll for progress until the job finishes (max ~10 minutes guard)
      const deadline = Date.now() + 10 * 60 * 1000
      let result: {
        audioBase64: string
        mimeType: string
        durationSeconds: number
        sizeBytes: number
        chunkCount: number
        voice: string
        speed: number
      } | null = null

      while (Date.now() < deadline) {
        await sleep(1200)

        const poll = await fetchJson(
          `/api/voiceover?jobId=${encodeURIComponent(startData.jobId)}`,
          { method: 'GET' }
        )
        const pollData = poll.json.data as
          | ({ status: 'processing'; completedChunks: number; totalChunks: number; currentLabel: string | null })
          | ({
              status: 'done'
              audioBase64: string
              mimeType: string
              durationSeconds: number
              sizeBytes: number
              chunkCount: number
              voice: string
              speed: number
            })
          | undefined

        if (!poll.json.success || !pollData) {
          throw new Error(
            (poll.json.error as string) || 'Lost track of the voiceover job. Please try again.'
          )
        }

        if (pollData.status === 'processing') {
          setVoiceoverProgress({
            done: pollData.completedChunks,
            total: pollData.totalChunks,
            label: pollData.currentLabel
          })
          continue
        }

        if (pollData.status === 'done') {
          result = pollData
          break
        }
      }

      if (!result) {
        throw new Error('The voiceover is taking unusually long. Please try again.')
      }

      // Decode base64 → Blob → object URL
      const binary = atob(result.audioBase64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: result.mimeType })
      const url = URL.createObjectURL(blob)

      // Revoke previous audio URL if any
      if (voiceoverUrlRef.current) URL.revokeObjectURL(voiceoverUrlRef.current)
      voiceoverUrlRef.current = url

      setVoiceover({
        url,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        durationSeconds: result.durationSeconds,
        sizeBytes: result.sizeBytes,
        voice: result.voice,
        speed: result.speed,
        generatedFromText: text,
        chunks: Array.isArray(result.chunks) ? result.chunks : []
      })

      // Wizard auto-advance: voiceover done → jump to step 5 (AI Images)
      setCurrentStep(5)

      toast({
        title: 'Voiceover ready',
        description: `${result.durationSeconds}s of narration generated from ${result.chunkCount} segment${result.chunkCount > 1 ? 's' : ''}.`
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Voiceover generation failed.'
      setVoiceoverError(message)
      toast({
        variant: 'destructive',
        title: 'Voiceover failed',
        description: message
      })
    } finally {
      setIsGeneratingVoiceover(false)
      setVoiceoverProgress(null)
    }
  }, [output, selectedVoice, selectedSpeed, toast])

  const handleDownloadVoiceover = useCallback(() => {
    if (!voiceover) return
    const a = document.createElement('a')
    a.href = voiceover.url
    a.download = 'voiceover.mp3'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    toast({ title: 'Downloaded', description: 'voiceover.mp3 saved.' })
  }, [voiceover, toast])

  const stepIcon = (status: StepStatus) => {
    switch (status) {
      case 'done':
        return <Check className="h-4 w-4" />
      case 'active':
        return <WandSparkles className="h-4 w-4" />
      case 'locked':
        return <Lock className="h-4 w-4" />
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  // Extracted so the input card can be reused on both the Transcript (step 2)
  // and Rewrite Script (step 3) views of the wizard, and the output card can
  // be embedded in step 3. All closures (state + handlers) are in scope.

  const renderInputCard = () => (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
    >
      <Card className="border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-zinc-400" aria-hidden="true" />
              Original Transcript
            </CardTitle>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setTranscript(SAMPLE_TRANSCRIPT)
                  toast({
                    title: 'Sample loaded',
                    description: 'A demo transcript has been pasted into the input.'
                  })
                }}
                className="h-10 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
              >
                Load sample
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setTranscript('')}
                disabled={!transcript}
                aria-label="Clear transcript"
                className="h-10 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
              >
                <Eraser className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Clear</span>
              </Button>
            </div>
          </div>
          <CardDescription>Paste the video transcript you want to rewrite.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Paste your transcript here… (or click “Load sample” to try it instantly)"
            aria-label="Original transcript input"
            className="min-h-[260px] resize-y border-zinc-800 bg-zinc-950/70 text-sm leading-relaxed placeholder:text-zinc-600 focus-visible:ring-red-500/60 sm:min-h-[300px]"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5">
              <Type className="h-3.5 w-3.5" aria-hidden="true" />
              {inputWords.toLocaleString()} words
            </span>
            <span>{inputChars.toLocaleString()} characters</span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              ~{formatDuration(inputDuration)} voiceover
            </span>
            {inputChars > 0 && inputChars < MIN_CHARS && (
              <span className="text-amber-500">Minimum {MIN_CHARS} characters required</span>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )

  const renderOutputCard = () => (
    <motion.div
      ref={outputRef}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      <Card
        className={`border bg-zinc-900/40 backdrop-blur-sm transition-colors ${
          isRewriting
            ? 'border-red-500/40'
            : output
              ? 'border-emerald-500/30'
              : 'border-zinc-800/60'
        }`}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <WandSparkles
                className={`h-4 w-4 ${isRewriting ? 'animate-pulse text-red-400' : 'text-zinc-400'}`}
                aria-hidden="true"
              />
              Rewritten Script
            </CardTitle>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!output || isRewriting}
                aria-label="Copy rewritten script"
                className="h-10 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Copy</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!output || isRewriting}
                aria-label="Download rewritten script as text file"
                className="h-10 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Download</span>
              </Button>
            </div>
          </div>
          <CardDescription>AI-paraphrased, copyright-safe — edit before narrating.</CardDescription>
        </CardHeader>
        <CardContent>
          {isRewriting ? (
            <div className="space-y-4 py-2" aria-live="polite">
              <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                <Sparkles className="h-4 w-4 animate-pulse" aria-hidden="true" />
                AI is rewriting your script…
              </p>
              {waitingInfo ? (
                // ── Retry-queue waiting countdown ──
                // The LLM wrapper entered its smart retry-queue (all 3
                // tiers momentarily overloaded). Surface a live countdown
                // instead of an error — the request is still in flight,
                // just queued waiting for any tier to recover.
                <div
                  className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
                  role="status"
                  aria-live="polite"
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
                    <Clock3 className="h-4 w-4 animate-pulse" aria-hidden="true" />
                    Waiting for AI capacity, retrying in{' '}
                    <span className="font-mono tabular-nums">
                      {Math.max(0, Math.ceil((waitingInfo.endsAt - nowTick) / 1000))}s
                    </span>
                    …
                  </div>
                  <div className="flex items-center justify-between text-xs text-amber-200/70">
                    <span>
                      Retry-queue round{' '}
                      <span className="font-mono tabular-nums">
                        {waitingInfo.round}
                      </span>
                      {' / '}
                      <span className="font-mono tabular-nums">
                        {waitingInfo.maxRounds}
                      </span>{' '}
                      — trying Z.ai → Cloudflare → Groq again.
                    </span>
                  </div>
                  <Progress
                    value={
                      ((waitingInfo.retryInSecs -
                        Math.max(0, Math.ceil((waitingInfo.endsAt - nowTick) / 1000))) /
                        Math.max(1, waitingInfo.retryInSecs)) *
                      100
                    }
                    aria-label="Wait countdown"
                    className="h-1.5 bg-amber-950/40 [&>div]:bg-amber-500"
                  />
                  <p className="text-xs text-amber-200/50">
                    All 3 AI providers (Z.ai, Cloudflare, Groq) are momentarily overloaded. The request is queued and will retry automatically — keep this tab open.
                  </p>
                </div>
              ) : rewriteProgress && rewriteProgress.total > 1 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>
                      Rewriting section{' '}
                      <span className="font-medium text-zinc-200">
                        {Math.min(rewriteProgress.done + 1, rewriteProgress.total)}
                      </span>{' '}
                      of {rewriteProgress.total}
                    </span>
                    <span className="font-mono tabular-nums">
                      {Math.round((rewriteProgress.done / rewriteProgress.total) * 100)}%
                    </span>
                  </div>
                  <Progress
                    value={(rewriteProgress.done / rewriteProgress.total) * 100}
                    aria-label="Rewrite progress"
                    className="h-2 bg-zinc-800 [&>div]:bg-red-600"
                  />
                </div>
              ) : (
                <div className="h-2" />
              )}
              <div className="space-y-3">
                {[92, 84, 96, 70, 88, 60].map((w, i) => (
                  <div
                    key={i}
                    className="h-3.5 animate-pulse rounded-full bg-zinc-800"
                    style={{ width: `${w}%`, animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            </div>
          ) : errorMsg ? (
            <Alert variant="destructive" className="border-red-500/40 bg-red-500/10">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Could not rewrite the script</AlertTitle>
              <AlertDescription className="text-red-200/80">{errorMsg}</AlertDescription>
            </Alert>
          ) : output ? (
            <motion.div
              key={output.slice(0, 40)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="space-y-3"
            >
              <Textarea
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                aria-label="Rewritten script output"
                className="min-h-[260px] resize-y border-emerald-500/25 bg-zinc-950/70 text-sm leading-relaxed focus-visible:ring-emerald-500/50 sm:min-h-[300px]"
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-1.5">
                  <Type className="h-3.5 w-3.5" aria-hidden="true" />
                  {outputWords.toLocaleString()} words
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                  ~{formatDuration(outputDuration)} voiceover
                </span>
                {lengthDelta !== null && (
                  <span>
                    Length:{' '}
                    <span
                      className={
                        Math.abs(lengthDelta) <= 15 ? 'text-emerald-400' : 'text-amber-500'
                      }
                    >
                      {lengthDelta > 0 ? '+' : ''}
                      {lengthDelta}%
                    </span>{' '}
                    vs original
                  </span>
                )}
                {overlap !== null && (
                  <span>
                    Vocabulary overlap:{' '}
                    <span
                      className={
                        overlap < 30 ? 'text-emerald-400' : overlap < 50 ? 'text-amber-500' : 'text-red-400'
                      }
                    >
                      {overlap}%
                    </span>
                  </span>
                )}
              </div>
            </motion.div>
          ) : (
            <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-10 text-center sm:min-h-[300px]">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
                <Sparkles className="h-5 w-5 text-zinc-500" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-zinc-300">
                Your rewritten script will appear here
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-zinc-500">
                Hit “Rewrite Script” — the AI keeps the meaning, changes the wording.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )

  return (
    <div className="dark flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* ── Header (compact) ── */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-red-600 to-orange-500 shadow-lg shadow-red-600/30">
              <Youtube className="h-4 w-4 text-white" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold leading-tight">AutoTube Studio</p>
          </div>
          <Badge
            variant="outline"
            className="border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-400"
          >
            Phase 4 · Final Video
          </Badge>
        </div>
      </header>

      {/* ── Short hero ── */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-8 text-center sm:px-6 sm:pt-10">
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-2xl font-bold tracking-tight sm:text-3xl"
        >
          Rewrite any transcript into an{' '}
          <span className="bg-gradient-to-r from-red-500 to-orange-400 bg-clip-text text-transparent">
            original script
          </span>
        </motion.h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">
          A 5-step wizard that turns words into a finished, publishable video.
        </p>
      </section>

      {/* ── Sticky clickable stepper ── */}
      <div className="sticky top-14 z-30 mt-6 border-y border-zinc-800/60 bg-zinc-950/85 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70">
        <div className="mx-auto w-full max-w-6xl px-4 py-3 sm:px-6">
          <div
            role="tablist"
            aria-label="Wizard steps"
            className="flex items-center gap-1 overflow-x-auto pb-1"
          >
            {pipelineSteps.map((step, i) => {
              const isActive = step.id === currentStep
              const isUnlocked = step.status !== 'locked'
              const isDone = step.status === 'done'
              return (
                <Fragment key={step.id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    disabled={!isUnlocked}
                    onClick={() => isUnlocked && setCurrentStep(step.id)}
                    className={[
                      'group relative flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all',
                      isActive
                        ? 'border-transparent bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/25 ring-2 ring-red-500/40'
                        : isDone
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                          : isUnlocked
                            ? 'border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800'
                            : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600'
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                        isActive
                          ? 'bg-white/20 text-white'
                          : isDone
                            ? 'bg-emerald-500/30 text-emerald-200'
                            : 'bg-zinc-800 text-zinc-400'
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      {isDone ? <Check className="h-3 w-3" /> : step.id}
                    </span>
                    <span className="whitespace-nowrap">{step.label}</span>
                    {isActive && (
                      <span
                        className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-white/80"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {i < pipelineSteps.length - 1 && (
                    <span
                      className="h-px min-w-4 flex-1 bg-zinc-800"
                      aria-hidden="true"
                    />
                  )}
                </Fragment>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Main ── */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {/* Step 1 — YouTube Link (locked / coming soon) */}
        {currentStep === 1 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-label="YouTube link extraction — coming soon"
          >
            <Card className="border-dashed border-zinc-800/80 bg-zinc-900/40 backdrop-blur-sm">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                  <Lock className="h-6 w-6 text-zinc-500" aria-hidden="true" />
                </div>
                <p className="text-base font-semibold text-zinc-200">
                  YouTube link extraction — coming soon
                </p>
                <p className="max-w-md text-xs text-zinc-500">
                  Paste a transcript directly in step 2 for now. Auto-extraction
                  from a YouTube URL arrives in a later phase.
                </p>
              </CardContent>
            </Card>
          </motion.section>
        )}

        {/* Step 2 — Transcript (input only) */}
        {currentStep === 2 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-label="Transcript input"
            className="rounded-2xl border border-red-500/30 bg-zinc-900/40 p-6 shadow-lg shadow-red-500/5 backdrop-blur-sm"
          >
            {renderInputCard()}
          </motion.section>
        )}

        {/* Step 3 — Rewrite Script (input + output + Rewrite CTA) */}
        {currentStep === 3 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-label="Rewrite script"
            className="rounded-2xl border border-red-500/30 bg-zinc-900/40 p-6 shadow-lg shadow-red-500/5 backdrop-blur-sm"
          >
            <div className="grid items-start gap-6 lg:grid-cols-2">
              {renderInputCard()}
              {renderOutputCard()}
            </div>

            {/* Primary action — Rewrite Script */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.25 }}
              className="mt-6 flex flex-col items-center gap-3"
            >
              <Button
                type="button"
                size="lg"
                onClick={handleRewrite}
                disabled={isRewriting || onRewriteCooldown}
                aria-busy={isRewriting}
                className="h-12 w-full max-w-md rounded-xl bg-gradient-to-r from-red-600 to-orange-500 px-8 text-base font-semibold text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-orange-400 hover:shadow-red-600/40 disabled:opacity-60 sm:w-auto"
              >
                {isRewriting ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    {waitingInfo
                      ? `Waiting for AI capacity…`
                      : rewriteProgress
                        ? `Rewriting (section ${Math.min(rewriteProgress.done + 1, rewriteProgress.total)}/${rewriteProgress.total})`
                        : ' your script…'}
                  </>
                ) : onRewriteCooldown ? (
                  <>
                    <Clock3 className="h-5 w-5" aria-hidden="true" />
                    Retry in {rewriteCooldownSecs}s
                  </>
                ) : (
                  <>
                    <WandSparkles className="h-5 w-5" aria-hidden="true" />
                    Rewrite Script
                  </>
                )}
              </Button>
              <p className="text-xs text-zinc-600">
                {onRewriteCooldown
                  ? 'The AI service asked us to slow down. The button unlocks automatically.'
                  : 'Typically takes 10–30 seconds depending on transcript length.'}
              </p>
            </motion.div>
          </motion.section>
        )}

        {/* Step 4 — Voiceover */}
        {currentStep === 4 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-label="Voiceover generation"
            className="rounded-2xl border border-red-500/30 bg-zinc-900/40 p-6 shadow-lg shadow-red-500/5 backdrop-blur-sm"
          >

          <Card
            className={`border bg-zinc-900/40 backdrop-blur-sm transition-colors ${
              isGeneratingVoiceover
                ? 'border-red-500/40'
                : voiceover
                  ? 'border-emerald-500/30'
                  : 'border-zinc-800/60'
            }`}
          >
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Headphones
                    className={`h-4 w-4 ${isGeneratingVoiceover ? 'animate-pulse text-red-400' : 'text-zinc-400'}`}
                    aria-hidden="true"
                  />
                  Voiceover Generation
                </CardTitle>
                {voiceover && !isGeneratingVoiceover && (
                  <Badge
                    variant="outline"
                    className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-400"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    Narration ready
                  </Badge>
                )}
              </div>
              <CardDescription>
                Narrate the rewritten script — its measured duration drives the image count.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                {/* Controls */}
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="voice-select" className="text-xs text-zinc-400">
                      Narration voice
                    </Label>
                    <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                      <SelectTrigger
                        id="voice-select"
                        className="w-full border-zinc-800 bg-zinc-950/70 text-zinc-200 focus-visible:ring-red-500/60"
                      >
                        <SelectValue placeholder="Choose a voice" />
                      </SelectTrigger>
                      <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
                        {VOICE_OPTIONS.map((v) => (
                          <SelectItem
                            key={v.value}
                            value={v.value}
                            className="focus:bg-zinc-800 focus:text-white"
                          >
                            {v.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="speed-select" className="text-xs text-zinc-400">
                      Speaking speed
                    </Label>
                    <Select
                      value={String(selectedSpeed)}
                      onValueChange={(v) => setSelectedSpeed(parseFloat(v))}
                    >
                      <SelectTrigger
                        id="speed-select"
                        className="w-full border-zinc-800 bg-zinc-950/70 text-zinc-200 focus-visible:ring-red-500/60"
                      >
                        <SelectValue placeholder="Choose speed" />
                      </SelectTrigger>
                      <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
                        {SPEED_OPTIONS.map((s) => (
                          <SelectItem
                            key={s.value}
                            value={String(s.value)}
                            className="focus:bg-zinc-800 focus:text-white"
                          >
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    size="lg"
                    onClick={handleGenerateVoiceover}
                    disabled={isGeneratingVoiceover || !output.trim()}
                    className="h-12 w-full rounded-xl bg-gradient-to-r from-red-600 to-orange-500 text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-orange-400 disabled:opacity-60"
                  >
                    {isGeneratingVoiceover ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                        Generating voiceover…
                      </>
                    ) : (
                      <>
                        <Mic className="h-5 w-5" aria-hidden="true" />
                        Generate Voiceover
                      </>
                    )}
                  </Button>
                  <p className="text-xs leading-relaxed text-zinc-600">
                    Uses the rewritten script box — 10–60s for long scripts.
                  </p>
                </div>

                {/* Result */}
                <div>
                  {isGeneratingVoiceover && voiceoverProgress ? (
                    <div className="space-y-4 py-2" aria-live="polite">
                      <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                        <Headphones className="h-4 w-4 animate-pulse" aria-hidden="true" />
                        {voiceoverProgress.label ?? 'Converting your script to speech…'}
                      </p>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs text-zinc-500">
                          <span>
                            Segment{' '}
                            <span className="font-semibold text-zinc-300">
                              {Math.min(voiceoverProgress.done + 1, voiceoverProgress.total)}
                            </span>{' '}
                            of{' '}
                            <span className="font-semibold text-zinc-300">
                              {voiceoverProgress.total}
                            </span>
                          </span>
                          <span className="font-semibold text-zinc-300">
                            {voiceoverProgress.total > 0
                              ? Math.round(
                                  (voiceoverProgress.done / voiceoverProgress.total) * 100
                              )
                              : 0}
                            %
                          </span>
                        </div>
                        <Progress
                          value={
                            voiceoverProgress.total > 0
                              ? (voiceoverProgress.done / voiceoverProgress.total) * 100
                              : 0
                          }
                          className="h-2.5"
                        />
                      </div>
                      <div className="space-y-3">
                        {[90, 78, 95, 64, 86, 58, 92].map((w, i) => (
                          <div
                            key={i}
                            className="h-3.5 animate-pulse rounded-full bg-zinc-800"
                            style={{ width: `${w}%`, animationDelay: `${i * 140}ms` }}
                          />
                        ))}
                      </div>
                      <p className="text-xs text-zinc-500">
                        Narrating each segment and merging audio. Long scripts run in the background.
                      </p>
                    </div>
                  ) : isGeneratingVoiceover ? (
                    <div className="space-y-4 py-2" aria-live="polite">
                      <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                        <Headphones className="h-4 w-4 animate-pulse" aria-hidden="true" />
                        Starting voiceover job…
                      </p>
                    </div>
                  ) : voiceoverError ? (
                    <Alert variant="destructive" className="border-red-500/40 bg-red-500/10">
                      <AlertCircle className="h-4 w-4" aria-hidden="true" />
                      <AlertTitle>Could not generate the voiceover</AlertTitle>
                      <AlertDescription className="text-red-200/80">
                        {voiceoverError}
                      </AlertDescription>
                    </Alert>
                  ) : voiceover ? (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.4 }}
                      className="space-y-4"
                    >
                      <VoiceoverPlayer
                        key={voiceover.url}
                        url={voiceover.url}
                        durationSeconds={voiceover.durationSeconds}
                      />

                      {scriptEditedAfterVoiceover && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
                          <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>
                            The script was edited after this voiceover was generated.
                            Regenerate to match the updated text.
                          </span>
                        </div>
                      )}

                      <div className="grid grid-cols-3 gap-3">
                        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-center">
                          <p className="text-lg font-bold text-red-400 sm:text-xl">
                            {voiceover.durationSeconds.toFixed(1)}s
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-500">Total duration</p>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-center">
                          <p className="text-lg font-bold text-zinc-200 sm:text-xl">
                            {(voiceover.sizeBytes / (1024 * 1024)).toFixed(2)}
                            <span className="text-xs font-medium"> MB</span>
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-500">MP3 file size</p>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-center">
                          <p className="text-lg font-bold text-zinc-200 sm:text-xl">
                            {Math.ceil(voiceover.durationSeconds / 4)}
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-500">
                            Images @ 4s · Phase 3
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleDownloadVoiceover}
                          className="flex-1 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          Download MP3
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleGenerateVoiceover}
                          disabled={isGeneratingVoiceover}
                          className="flex-1 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
                        >
                          <RefreshCw className="h-4 w-4" aria-hidden="true" />
                          Regenerate
                        </Button>
                      </div>
                    </motion.div>
                  ) : (
                    <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-10 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
                        <Headphones className="h-5 w-5 text-zinc-500" aria-hidden="true" />
                      </div>
                      <p className="text-sm font-medium text-zinc-300">
                        Your narrated voiceover will appear here
                      </p>
                      <p className="max-w-xs text-xs leading-relaxed text-zinc-500">
                        {output.trim()
                          ? 'Pick a voice and speed, then hit “Generate Voiceover”.'
                          : 'Rewrite a script first — the voiceover narrates it.'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.section>
          )
        }



        {/* Step 5 — AI Images (provider chain + images) */}
        {currentStep === 5 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-label="AI image generation"
            className="rounded-2xl border border-red-500/30 bg-zinc-900/40 p-6 shadow-lg shadow-red-500/5 backdrop-blur-sm"
          >
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
              <ProviderChainCard />
              <AIImagesCard
                script={output}
                voiceoverDuration={voiceover?.durationSeconds ?? null}
                voiceoverChunks={voiceover?.chunks ?? null}
                onStatusChange={setImagesStatus}
                onJobReady={(jid, total) => {
                  setImageJobId(jid)
                  setImageCount(total)
                  // Reset the video phase when a fresh image set arrives
                  setVideoStatus('idle')
                }}
              />
            </div>
          </motion.section>
          )
        }

        {/* Step 6 — Final Video */}
        {currentStep === 6 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-label="Final video assembly"
            className="rounded-2xl border border-red-500/30 bg-zinc-900/40 p-6 shadow-lg shadow-red-500/5 backdrop-blur-sm"
          >

            <FinalVideoCard
              imageJobId={imageJobId}
              imageCount={imageCount}
              voiceover={
                voiceover
                  ? {
                      audioBase64: voiceover.audioBase64,
                      mimeType: voiceover.mimeType,
                      durationSeconds: voiceover.durationSeconds
                    }
                  : null
              }
              script={output}
              onStatusChange={setVideoStatus}
            />
          </motion.section>
          )
        }

        {/* ── Prev / Next wizard nav ── */}
        <div className="mt-8 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCurrentStep((s) => Math.max(2, s - 1))}
            disabled={currentStep <= 2}
            className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Previous
          </Button>
          <p className="text-xs text-zinc-500">
            Step <span className="font-medium text-zinc-300">{currentStep}</span> of 6
          </p>
          <Button
            type="button"
            onClick={() => setCurrentStep((s) => Math.min(6, s + 1))}
            disabled={!canAdvanceFromCurrentStep || currentStep >= 6}
            className="bg-gradient-to-r from-red-600 to-orange-500 text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-orange-400 hover:shadow-red-600/40 disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </main>

      {/* ── Footer (minimal) ── */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-1.5 px-4 py-4 text-xs text-zinc-500 sm:px-6">
          <Youtube className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
          AutoTube Studio · Phase 4 — Final Video
        </div>
      </footer>
    </div>
  )
}

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
  RefreshCw
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

interface VoiceoverResult {
  url: string
  audioBase64: string
  mimeType: string
  durationSeconds: number
  sizeBytes: number
  voice: string
  speed: number
  generatedFromText: string
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

  // Voiceover (Phase 2)
  const [selectedVoice, setSelectedVoice] = useState('en-US-ChristopherNeural')
  const [selectedSpeed, setSelectedSpeed] = useState(1.0)
  const [voiceover, setVoiceover] = useState<VoiceoverResult | null>(null)
  const [isGeneratingVoiceover, setIsGeneratingVoiceover] = useState(false)
  const [voiceoverError, setVoiceoverError] = useState<string | null>(null)

  // AI Images (Phase 3)
  const [imagesStatus, setImagesStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [imageJobId, setImageJobId] = useState<string | null>(null)
  const [imageCount, setImageCount] = useState<number | null>(null)

  // Final Video (Phase 4)
  const [videoStatus, setVideoStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')

  const outputRef = useRef<HTMLDivElement>(null)
  const voiceoverUrlRef = useRef<string | null>(null)

  // Revoke the audio blob URL when the page unmounts
  useEffect(() => {
    return () => {
      if (voiceoverUrlRef.current) URL.revokeObjectURL(voiceoverUrlRef.current)
    }
  }, [])

  // Input stats (live)
  const inputWords = useMemo(() => countWords(transcript), [transcript])
  const inputChars = transcript.length
  const inputDuration = inputWords / 2.5 // ~150 words per minute narration

  // Output stats
  const outputWords = useMemo(() => countWords(output), [output])
  const outputDuration = outputWords / 2.5
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

    setIsRewriting(true)
    setErrorMsg(null)
    setOutput('')
    setRewriteProgress(null)

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

      // 2) Poll for progress until the job finishes (max ~10 minutes guard)
      const deadline = Date.now() + 10 * 60 * 1000
      let result: { rewritten: string; originalWordCount: number; rewrittenWordCount: number } | null = null

      while (Date.now() < deadline) {
        await sleep(1500)

        const poll = await fetchJson(`/api/rewrite?jobId=${encodeURIComponent(startData.jobId)}`, { method: 'GET' })
        const pollData = poll.json.data as
          | { status: 'processing'; completedSections: number; totalSections: number }
          | ({ status: 'done'; rewritten: string; originalWordCount: number; rewrittenWordCount: number })
          | undefined

        if (!poll.json.success || !pollData) {
          throw new Error((poll.json.error as string) || 'Lost track of the rewrite job. Please try again.')
        }

        if (pollData.status === 'processing') {
          setRewriteProgress({ done: pollData.completedSections, total: pollData.totalSections })
          continue
        }

        if (pollData.status === 'done') {
          result = pollData
          break
        }
      }

      if (!result) {
        throw new Error('The rewrite is taking unusually long. Please try again.')
      }

      setOutput(result.rewritten)

      toast({
        title: 'Script rewritten',
        description: `Original ${result.originalWordCount} words → Rewritten ${result.rewrittenWordCount} words.`
      })

      // Scroll output into view on small screens
      if (window.innerWidth < 1024) {
        outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Something went wrong while rewriting the script.'
      setErrorMsg(message)
      toast({
        variant: 'destructive',
        title: 'Rewrite failed',
        description: message
      })
    } finally {
      setIsRewriting(false)
      setRewriteProgress(null)
    }
  }, [transcript, toast])

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

    try {
      const { ok, status, json } = await fetchJson('/api/voiceover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: selectedVoice, speed: selectedSpeed })
      })

      const data = json.data as {
        audioBase64: string
        mimeType: string
        durationSeconds: number
        sizeBytes: number
        chunkCount: number
        voice: string
        speed: number
      } | undefined

      if (!ok || !json.success || !data) {
        throw new Error((json.error as string) || `Request failed with status ${status}`)
      }

      // Decode base64 → Blob → object URL
      const binary = atob(data.audioBase64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: data.mimeType })
      const url = URL.createObjectURL(blob)

      // Revoke previous audio URL if any
      if (voiceoverUrlRef.current) URL.revokeObjectURL(voiceoverUrlRef.current)
      voiceoverUrlRef.current = url

      setVoiceover({
        url,
        audioBase64: data.audioBase64,
        mimeType: data.mimeType,
        durationSeconds: data.durationSeconds,
        sizeBytes: data.sizeBytes,
        voice: data.voice,
        speed: data.speed,
        generatedFromText: text
      })

      toast({
        title: 'Voiceover ready',
        description: `${data.durationSeconds}s of narration generated from ${data.chunkCount} segment${data.chunkCount > 1 ? 's' : ''}.`
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

  return (
    <div className="dark flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-600 shadow-lg shadow-red-600/30">
              <Youtube className="h-5 w-5 text-white" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-semibold leading-tight">AutoTube Studio</p>
              <p className="text-xs text-zinc-400">YouTube Video Automation</p>
            </div>
          </div>
          <Badge
            variant="outline"
            className="border-red-500/40 bg-red-500/10 px-2.5 py-1 text-red-400"
          >
            Phase 4 · Final Video
          </Badge>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {/* Intro */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8 text-center sm:mb-10"
        >
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Rewrite any transcript into an{' '}
            <span className="text-red-500">original script</span>
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400 sm:text-base">
            Paste a YouTube transcript below and let AI paraphrase it into a
            fresh, copyright-safe script, narrate it as a voiceover, generate
            one cinematic image per ~4 seconds through a 5-tier fallback chain,
            then assemble the final 1920×1080 H.264 video — voiceover synced,
            smooth crossfade transitions, ready to publish.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Badge variant="outline" className="gap-1.5 border-zinc-700 bg-zinc-900 text-zinc-300">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              Same meaning
            </Badge>
            <Badge variant="outline" className="gap-1.5 border-zinc-700 bg-zinc-900 text-zinc-300">
              <Repeat className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />
              Completely different wording
            </Badge>
            <Badge variant="outline" className="gap-1.5 border-zinc-700 bg-zinc-900 text-zinc-300">
              <Mic className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
              Voiceover-ready
            </Badge>
          </div>
        </motion.section>

        {/* Pipeline stepper */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          aria-label="Automation pipeline progress"
          className="mb-8 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-5 sm:px-6"
        >
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:justify-between sm:gap-0">
            {pipelineSteps.map((step, i) => (
              <Fragment key={step.id}>
                <div className="flex min-w-[84px] flex-col items-center gap-1.5">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
                      step.status === 'done'
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                        : step.status === 'active'
                          ? 'animate-pulse border-red-500 bg-red-600/20 text-red-400 ring-4 ring-red-600/20'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-600'
                    }`}
                    aria-hidden="true"
                  >
                    {stepIcon(step.status)}
                  </div>
                  <span
                    className={`text-center text-[11px] leading-tight ${
                      step.status === 'active'
                        ? 'font-medium text-red-400'
                        : step.status === 'done'
                          ? 'text-zinc-300'
                          : 'text-zinc-600'
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {i < pipelineSteps.length - 1 && (
                  <div
                    className={`mb-5 h-px min-w-4 flex-1 sm:min-w-6 ${
                      step.status === 'done' ? 'bg-emerald-500/40' : 'bg-zinc-800'
                    }`}
                    aria-hidden="true"
                  />
                )}
              </Fragment>
            ))}
          </div>
          <p className="mt-3 text-center text-xs text-zinc-500">
            Phase 4: paste a transcript, rewrite it, narrate the voiceover,
            generate AI images, then assemble the final video — YouTube link
            extraction and advanced effects arrive in later phases.
          </p>
        </motion.section>

        {/* Input / Output grid */}
        <section className="grid items-start gap-6 lg:grid-cols-2" aria-label="Script rewriter">
          {/* ── Input card ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            <Card className="border-zinc-800/80 bg-zinc-900/50">
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
                <CardDescription>
                  Paste the video transcript you want to rewrite.
                </CardDescription>
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
                    <span className="text-amber-500">
                      Minimum {MIN_CHARS} characters required
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* ── Output card ── */}
          <motion.div
            ref={outputRef}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            <Card
              className={`border bg-zinc-900/50 transition-colors ${
                isRewriting
                  ? 'border-red-500/40'
                  : output
                    ? 'border-emerald-500/30'
                    : 'border-zinc-800/80'
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
                <CardDescription>
                  AI-paraphrased, copyright-safe version of your transcript. You can
                  edit it before the voiceover step.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isRewriting ? (
                  <div className="space-y-4 py-2" aria-live="polite">
                    <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                      <Sparkles className="h-4 w-4 animate-pulse" aria-hidden="true" />
                      AI is rewriting your script…
                    </p>
                    {rewriteProgress && rewriteProgress.total > 1 ? (
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
                    <AlertDescription className="text-red-200/80">
                      {errorMsg}
                    </AlertDescription>
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
                      Paste a transcript on the left and hit “Rewrite Script”. The AI
                      will keep the meaning but change the wording completely.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </section>

        {/* ── Voiceover generation ── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          aria-label="Voiceover generation"
          className="mt-6"
        >
          <Card
            className={`border bg-zinc-900/50 transition-colors ${
              isGeneratingVoiceover
                ? 'border-red-500/40'
                : voiceover
                  ? 'border-emerald-500/30'
                  : 'border-zinc-800/80'
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
                Turn your rewritten script into narrated audio — the measured
                duration drives the image count below.
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
                    className="h-12 w-full rounded-xl bg-red-600 text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition-colors hover:bg-red-500 disabled:opacity-60"
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
                    Uses the current text in the rewritten script box. Longer
                    scripts can take 10–60 seconds.
                  </p>
                </div>

                {/* Result */}
                <div>
                  {isGeneratingVoiceover ? (
                    <div className="space-y-4 py-2" aria-live="polite">
                      <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                        <Headphones className="h-4 w-4 animate-pulse" aria-hidden="true" />
                        Converting your script to speech…
                      </p>
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
                        Narrating each segment, merging the audio and measuring the
                        total duration.
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
                          ? 'Pick a voice and speed, then hit “Generate Voiceover” to narrate your script.'
                          : 'Rewrite a script first — the voiceover narrates the rewritten script text.'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.section>

        {/* ── AI Images (Phase 3) ── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.35 }}
          aria-label="AI image generation"
          className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"
        >
          <ProviderChainCard />
          <AIImagesCard
            script={output}
            voiceoverDuration={voiceover?.durationSeconds ?? null}
            onStatusChange={setImagesStatus}
            onJobReady={(jid, total) => {
              setImageJobId(jid)
              setImageCount(total)
              // Reset the video phase when a fresh image set arrives
              setVideoStatus('idle')
            }}
          />
        </motion.section>

        {/* ── Final Video (Phase 4) ── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
          aria-label="Final video assembly"
          className="mt-6"
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
            onStatusChange={setVideoStatus}
          />
        </motion.section>

        {/* ── CTA ── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.25 }}
          className="mt-8 flex flex-col items-center gap-3"
        >
          <Button
            type="button"
            size="lg"
            onClick={handleRewrite}
            disabled={isRewriting}
            className="h-12 w-full max-w-md rounded-xl bg-red-600 px-8 text-base font-semibold text-white shadow-lg shadow-red-600/25 transition-colors hover:bg-red-500 disabled:opacity-60 sm:w-auto"
          >
            {isRewriting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                Rewriting{rewriteProgress ? ` (section ${Math.min(rewriteProgress.done + 1, rewriteProgress.total)}/${rewriteProgress.total})` : ' your script…'}
              </>
            ) : (
              <>
                <WandSparkles className="h-5 w-5" aria-hidden="true" />
                Rewrite Script
              </>
            )}
          </Button>
          <p className="text-xs text-zinc-600">
            Typically takes 10–30 seconds depending on transcript length.
          </p>
        </motion.section>
      </main>

      {/* ── Footer (sticky bottom) ── */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-zinc-500 sm:flex-row sm:px-6">
          <p className="flex items-center gap-1.5">
            <Youtube className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
            AutoTube Studio
          </p>
          <p className="text-center sm:text-right">
            Phase 4: Final Video — FFmpeg assembly of voiceover + AI images into
            1920×1080 H.264 MP4 with crossfade transitions. 5-tier image chain:
            Manus → Google → Z.ai → Cloudflare → Pollinations.
          </p>
        </div>
      </footer>
    </div>
  )
}

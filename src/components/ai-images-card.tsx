'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Image as ImageIcon,
  Loader2,
  AlertCircle,
  RefreshCw,
  Check,
  Clock,
  Layers,
  Zap
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

type JobStatus = 'idle' | 'submitting' | 'processing' | 'done' | 'error'
type ExposedStatus = 'idle' | 'generating' | 'done' | 'error'

interface WaitingSlot {
  index: number
  retryCount: number
  nextRetryAt?: number
  waitMs?: number
}

interface SlotInfo {
  index: number
  status: 'pending' | 'processing' | 'waiting' | 'done' | 'error'
  provider?: string | null
  retryCount: number
  error?: string | null
}

interface JobState {
  jobId: string
  status: 'processing' | 'done' | 'error'
  total: number
  completed: number
  waiting: number
  failed: number
  progress: number
  waitingSlots: WaitingSlot[]
  slots: SlotInfo[]
  prompts: string[]
  doneAt: number | null
  error?: string
}

interface PostResponse {
  jobId: string
  total: number
  prompts: string[]
}

// ─── Provider label / color (mirrors provider-chain-card) ─────────────────

const PROVIDER_BADGE: Record<string, string> = {
  custom: 'border-purple-500/40 bg-purple-500/15 text-purple-300',
  google: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  zai: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  cloudflare: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  pollinations: 'border-teal-500/40 bg-teal-500/15 text-teal-300'
}

const PROVIDER_LABEL: Record<string, string> = {
  custom: 'Manus',
  google: 'Google',
  zai: 'Z.ai',
  cloudflare: 'Cloudflare',
  pollinations: 'Pollinations'
}

// ─── fetchJson (same pattern as page.tsx) ───────────────────────────────────

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

// ─── Component ──────────────────────────────────────────────────────────────

interface AIImagesCardProps {
  script: string
  voiceoverDuration: number | null
  onStatusChange?: (status: ExposedStatus) => void
  /** Fired when the image job finishes successfully, exposing the image jobId + total count so downstream phases (video assembly) can consume them. */
  onJobReady?: (jobId: string, total: number) => void
}

export function AIImagesCard({
  script,
  voiceoverDuration,
  onStatusChange,
  onJobReady
}: AIImagesCardProps) {
  const { toast } = useToast()
  const [status, setStatus] = useState<JobStatus>('idle')
  const [job, setJob] = useState<JobState | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickRef = useRef<() => void>(() => {})

  const notifyStatus = useCallback(
    (s: ExposedStatus) => {
      onStatusChange?.(s)
    },
    [onStatusChange]
  )

  const notifyJobReady = useCallback(
    (jobId: string, total: number) => {
      onJobReady?.(jobId, total)
    },
    [onJobReady]
  )

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Tick `now` every second so the "waiting retry in Ns" countdown stays live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling()
      const tick = async () => {
        try {
          const { ok, status: httpStatus, json } = await fetchJson(
            `/api/images?jobId=${encodeURIComponent(jobId)}`,
            { method: 'GET' }
          )
          if (!ok) {
            throw new Error(
              (json.error as string) || `Poll failed (status ${httpStatus})`
            )
          }
          const data = json as unknown as JobState
          setJob(data)
          if (data.status === 'done') {
            stopPolling()
            setStatus('done')
            notifyStatus('done')
            notifyJobReady(data.jobId, data.total)
            toast({
              title: 'Images ready',
              description: `All ${data.total} images generated successfully.`
            })
          } else if (data.status === 'error') {
            stopPolling()
            setStatus('error')
            setErrorMsg(data.error || 'Image generation failed.')
            notifyStatus('error')
          }
        } catch (err) {
          stopPolling()
          const message =
            err instanceof Error ? err.message : 'Lost track of the image job.'
          setStatus('error')
          setErrorMsg(message)
          notifyStatus('error')
        }
      }
      tickRef.current = tick
      // Immediate first poll, then every 1.5s.
      tick()
      pollRef.current = setInterval(tick, 1500)
    },
    [notifyStatus, notifyJobReady, stopPolling, toast]
  )

  const handleGenerate = useCallback(async () => {
    const text = script.trim()
    if (!text) {
      toast({
        variant: 'destructive',
        title: 'No script to illustrate',
        description:
          'Rewrite a transcript first — image prompts are derived from the script.'
      })
      return
    }
    if (!voiceoverDuration || voiceoverDuration < 4) {
      toast({
        variant: 'destructive',
        title: 'No voiceover yet',
        description:
          'Generate the voiceover first — its measured duration drives the image count.'
      })
      return
    }

    setStatus('submitting')
    setErrorMsg(null)
    setJob(null)
    notifyStatus('generating')

    try {
      const { ok, status: httpStatus, json } = await fetchJson('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, durationSeconds: voiceoverDuration })
      })
      const startData = json as Partial<PostResponse> & { error?: string }
      if (!ok || !startData.jobId) {
        throw new Error(startData.error || `Request failed with status ${httpStatus}`)
      }

      // Seed the local job state from POST response so the UI shows a grid
      // immediately, before the first poll arrives.
      const prompts = startData.prompts ?? []
      setJob({
        jobId: startData.jobId,
        status: 'processing',
        total: startData.total ?? prompts.length,
        completed: 0,
        waiting: 0,
        failed: 0,
        progress: 0,
        waitingSlots: [],
        slots: prompts.map((_, i) => ({
          index: i,
          status: 'pending' as const,
          retryCount: 0
        })),
        prompts,
        doneAt: null
      })
      setStatus('processing')
      startPolling(startData.jobId)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Image generation failed to start.'
      setStatus('error')
      setErrorMsg(message)
      notifyStatus('error')
      toast({
        variant: 'destructive',
        title: 'Could not start image generation',
        description: message
      })
    }
  }, [script, voiceoverDuration, notifyStatus, startPolling, toast])

  const canGenerate =
    !!script.trim() &&
    !!voiceoverDuration &&
    voiceoverDuration >= 4 &&
    status !== 'submitting' &&
    status !== 'processing'

  const isBusy = status === 'submitting' || status === 'processing'

  // Compute remaining wait per waiting slot (in whole seconds, floored).
  const waitingSlotsWithWait = (job?.waitingSlots ?? []).map((w) => {
    const remaining = w.nextRetryAt
      ? Math.max(0, Math.ceil((w.nextRetryAt - now) / 1000))
      : Math.max(0, Math.ceil((w.waitMs ?? 0) / 1000))
    return { ...w, remainingSeconds: remaining }
  })

  const imageCount = voiceoverDuration
    ? Math.max(1, Math.ceil(voiceoverDuration / 4))
    : 0

  return (
    <Card
      className={`border bg-zinc-900/50 transition-colors ${
        isBusy
          ? 'border-red-500/40'
          : status === 'done'
            ? 'border-emerald-500/30'
            : status === 'error'
              ? 'border-red-500/40'
              : 'border-zinc-800/80'
      }`}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon
              className={`h-4 w-4 ${
                isBusy ? 'animate-pulse text-red-400' : 'text-zinc-400'
              }`}
              aria-hidden="true"
            />
            AI Images Generation
          </CardTitle>
          {status === 'done' && job ? (
            <Badge
              variant="outline"
              className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-400"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {job.total} images ready
            </Badge>
          ) : isBusy ? (
            <Badge
              variant="outline"
              className="gap-1.5 border-red-500/40 bg-red-500/10 px-2.5 py-1 text-red-400"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Generating
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          One cinematic image per ~4 seconds of narration. The 5-tier chain
          tries Manus → Google → Z.ai → Cloudflare → Pollinations, retrying
          throttled providers with backoff until every slot succeeds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Action row */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs text-zinc-400">
                {voiceoverDuration ? (
                  <>
                    Will generate{' '}
                    <span className="font-semibold text-red-400">{imageCount}</span>{' '}
                    images (1 per 4s of narration)
                  </>
                ) : (
                  <span className="text-zinc-500">
                    Voiceover duration needed to size the image set.
                  </span>
                )}
              </p>
              <p className="text-xs text-zinc-600">
                Prompts are auto-generated from the rewritten script, then drawn
                through the fallback chain.
              </p>
            </div>
            <Button
              type="button"
              size="lg"
              onClick={handleGenerate}
              disabled={!canGenerate && status !== 'done'}
              className="h-12 rounded-xl bg-red-600 px-6 text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition-colors hover:bg-red-500 disabled:opacity-60"
            >
              {status === 'submitting' ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                  Starting…
                </>
              ) : status === 'processing' ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                  Generating…
                </>
              ) : status === 'done' ? (
                <>
                  <RefreshCw className="h-5 w-5" aria-hidden="true" />
                  Regenerate
                </>
              ) : (
                <>
                  <ImageIcon className="h-5 w-5" aria-hidden="true" />
                  Generate Images
                </>
              )}
            </Button>
          </div>

          {/* Body states */}
          {status === 'submitting' ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="space-y-3 py-2"
              aria-live="polite"
            >
              <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                <Zap className="h-4 w-4 animate-pulse" aria-hidden="true" />
                Crafting image prompts from your script…
              </p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-video animate-pulse rounded-md bg-zinc-800"
                    style={{ animationDelay: `${i * 80}ms` }}
                  />
                ))}
              </div>
              <p className="text-xs text-zinc-500">
                Splitting the narration into one scene per ~4s, then drawing each
                frame through the provider chain.
              </p>
            </motion.div>
          ) : status === 'error' ? (
            <Alert variant="destructive" className="border-red-500/40 bg-red-500/10">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Image generation failed</AlertTitle>
              <AlertDescription className="text-red-200/80">
                {errorMsg}
                <div className="mt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleGenerate}
                    className="h-9 border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Retry
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : job && (status === 'processing' || status === 'done') ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
              aria-live="polite"
            >
              {/* Progress bar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>
                    {job.completed} / {job.total} generated
                    {job.failed > 0 && (
                      <span className="ml-2 text-red-400">
                        · {job.failed} failed
                      </span>
                    )}
                  </span>
                  <span className="font-mono tabular-nums">{job.progress}%</span>
                </div>
                <Progress
                  value={job.progress}
                  aria-label="Image generation progress"
                  className="h-2 bg-zinc-800 [&>div]:bg-red-600"
                />
                {job.waiting > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-400">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {job.waiting} image{job.waiting > 1 ? 's' : ''} waiting for
                    provider capacity
                  </div>
                )}
              </div>

              {/* Waiting slots detail */}
              {waitingSlotsWithWait.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  {waitingSlotsWithWait.slice(0, 3).map((w) => (
                    <p
                      key={w.index}
                      className="flex items-center gap-1.5 text-xs leading-relaxed text-amber-300"
                    >
                      <Clock
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        Image #{w.index + 1}: waiting for provider capacity
                        {w.retryCount > 0 && (
                          <>
                            {' '}
                            (retry {w.retryCount} in {w.remainingSeconds}s)
                          </>
                        )}
                      </span>
                    </p>
                  ))}
                  {waitingSlotsWithWait.length > 3 && (
                    <p className="text-[11px] text-amber-500/70">
                      + {waitingSlotsWithWait.length - 3} more waiting…
                    </p>
                  )}
                </div>
              )}

              {/* Done banner */}
              {status === 'done' && (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                  All {job.total} images generated. Ready for video assembly.
                </div>
              )}

              {/* Thumbnails grid (scrollable) */}
              <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {job.slots.map((slot) => (
                    <ThumbCell
                      key={slot.index}
                      slot={slot}
                      jobId={job.jobId}
                      prompt={job.prompts[slot.index]}
                    />
                  ))}
                </div>
              </div>
            </motion.div>
          ) : (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
                <Layers className="h-5 w-5 text-zinc-500" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-zinc-300">
                Your AI images will appear here
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-zinc-500">
                {voiceoverDuration
                  ? 'Hit “Generate Images” to derive prompts from the script and render one cinematic frame per ~4 seconds.'
                  : 'Generate a voiceover first — its measured duration drives the number of images.'}
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Thumbnail cell ─────────────────────────────────────────────────────────

interface ThumbCellProps {
  slot: SlotInfo
  jobId: string
  prompt?: string
}

function ThumbCell({ slot, jobId, prompt }: ThumbCellProps) {
  if (slot.status === 'done') {
    const badgeClass = slot.provider
      ? PROVIDER_BADGE[slot.provider] ?? ''
      : ''
    const providerLabel = slot.provider
      ? PROVIDER_LABEL[slot.provider] ?? slot.provider
      : ''
    return (
      <div className="group relative aspect-video overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
        <img
          src={`/api/image?jobId=${encodeURIComponent(jobId)}&index=${slot.index}`}
          alt={
            prompt
              ? `Generated frame ${slot.index + 1}: ${prompt.slice(0, 80)}`
              : `Generated frame ${slot.index + 1}`
          }
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <div className="pointer-events-none absolute bottom-1 left-1 right-1 flex items-center justify-between gap-1">
          <span className="rounded bg-black/60 px-1 py-0.5 text-[10px] font-mono text-zinc-200 backdrop-blur-sm">
            #{slot.index + 1}
          </span>
          {providerLabel && (
            <span
              className={`rounded border px-1 py-0.5 text-[10px] backdrop-blur-sm ${badgeClass}`}
            >
              {providerLabel}
            </span>
          )}
        </div>
      </div>
    )
  }

  if (slot.status === 'waiting') {
    return (
      <div className="relative aspect-video animate-pulse overflow-hidden rounded-md border border-amber-500/40 bg-amber-500/10">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-amber-400">
          <Clock className="h-4 w-4" aria-hidden="true" />
          <span className="text-[10px] font-medium">waiting</span>
        </div>
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-mono text-zinc-200">
          #{slot.index + 1}
        </span>
      </div>
    )
  }

  if (slot.status === 'error') {
    return (
      <div className="relative aspect-video overflow-hidden rounded-md border border-red-500/40 bg-red-500/10">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-red-400">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span className="text-[10px] font-medium">failed</span>
        </div>
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-mono text-zinc-200">
          #{slot.index + 1}
        </span>
      </div>
    )
  }

  // pending or processing → shimmer
  return (
    <div className="relative aspect-video animate-pulse overflow-hidden rounded-md border border-zinc-800 bg-zinc-800">
      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-mono text-zinc-400">
        #{slot.index + 1}
      </span>
    </div>
  )
}

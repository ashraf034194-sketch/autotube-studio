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
  Zap,
  Boxes,
  Wind
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

type JobStatus = 'idle' | 'submitting' | 'prompting' | 'processing' | 'done' | 'error'
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

/** One junction in the gated batch flow. Mirrors the server-side BatchState. */
interface BatchStateInfo {
  index: number
  total: number
  completed: number
  failed: number
  status: 'pending' | 'active' | 'done'
}

interface JobState {
  jobId: string
  status: 'prompting' | 'processing' | 'done' | 'error'
  total: number
  completed: number
  waiting: number
  failed: number
  progress: number
  waitingSlots: WaitingSlot[]
  slots: SlotInfo[]
  prompts: string[]
  currentLabel?: string | null
  doneAt: number | null
  error?: string
  // ── Junction (gated batch) flow ──────────────────────────────────────
  batchGateSize?: number | null
  batchesTotal?: number | null
  currentBatch?: number | null
  batchCompleted?: number | null
  batchFailed?: number | null
  batchInterlude?: boolean
  batchStates?: BatchStateInfo[] | null
}

interface PostResponse {
  jobId: string
  total: number
  prompts: string[]
}

// ─── Provider label / color (mirrors provider-chain-card) ─────────────────

const PROVIDER_BADGE: Record<string, string> = {
  // SIMPLIFIED 3-tier chain — only Pexels, Unsplash, Z.ai.
  //   Pexels + Unsplash = stock photo libraries (Tier 0)
  //   Z.ai = AI-generation fallback (Tier 1)
  // (Removed: stability, grok, nanoBanana2, custom, google, cloudflare,
  // pollinations — all were permanently "skip" because their keys were
  // never configured.)
  pexels: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
  unsplash: 'border-slate-400/40 bg-slate-400/15 text-slate-200',
  zai: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
}

const PROVIDER_LABEL: Record<string, string> = {
  // SIMPLIFIED 3-tier chain — only Pexels, Unsplash, Z.ai.
  pexels: 'Pexels',
  unsplash: 'Unsplash',
  zai: 'Z.ai'
}

/**
 * Returns "Stock" or "AI" category label for a provider — used to group the
 * thumbnails visually (stock photos vs AI-generated) in the done-summary.
 */
function providerCategory(provider?: string | null): 'stock' | 'ai' | null {
  if (!provider) return null
  if (provider === 'pexels' || provider === 'unsplash') return 'stock'
  return 'ai'
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

interface VoiceoverChunkForImages {
  text: string
  startMs: number
  endMs: number
}

interface AIImagesCardProps {
  script: string
  voiceoverDuration: number | null
  /** Per-segment script chunks from the voiceover — preferred path. When
   *  present, image N visualizes the EXACT text chunk N (true script-image
   *  match). Falls back to {text, durationSeconds} when absent. */
  voiceoverChunks: VoiceoverChunkForImages[] | null
  onStatusChange?: (status: ExposedStatus) => void
  /** Fired when the image job finishes successfully, exposing the image jobId + total count so downstream phases (video assembly) can consume them. */
  onJobReady?: (jobId: string, total: number) => void
}

export function AIImagesCard({
  script,
  voiceoverDuration,
  voiceoverChunks,
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
          // Transition local FSM based on the server-side phase.
          // - 'prompting' = LLM still writing the per-segment image prompts
          //   (this is the phase that previously blocked POST and caused 502)
          // - 'processing' = prompts ready, image-gen workers running
          // - 'done' / 'error' = terminal
          if (data.status === 'prompting') {
            setStatus('prompting')
            notifyStatus('generating')
          } else if (data.status === 'processing') {
            setStatus('processing')
            notifyStatus('generating')
          } else if (data.status === 'done') {
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
      // PREFERRED path: send voiceover chunks so image N visualizes the EXACT
      // text chunk N (true script-image match). Fall back to {text, durationSeconds}
      // only when chunks aren't available (older voiceover or none).
      const postBody = voiceoverChunks && voiceoverChunks.length > 0
        ? { chunks: voiceoverChunks }
        : { text, durationSeconds: voiceoverDuration }
      const { ok, status: httpStatus, json } = await fetchJson('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody)
      })
      const startData = json as Partial<PostResponse> & { error?: string }
      if (!ok || !startData.jobId) {
        throw new Error(startData.error || `Request failed with status ${httpStatus}`)
      }

      // POST returns immediately with the target count (no prompts yet — they
      // are generated in the background by the LLM). Seed the local job state
      // so the UI can show the "prompting" skeleton right away.
      const targetTotal = startData.total ?? 0
      setJob({
        jobId: startData.jobId,
        status: 'prompting',
        total: targetTotal,
        completed: 0,
        waiting: 0,
        failed: 0,
        progress: 0,
        waitingSlots: [],
        slots: [],
        prompts: [],
        currentLabel: `Crafting ${targetTotal} image prompts from the script`,
        doneAt: null
      })
      setStatus('prompting')
      notifyStatus('generating')
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
  }, [script, voiceoverDuration, voiceoverChunks, notifyStatus, startPolling, toast])

  const canGenerate =
    !!script.trim() &&
    !!voiceoverDuration &&
    voiceoverDuration >= 4 &&
    status !== 'submitting' &&
    status !== 'prompting' &&
    status !== 'processing'

  const isBusy =
    status === 'submitting' || status === 'prompting' || status === 'processing'

  // Compute remaining wait per waiting slot (in whole seconds, floored).
  const waitingSlotsWithWait = (job?.waitingSlots ?? []).map((w) => {
    const remaining = w.nextRetryAt
      ? Math.max(0, Math.ceil((w.nextRetryAt - now) / 1000))
      : Math.max(0, Math.ceil((w.waitMs ?? 0) / 1000))
    return { ...w, remainingSeconds: remaining }
  })

  // EXACT count when voiceover chunks are available (the API will generate
  // exactly 1 image per chunk). Falls back to the 4s-per-image estimate only
  // before the voiceover exists (so the user gets a sensible preview number).
  // Previously this used ONLY the estimate, which disagreed with the actual
  // chunk count produced by the 80-char chunker — UI said "21" but API
  // generated 13. Now the UI shows the EXACT count once voiceover is done.
  const imageCount =
    voiceoverChunks && voiceoverChunks.length > 0
      ? voiceoverChunks.length
      : voiceoverDuration
        ? Math.max(1, Math.ceil(voiceoverDuration / 4))
        : 0

  return (
    <Card
      className={`border bg-zinc-900/40 backdrop-blur-sm transition-colors ${
        isBusy
          ? 'border-red-500/40'
          : status === 'done'
            ? 'border-emerald-500/30'
            : status === 'error'
              ? 'border-red-500/40'
              : 'border-zinc-800/60'
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
          Hybrid engine: concrete scenes try legal stock photos (Pexels → Unsplash) first, abstract concepts use AI generation. 20 images per junction.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Info chips — horizontal, professional */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {voiceoverDuration ? (
              <>
                <span className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-semibold text-red-400">
                  {imageCount} images
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-400">
                  {Math.max(1, Math.ceil(imageCount / 20))} junctions of 20
                </span>
                <span className="text-zinc-500">Prompts auto-generated from the script.</span>
              </>
            ) : (
              <span className="text-zinc-500">Voiceover duration needed to size the image set.</span>
            )}
          </div>
          {/* Generate Images — full-width bottom bar */}
          <Button
            type="button"
            size="lg"
            onClick={handleGenerate}
            disabled={!canGenerate && status !== 'done'}
            className="h-12 w-full rounded-xl bg-gradient-to-r from-red-600 to-orange-500 px-6 text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-orange-400 disabled:opacity-60"
          >
            {status === 'submitting' ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                Starting…
              </>
            ) : status === 'prompting' ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                Crafting prompts…
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
                Submitting image job…
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
            </motion.div>
          ) : status === 'prompting' ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="space-y-3 py-2"
              aria-live="polite"
            >
              <p className="flex items-center gap-2 text-sm font-medium text-red-400">
                <Zap className="h-4 w-4 animate-pulse" aria-hidden="true" />
                {job?.currentLabel ?? 'Crafting image prompts from your script…'}
              </p>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>
                    Target: <span className="font-semibold text-zinc-300">{job?.total ?? 0}</span> images
                  </span>
                  <span className="font-mono tabular-nums text-amber-400">LLM working…</span>
                </div>
                <Progress
                  value={0}
                  aria-label="Prompt generation progress"
                  className="h-2 bg-zinc-800 [&>div]:bg-amber-500"
                />
              </div>
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
                Splitting the narration into one scene per ~4s. Long voiceovers take a few minutes — runs in the background.
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
              {/* Junction flow — 20-at-a-time gated batch visualization */}
              <JunctionFlow job={job} />

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

              {/* Done banner — with Stock vs AI breakdown */}
              {status === 'done' && (() => {
                const stockCount = job.slots.filter(
                  (s) => s.provider === 'pexels' || s.provider === 'unsplash'
                ).length
                const aiCount = job.total - stockCount
                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
                      <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                      All {job.total} images generated. Ready for video assembly.
                    </div>
                    {/* Source breakdown chips */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {stockCount > 0 && (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-semibold text-sky-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
                          {stockCount} Stock {stockCount === 1 ? 'photo' : 'photos'}
                          <span className="text-sky-500/70">·</span>
                          <span className="font-normal text-sky-400/80">Pexels + Unsplash</span>
                        </span>
                      )}
                      {aiCount > 0 && (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
                          {aiCount} AI-generated
                          <span className="text-amber-500/70">·</span>
                          <span className="font-normal text-amber-400/80">concrete→stock-miss OR abstract</span>
                        </span>
                      )}
                    </div>
                  </div>
                )
              })()}

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
                  ? 'Hit “Generate Images” to render one cinematic frame per chunk.'
                  : 'Generate a voiceover first — its duration drives the image count.'}
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

// ─── Junction flow visualization (20-at-a-time gated batch) ──────────────────
//
// Renders the user-requested "junction" concept: the whole image set is split
// into batches of 20. One junction is active at a time; when it fully settles
// (20 images done/failed), the tool breathes ~1.5s, then the next junction
// starts. This panel makes that flow visible:
//   • a row of junction pills (done=green check, active=pulsing, pending=gray)
//   • a thin progress bar for the CURRENT junction only (out of 20)
//   • a "breathing…" indicator during the inter-junction pause
//   • the junction math (e.g. "100 images ÷ 20 = 5 junctions")
//
// Renders nothing when the job is single-junction (≤20 images) or when batch
// fields aren't yet populated (early processing tick).

interface JunctionFlowProps {
  job: JobState
}

function JunctionFlow({ job }: JunctionFlowProps) {
  const batchesTotal = job.batchesTotal ?? null
  const batchStates = job.batchStates ?? null
  const currentBatch = job.currentBatch ?? 0
  const batchCompleted = job.batchCompleted ?? 0
  const batchFailed = job.batchFailed ?? 0
  const gateSize = job.batchGateSize ?? 20
  const interlude = job.batchInterlude ?? false

  // Hide when there's only one junction (no flow to visualize) or before the
  // server has populated the batch fields.
  if (!batchesTotal || batchesTotal <= 1 || !batchStates || batchStates.length === 0) {
    return null
  }

  // Current junction progress = completed within this junction / junction size.
  // Use the batchStates entry for the active junction when available so the bar
  // reflects settled images even after the cursor advanced.
  const activeBatchState = batchStates[currentBatch - 1] ?? null
  const activeBatchTotal = activeBatchState?.total ?? gateSize
  const activeBatchDone = activeBatchState?.completed ?? batchCompleted
  const activeBatchFailed = activeBatchState?.failed ?? batchFailed
  const activeBatchProgress = activeBatchTotal > 0
    ? Math.round(((activeBatchDone + activeBatchFailed) / activeBatchTotal) * 100)
    : 0

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      {/* Header row: icon + "Junction X/Y" + breathing indicator */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
          <Boxes className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Junction{' '}
            <span className="font-mono tabular-nums text-amber-200">
              {currentBatch > 0 ? currentBatch : '—'}/{batchesTotal}
            </span>
          </span>
          <span className="text-xs font-normal text-amber-500/70">
            · 20 images at a time
          </span>
        </div>
        {interlude ? (
          <span className="flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-300">
            <Wind className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
            breathing…
          </span>
        ) : currentBatch > 0 && currentBatch < batchesTotal ? (
          <span className="text-xs text-amber-500/70">
            {batchesTotal - currentBatch} junction{batchesTotal - currentBatch > 1 ? 's' : ''} left
          </span>
        ) : currentBatch >= batchesTotal ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            final junction
          </span>
        ) : null}
      </div>

      {/* Junction math line */}
      <p className="text-xs leading-relaxed text-amber-200/70">
        <span className="font-mono tabular-nums text-amber-200">{job.total}</span> images ÷{' '}
        <span className="font-mono tabular-nums text-amber-200">{gateSize}</span> ={' '}
        <span className="font-mono tabular-nums text-amber-200">{batchesTotal}</span> junctions · tool breathes ~1.5s between each.
      </p>

      {/* Junction pills row — one pill per junction, scrollable on mobile */}
      <div className="flex flex-wrap gap-1.5">
        {batchStates.map((bs) => {
          const isActive = bs.status === 'active'
          const isDone = bs.status === 'done'
          const isPending = bs.status === 'pending'
          const pillProgress = bs.total > 0 ? Math.round(((bs.completed + bs.failed) / bs.total) * 100) : 0
          return (
            <span
              key={bs.index}
              title={`Junction ${bs.index + 1}: ${bs.completed}/${bs.total} done${bs.failed > 0 ? `, ${bs.failed} failed` : ''}`}
              className={[
                'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                isDone
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : isActive
                    ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                    : 'border-zinc-700 bg-zinc-800/50 text-zinc-500'
              ].join(' ')}
            >
              {isDone ? (
                <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
              ) : isActive ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50" aria-hidden="true" />
              )}
              <span className="font-mono tabular-nums">
                J{bs.index + 1}
              </span>
              {isPending ? null : (
                <span className="font-mono tabular-nums opacity-70">
                  {bs.completed}/{bs.total}
                </span>
              )}
              {isActive && pillProgress > 0 && (
                <span className="font-mono tabular-nums opacity-60">{pillProgress}%</span>
              )}
            </span>
          )
        })}
      </div>

      {/* Current-junction thin progress bar */}
      {currentBatch > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-amber-300/80">
            <span>
              Current junction —{' '}
              <span className="font-mono tabular-nums">
                {activeBatchDone}/{activeBatchTotal}
              </span>{' '}
              images{activeBatchFailed > 0 ? ` · ${activeBatchFailed} failed` : ''}
            </span>
            <span className="font-mono tabular-nums">{activeBatchProgress}%</span>
          </div>
          <Progress
            value={activeBatchProgress}
            aria-label={`Junction ${currentBatch} of ${batchesTotal} progress`}
            className="h-1.5 bg-amber-950/50 [&>div]:bg-amber-400"
          />
        </div>
      )}
    </div>
  )
}

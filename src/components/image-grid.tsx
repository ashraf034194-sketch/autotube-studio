'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImageProvider =
  | 'google'
  | 'zai'
  | 'custom'
  | 'cloudflare'
  | 'pollinations'
  | 'nanoBanana2'
  | 'grok'
  | 'stability'

export interface ImageEntry {
  index: number
  prompt: string
  /** '/api/image?jobId=...&index=...&size=...' when ready; empty string when pending or failed. */
  url: string
  segmentText: string
  status: 'pending' | 'ready' | 'failed'
  error?: string
  /** Which provider generated this image (set when status==='ready' or 'failed'). */
  provider?: ImageProvider
  /** Full fallback trail if generation succeeded only on a later tier. */
  providerTrail?: { provider: ImageProvider; ok: boolean; error?: string }[]
}

interface ImageGridProps {
  images: ImageEntry[]
  /** Job ID — needed to call the per-image retry endpoint. */
  jobId: string
  /** Called whenever the loaded-image count changes (for parent UI). */
  onLoadedCountChange?: (loaded: number, failed: number, total: number) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How many image CELLS to render in the DOM initially. The rest are
 * progressively rendered as the user scrolls (IntersectionObserver appends
 * another BATCH on intersection with the sentinel). Kept small so the DOM
 * stays light for 100+ image grids.
 */
const RENDER_BATCH = 12

/**
 * How long to poll the GET endpoint when a single-image retry is in flight.
 * One image takes ~30-40s, so 5 minutes is plenty (covers multiple internal
 * retries on the backend too).
 */
const RETRY_DEADLINE_MS = 5 * 60 * 1000
/** Poll interval while waiting for a retry to finish. */
const RETRY_POLL_INTERVAL_MS = 2500

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch wrapper that never chokes on non-JSON (e.g. HTML error pages). */
async function fetchJsonSafe(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { ok: false, status: 0, json: { success: false, error: 'Could not reach the server.' } }
  }
  const raw = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, status: res.status, json: { success: false, error: `Server returned non-JSON (status ${res.status}).` } }
  }
  return { ok: res.ok, status: res.status, json }
}

// ─── Provider badge config ────────────────────────────────────────────────────

const PROVIDER_META: Record<ImageProvider, { label: string; short: string; badgeClass: string }> = {
  stability: {
    label: 'Stability AI (Stable Image Ultra)',
    short: 'STA',
    badgeClass: 'bg-amber-600/90 text-white'
  },
  nanoBanana2: {
    label: 'Nano Banana 2 (FLUX @ 2K + Style DNA)',
    short: 'NB2',
    badgeClass: 'bg-purple-600/90 text-white'
  },
  grok: {
    label: 'Grok (X.AI image generation)',
    short: 'GRK',
    badgeClass: 'bg-violet-600/90 text-white'
  },
  cloudflare: {
    label: 'Cloudflare Workers AI (FLUX.1-schnell)',
    short: 'CF',
    badgeClass: 'bg-violet-600/85 text-white'
  },
  google: {
    label: 'Google AI Studio (Nano Banana)',
    short: 'G',
    badgeClass: 'bg-emerald-600/85 text-white'
  },
  zai: {
    label: 'Z.ai (bundled SDK)',
    short: 'Z',
    badgeClass: 'bg-emerald-600/85 text-white'
  },
  pollinations: {
    label: 'Pollinations.ai (last resort)',
    short: 'P',
    badgeClass: 'bg-orange-600/85 text-white'
  },
  custom: {
    label: 'Manus (Custom Tool)',
    short: 'M',
    badgeClass: 'bg-rose-600/85 text-white'
  }
}

// Fallback for any future provider not yet in the map — prevents the badge
// renderer from crashing when the backend returns an unknown provider name.
function safeProviderMeta(name: ImageProvider | undefined) {
  if (!name) return null
  return PROVIDER_META[name] ?? {
    label: name,
    short: name.slice(0, 2).toUpperCase(),
    badgeClass: 'bg-zinc-600/85 text-white'
  }
}

// ─── Single image cell ────────────────────────────────────────────────────────

interface ImageCellProps {
  image: ImageEntry
  jobId: string
}

function ImageCell({ image, jobId }: ImageCellProps) {
  // retryNonce is appended to the URL for cache-busting. The /api/image
  // endpoint serves files with 'Cache-Control: immutable', so when a retry
  // overwrites the file at the same path, we MUST change the URL (with a
  // cache-buster) or the browser will serve the stale (404 / failed) response.
  const [retryNonce, setRetryNonce] = useState(1)
  // localStatus tracks the cell's effective state. Initialized from the
  // backend-provided image.status. After a retry POST, we set it to 'retrying'
  // (a local-only state) while we poll for the backend to flip status to
  // 'ready' or 'failed'.
  const [localStatus, setLocalStatus] = useState<'pending' | 'ready' | 'failed' | 'retrying'>(
    image.status
  )
  const [localUrl, setLocalUrl] = useState<string>(image.url)
  const [localError, setLocalError] = useState<string | undefined>(image.error)

  // If the parent re-pulls the images array (e.g. after a full re-fetch),
  // the cell is force-remounted via a `key` prop in the map below — so we
  // only ever initialize from props once on mount, never sync via effect
  // (which would trip the react-hooks/set-state-in-effect lint rule).

  // Click handler for the Retry button. Calls the backend retry endpoint
  // (POST /api/images?retry=true&jobId=...&index=...) which fires-and-forgets
  // the actual regeneration. We then poll the GET endpoint until we see the
  // image's status flip to 'ready' or 'failed'.
  const handleRetryClick = useCallback(async () => {
    setLocalStatus('retrying')
    setLocalError(undefined)

    // Fire the retry request.
    const postRes = await fetchJsonSafe(
      `/api/images?retry=true&jobId=${encodeURIComponent(jobId)}&index=${image.index}`,
      { method: 'POST' }
    )
    if (!postRes.ok || !postRes.json.success) {
      setLocalStatus('failed')
      setLocalError((postRes.json.error as string) || 'Retry request failed.')
      return
    }

    // Poll the GET endpoint to see when this image's status flips.
    const deadline = Date.now() + RETRY_DEADLINE_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RETRY_POLL_INTERVAL_MS))

      const pollRes = await fetchJsonSafe(
        `/api/images?jobId=${encodeURIComponent(jobId)}`,
        { method: 'GET' }
      )
      if (!pollRes.ok || !pollRes.json.success) {
        // Transient poll error — keep polling, don't give up yet.
        continue
      }
      const data = pollRes.json.data as
        | { status: 'processing'; phase: string }
        | { status: 'done'; images: ImageEntry[] }
        | undefined
      if (!data || data.status !== 'done' || !data.images) {
        continue
      }

      const updated = data.images.find((i) => i.index === image.index)
      if (!updated) continue

      if (updated.status === 'ready') {
        setLocalStatus('ready')
        setLocalUrl(updated.url)
        setLocalError(undefined)
        setRetryNonce((n) => n + 1) // cache-bust
        return
      }
      if (updated.status === 'failed') {
        setLocalStatus('failed')
        setLocalError(updated.error || 'Image generation failed.')
        return
      }
      // 'pending' status — still retrying, keep polling.
    }

    // Timed out waiting.
    setLocalStatus('failed')
    setLocalError('Retry timed out. Please try again.')
  }, [jobId, image.index])

  // Build the URL with cache-buster. If we're in 'ready' state, use the URL
  // the backend gave us (with cache-buster appended). Otherwise no <img> tag
  // fires a request.
  const urlWithCacheBust = localUrl
    ? `${localUrl}${localUrl.includes('?') ? '&' : '?'}_r=${retryNonce}`
    : ''

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-900">
        {localStatus === 'ready' ? (
          <>
            <img
              key={retryNonce}
              src={urlWithCacheBust}
              alt={`Scene ${image.index + 1}: ${image.prompt.slice(0, 100)}`}
              className="h-full w-full object-cover"
            />
            <div className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-md bg-black/70 px-1.5 text-[11px] font-mono text-zinc-200 backdrop-blur">
              {String(image.index + 1).padStart(2, '0')}
            </div>
            {image.provider && (() => {
              const meta = safeProviderMeta(image.provider)
              if (!meta) return null
              return (
                <div
                  className={`absolute right-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-[11px] font-mono font-semibold backdrop-blur ${meta.badgeClass}`}
                  title={`Generated via ${meta.label}`}
                >
                  {meta.short}
                </div>
              )
            })()}
          </>
        ) : localStatus === 'failed' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center">
            <AlertCircle className="h-7 w-7 text-red-400" aria-hidden="true" />
            <p className="text-[11px] leading-tight text-zinc-500">
              {localError ? `Failed: ${localError.slice(0, 80)}` : 'Failed to generate image'}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRetryClick}
              className="h-8 gap-1.5 border-zinc-700 bg-transparent text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry image
            </Button>
          </div>
        ) : (
          // 'pending' or 'retrying' — spinner only, no <img> tag.
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2
              className={`h-6 w-6 animate-spin ${localStatus === 'retrying' ? 'text-amber-400' : 'text-zinc-500'}`}
              aria-hidden="true"
            />
            <div className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-md bg-black/70 px-1.5 text-[11px] font-mono text-zinc-200 backdrop-blur">
              {String(image.index + 1).padStart(2, '0')}
            </div>
            {localStatus === 'retrying' && (
              <span className="absolute bottom-1.5 left-1.5 rounded bg-amber-950/80 px-1.5 py-0.5 text-[10px] text-amber-300 backdrop-blur">
                Retrying…
              </span>
            )}
          </div>
        )}
      </div>

      {/* Caption: the script segment this image illustrates */}
      <div className="px-2.5 py-2">
        <p className="line-clamp-3 text-[11px] leading-relaxed text-zinc-400">
          {image.segmentText || '—'}
        </p>
        {image.providerTrail && image.providerTrail.length > 1 && (
          <p className="mt-1 text-[10px] text-zinc-600" title="Fallback trail">
            trail: {image.providerTrail.map((t) => t.provider + (t.ok ? '✓' : '✗')).join(' → ')}
          </p>
        )}
      </div>
    </motion.div>
  )
}

// ─── Grid (with progressive rendering) ────────────────────────────────────────

export function ImageGrid({ images, jobId, onLoadedCountChange }: ImageGridProps) {
  const [visibleCount, setVisibleCount] = useState(Math.min(RENDER_BATCH, images.length))
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Compute loaded/failed counts from the (read-only) images array.
  // This avoids per-cell state lifted into the grid — the parent already has
  // the source of truth via its polling of /api/images.
  const loadedCount = images.filter((i) => i.status === 'ready').length
  const failedCount = images.filter((i) => i.status === 'failed').length

  // Progressively render more image CELLS as the sentinel comes into view.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisibleCount((prev) => Math.min(prev + RENDER_BATCH, images.length))
          }
        }
      },
      { rootMargin: '300px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [images.length])

  // Notify parent of loaded/failed counts (for parent UI).
  useEffect(() => {
    onLoadedCountChange?.(loadedCount, failedCount, images.length)
  }, [loadedCount, failedCount, images.length, onLoadedCountChange])

  if (images.length === 0) {
    return null
  }

  const visibleImages = images.slice(0, visibleCount)
  const remaining = images.length - visibleCount
  const finishedCount = loadedCount + failedCount
  const percent = Math.round((finishedCount / images.length) * 100)

  return (
    <div className="space-y-4">
      {/* Progress bar: server-side image generation progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Generated {loadedCount} of {images.length} images
            {failedCount > 0 && (
              <span className="text-amber-400">
                · {failedCount} failed (retry per image)
              </span>
            )}
          </span>
          <span className="font-mono tabular-nums">
            {finishedCount}/{images.length} ({percent}%)
          </span>
        </div>
        <Progress
          value={percent}
          aria-label="Image generation progress"
          className="h-2 bg-zinc-800 [&>div]:bg-emerald-600"
        />
      </div>

      {/* Image grid: responsive 1-2-3-4 columns */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {visibleImages.map((image) => (
          <ImageCell
            // Force a fresh remount whenever this image's server-side status
            // or URL changes (e.g. parent re-fetched after a full regen).
            // This avoids prop-sync-via-effect (which would trip the
            // react-hooks/set-state-in-effect lint rule).
            key={`${image.index}-${image.status}-${image.url}`}
            image={image}
            jobId={jobId}
          />
        ))}
      </div>

      {/* Sentinel for Intersection Observer */}
      {remaining > 0 && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-4 text-xs text-zinc-500"
        >
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading {remaining} more image{remaining > 1 ? 's' : ''}…
        </div>
      )}
    </div>
  )
}

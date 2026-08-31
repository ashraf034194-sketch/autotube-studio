import { spawn, type ChildProcess } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)

// ─── Pass 1 parallel-clip worker pool (SPEED OPTIMIZATION, 2026-05-12) ────────
//
// NUMBER OF PARALLEL WORKERS. Matches available CPU cores (capped at 4 —
// anything beyond 4 clips encoding simultaneously on a small box causes
// libx264 thread oversubscription + memory pressure). On a 2-core sandbox
// this is 2 workers, which roughly halves the Pass 1 wall-clock time
// (each clip takes ~1.5-2s; 44 clips sequential ≈ 70-90s, 2 workers ≈ 35-45s).
//
// The math: with N clips, W workers, per-clip time T → wall-clock ≈ (N/W) × T.
// For N=44, W=2, T=1.8s → 44/2 × 1.8 = 39.6s (vs 79.2s sequential ≈ 1.98× speed-up).
//
// Per-clip memory stays bounded at ~100MB peak. With 2 workers that's ~200MB
// peak total — well within the sandbox memory budget.
//
// Each parallel worker uses `-threads 1` (passed via buildClipEncodeArgs's
// `threads` param) so 2 workers × 1 thread = 2 libx264 threads on 2 cores —
// no oversubscription. The sequential path uses `-threads 2` (one clip at a
// time, both cores on it).
const PASS1_PARALLEL_WORKERS = Math.min(4, Math.max(1, (os.availableCpus?.() ?? os.cpus().length) || 1))

// ─── Constants ────────────────────────────────────────────────────────────────

const IMAGE_DIR_ROOT = process.env.AUTOTUBE_IMAGE_DIR || '/tmp/autotube-images'
export const VIDEO_DIR_ROOT = process.env.AUTOTUBE_VIDEO_DIR || '/tmp/autotube-videos'
const VIDEO_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours — videos are big; keep long enough to download

/** Each image is shown for approximately 4 seconds (per spec). */
const PER_IMAGE_SECONDS = 4

/** Variable pacing range (Phase 5B). Per-image duration is clamped to [3, 5]
 * seconds so longer segments get more time and shorter ones get less, while
 * keeping the total duration equal to the voiceover length. */
const MIN_CLIP_SECONDS = 3
const MAX_CLIP_SECONDS = 5

/** Light fade duration (in + out per segment) — "halka fade effect", no jerky cuts. */
const FADE_SECONDS = 0.5

/** Phase 6 PART 4 — Output resolution.
 *
 *  - '1080p' (default): 1920×1080 Full HD. Fast, memory-bounded (~100MB peak
 *    per clip in Pass 1, ~6 clips sequential → ~600MB peak).
 *  - '4k' (optional, toggle default OFF): 3840×2160 Ultra HD. ~4× the pixels
 *    → ~2-3× the encoding time and ~4× the per-clip peak memory (~400MB per
 *    clip → ~2.4GB peak for a 6-clip batch). The existing two-pass sequential
 *    pipeline (Pass 1 per-clip encode, Pass 2 xfade/concat) keeps each step
 *    memory-bounded — no full-frame buffering across all clips, so 4K won't
 *    OOM. The user-facing warning makes the time + memory cost explicit.
 *
 * The resolution change happens entirely in Pass 1 (the per-clip, title-card,
 * and outro encoders). Pass 2 (xfade chain + concat/mux) inherits whatever
 * resolution Pass 1 produced — no extra change needed there. Font sizes scale
 * linearly with the resolution multiplier so text stays proportional.
 *
 * SPEED OPTIMIZATION (2026-05-12): 1080p uses `-preset veryfast` (was
 * `medium`) for ~2× faster encoding — visually lossless for photo-based
 * slideshows at CRF 23. 4K keeps `-preset medium` (slower but better quality
 * per pixel, smaller files for 4× the data). This is resolution-aware tuning:
 * fast default for everyday 1080p, heavier processing only for explicit 4K.
 */
export type OutputResolution = '1080p' | '4k'

interface OutputGeometry {
  /** Width in pixels. */
  w: number
  /** Height in pixels. */
  h: number
  /** Frames per second. */
  fps: number
  /** Multiplier for absolute-pixel constants (font sizes, margins). 1 at
   *  1080p, 2 at 4K (4K has 2× the pixels per axis). */
  fontScale: number
  /** Human-readable label for UI + logs. */
  label: string
}

/** Default 1080p geometry (used by tests + legacy paths). */
const OUT_W = 1920
const OUT_H = 1080
const OUT_FPS = 30

function getOutputGeometry(resolution: OutputResolution | undefined): OutputGeometry {
  if (resolution === '4k') {
    return { w: 3840, h: 2160, fps: OUT_FPS, fontScale: 2, label: '4K · 3840×2160' }
  }
  return { w: OUT_W, h: OUT_H, fps: OUT_FPS, fontScale: 1, label: '1080p · 1920×1080' }
}

/** Ken Burns master toggle — Phase 5A. */
const KEN_BURNS_ENABLED = true

/** Maximum zoom factor for Ken Burns — keeps the motion subtle/professional. */
const KB_MAX_ZOOM = 1.12

/** Phase 6 PART 1 — Smart Transitions.
 *
 * Optional content-aware transitions between consecutive clips (fade / slide /
 * wipe / dissolve). When OFF (default), the video uses the legacy
 * fade-through-black + concat-demuxer path (stream copy in Pass 2 — fast).
 * When ON, Pass 2 re-encodes via FFmpeg's `xfade` filter chain so adjacent
 * clips actually blend into each other (no fade-to-black gap).
 *
 * The transition TYPE is chosen per-boundary by content similarity of the two
 * narration segments: high word-overlap (same scene) → gentle fade/dissolve;
 * low overlap (topic change) → sharper slide/wipe. Deterministic by index so
 * a given script always yields the same video.
 */
const TRANSITION_DURATION = 0.5 // seconds of overlap per transition

/** Transition types — curated subset of FFmpeg xfade transitions that look
 * subtle + professional (no garish TikTok-style effects). */
type TransitionType =
  | 'fade'
  | 'dissolve'
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  | 'wipeleft'
  | 'wiperight'
  | 'smoothleft'
  | 'smoothright'

/** Phase 5B — On-screen captions.
 *
 *  Burned into each clip via FFmpeg's `drawtext` filter in Pass 1 (per-clip
 *  encode) so the existing memory-bounded two-pass pipeline stays unchanged.
 *  Captions are OPTIONAL: when `captionsEnabled` is false, the filter chain
 *  is identical to the pre-Phase-5B output.
 *
 *  Style (per spec — "jaisa YouTube Shorts/Reels mein hota hai"):
 *    - Bold, readable font (DejaVu Sans Bold — pre-installed on Linux).
 *    - White fill + thick black outline (readable on any background).
 *    - Bottom-center, ~80px from the bottom edge.
 *    - Word-wrapped to ~2 lines max so longer sentences don't overflow.
 */
const CAPTION_FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
const CAPTION_FONT_SIZE = 54
const CAPTION_BOTTOM_MARGIN = 80
const CAPTION_MAX_CHARS_PER_LINE = 38
const CAPTION_MAX_LINES = 2

// ─── Phase 6 PART 2 — Title Card + Text Highlights ───────────────────────────
//
// TITLE CARD: a 2-3 second intro clip shown at the very start of the video.
//   - Background: the first image, heavily blurred + darkened (so the title
//     text is readable on any background).
//   - Foreground: the LLM-generated title text, large bold sans-serif, centered.
//     The text fades in over the first 0.6s (drawtext `alpha` expression).
//   - The clip is encoded as a standalone MP4 (same memory profile as a regular
//     image clip — ~100MB peak) and prepended to the concat list / xfade chain
//     in Pass 2.
//   - The voiceover audio is DELAYED by TITLE_CARD_DURATION seconds (via the
//     `adelay` filter) so the title card plays silently (or with music at full
//     volume, since sidechain compression only ducks during voice activity).
//
// TEXT HIGHLIGHTS: a small bold overlay (CapCut "QUICK" style) shown for ~2.5s
//   on the specific clip the LLM identified as a key moment (statistic, quote,
//   power statement). Max 5 highlights per video. Positioned in the upper-third
//   of the screen (y=100px) so it doesn't overlap with the bottom captions.
//   The overlay fades in over 0.3s, holds, then fades out over 0.3s — all via
//   a single `drawtext alpha` expression appended to the existing per-clip
//   filter chain (no extra memory cost — drawtext is just a glyph atlas + text
//   bitmap, both small).

const TITLE_CARD_DURATION = 2.5 // seconds the title card holds the screen
const TITLE_CARD_FONT_FILE = CAPTION_FONT_FILE // reuse DejaVu Sans Bold
const TITLE_CARD_FONT_SIZE = 92 // larger than captions — title-card presence
const TITLE_CARD_BLUR_RADIUS = 20 // boxblur radius — heavy background blur
const TITLE_CARD_DARKEN_ALPHA = 0.55 // black overlay opacity over the bg image
const TITLE_CARD_TEXT_FADE_IN = 0.6 // text fade-in duration (seconds)

const HIGHLIGHT_FONT_FILE = CAPTION_FONT_FILE
const HIGHLIGHT_FONT_SIZE = 72
const HIGHLIGHT_TOP_MARGIN = 100 // y offset — upper-third (avoids caption overlap)
const HIGHLIGHT_DURATION = 2.5 // how long the highlight stays visible
const HIGHLIGHT_FADE = 0.3 // fade-in + fade-out duration (seconds)

// Phase 6 P3 — Outro End Card constants.
// The outro is a 3.5s clip appended to the END of the video. It uses the LAST
// image as a blurred+darkened background (mirrors the title card's visual
// language for symmetry), with two stacked text lines:
//   Line 1 (above center): "Thanks for watching"  — fixed, professional.
//   Line 2 (below center): LLM-generated call-to-action tied to the script
//                          (e.g. "Subscribe for more 1% habits"). Falls back
//                          to "Subscribe for more" if the LLM fails.
//
// The text fades in over the first 0.6s, holds, then fades out over the last
// 0.8s — a subtle, non-flashy end card (per user spec "subtle"). The music
// (if enabled) continues through the outro and fades out at the very end.
const OUTRO_DURATION = 3.5 // seconds the outro holds the screen
const OUTRO_FONT_FILE = CAPTION_FONT_FILE // reuse DejaVu Sans Bold
const OUTRO_LINE1_FONT_SIZE = 80 // "Thanks for watching" — primary line
const OUTRO_LINE2_FONT_SIZE = 64 // CTA — slightly smaller, secondary
const OUTRO_BLUR_RADIUS = 20 // boxblur radius — heavy background blur
const OUTRO_DARKEN_ALPHA = 0.6 // black overlay opacity (slightly darker than title for "end" feel)
const OUTRO_TEXT_FADE_IN = 0.6 // text fade-in duration (seconds)
const OUTRO_TEXT_FADE_OUT = 0.8 // text fade-out duration (seconds, at the end)
const OUTRO_LINE_GAP = 8 // vertical gap between line 1 and line 2 (pixels)

// ─── Types ────────────────────────────────────────────────────────────────────

export type VideoStage =
  | 'preparing'
  | 'assembling'
  | 'finalizing'
  | 'done'
  | 'error'

/**
 * Phase 6 PART 2 — A key-moment text highlight overlaid on a specific clip.
 * The LLM scans the rewritten script + per-clip segments and emits up to 5 of
 * these (anchored to a segmentIndex, with short punchy text). The drawtext
 * filter fades the text in/out over the first ~2.5s of that clip.
 */
export interface TextHighlight {
  /** 0-based index of the segment (clip) this highlight overlays. */
  segmentIndex: number
  /** Short punchy text (max ~32 chars, no full sentence). */
  text: string
}

export interface VideoJob {
  id: string
  status: 'processing' | 'done' | 'error'
  stage: VideoStage
  progress: number // 0-100
  imageCount: number
  audioDuration: number
  imageJobId: string
  videoPath?: string
  fileSize?: number // bytes
  videoDuration?: number // seconds (measured after build)
  /** 'on' if Ken Burns effect was applied to this video. */
  kenBurnsApplied?: boolean
  /** Label for the music source used ('calm' / 'ambient' / 'upbeat' / 'upload' / undefined). */
  musicLabel?: string
  /** 'on' if on-screen captions were burned into this video (Phase 5B). */
  captionsApplied?: boolean
  /** 'on' if variable pacing was used (Phase 5B) — durations vary per segment. */
  variablePacingApplied?: boolean
  /** 'on' if smart transitions (fade/slide/wipe) were blended between clips (Phase 6 P1). */
  transitionsApplied?: boolean
  /** 'on' if a title card clip was prepended to the video (Phase 6 P2). */
  titleCardApplied?: boolean
  /** The LLM-generated title text shown on the title card (for UI display). */
  titleCardText?: string
  /** 'on' if key-moment text highlights were burned into specific clips (Phase 6 P2). */
  textHighlightsApplied?: boolean
  /** Number of highlights applied (for UI display). */
  textHighlightsCount?: number
  /** 'on' if an outro end card clip was appended to this video (Phase 6 P3). */
  outroApplied?: boolean
  /** The LLM-generated (or fallback) CTA text shown on the outro end card (for UI display). */
  outroCtaText?: string
  /** Phase 6 P4 — output resolution. Default '1080p'. '4k' = 3840×2160. */
  resolution?: OutputResolution
  /** Phase 6 P4 — measured output width (ffprobe-verified, for UI display). */
  videoWidth?: number
  /** Phase 6 P4 — measured output height (ffprobe-verified, for UI display). */
  videoHeight?: number
  error?: string
  ffmpegTail?: string // last ~30 stderr lines for diagnostics
  createdAt: number
  startedAt?: number
  doneAt?: number
  etaSeconds?: number
}

// ─── In-memory job store (TTL 2 hours) ────────────────────────────────────────

const jobs = new Map<string, VideoJob>()
const abortControllers = new Map<string, ChildProcess>()

function cleanupExpiredJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > VIDEO_TTL_MS) {
      const proc = abortControllers.get(id)
      if (proc) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        abortControllers.delete(id)
      }
      jobs.delete(id)
    }
  }
}

export function getVideoJob(jobId: string): VideoJob | undefined {
  cleanupExpiredJobs()
  return jobs.get(jobId)
}

export function listVideoJobs(): VideoJob[] {
  cleanupExpiredJobs()
  return Array.from(jobs.values())
}

// ─── Duration math ────────────────────────────────────────────────────────────

/**
 * Phase 5B — Variable pacing.
 *
 * Distributes `audioDuration` seconds across `segments.length` clips so that:
 *   - Each clip's duration is proportional to its segment's character count
 *     (longer narration → more time on screen).
 *   - All durations are clamped to [MIN_CLIP_SECONDS, MAX_CLIP_SECONDS].
 *   - The total equals `audioDuration` (within ~50ms — rounding noise).
 *
 * Algorithm:
 *   1. Compute each segment's character share.
 *   2. Multiply by audioDuration to get raw durations.
 *   3. Clamp each to [MIN, MAX].
 *   4. Iteratively redistribute the slack (audioDuration - sum(clamped)) to
 *      clips that still have headroom (for positive slack) or shrink clips
 *      that are still above MIN (for negative slack).
 *   5. If redistribution can't absorb all the slack (all clips at the
 *      boundary), dump the remainder onto the LAST clip — this matches the
 *      previous "last image absorbs the tail" behaviour so the output always
 *      matches the voiceover length exactly.
 *
 * Returns durations in seconds, rounded to 3 decimal places.
 */
function computeVariableDurations(segments: string[], audioDuration: number): number[] {
  const n = segments.length
  if (n === 0) return []
  if (n === 1) return [Math.round(audioDuration * 1000) / 1000]

  const charCounts = segments.map((s) => Math.max(1, (s || '').trim().length))
  const totalChars = charCounts.reduce((a, b) => a + b, 0)

  // Initial proportional durations.
  let durations = charCounts.map((c) => (audioDuration * c) / totalChars)

  // Iterative clamp + redistribute. Converges in 3-4 iterations max.
  for (let iter = 0; iter < 6; iter++) {
    const sum = durations.reduce((a, b) => a + b, 0)
    const diff = audioDuration - sum
    if (Math.abs(diff) < 0.05) break

    if (diff > 0) {
      // Need to ADD time. Pick clips that aren't at MAX yet; distribute
      // proportionally to their remaining headroom.
      const headroom = durations.map((d) => Math.max(0, MAX_CLIP_SECONDS - d))
      const totalHeadroom = headroom.reduce((a, b) => a + b, 0)
      if (totalHeadroom < 0.01) break // all at MAX
      let added = 0
      for (let i = 0; i < n; i++) {
        if (headroom[i] <= 0) continue
        const share = (headroom[i] / totalHeadroom) * diff
        durations[i] = Math.min(MAX_CLIP_SECONDS, durations[i] + share)
        added += share
      }
      if (added < 0.01) break
    } else {
      // Need to REMOVE time. Pick clips that aren't at MIN yet; distribute
      // proportionally to their slack above MIN.
      const slack = durations.map((d) => Math.max(0, d - MIN_CLIP_SECONDS))
      const totalSlack = slack.reduce((a, b) => a + b, 0)
      if (totalSlack < 0.01) break // all at MIN
      let removed = 0
      for (let i = 0; i < n; i++) {
        if (slack[i] <= 0) continue
        const share = (slack[i] / totalSlack) * (-diff)
        durations[i] = Math.max(MIN_CLIP_SECONDS, durations[i] - share)
        removed += share
      }
      if (removed < 0.01) break
    }
  }

  // Final correction — push any residual diff onto the last clip so the total
  // matches audioDuration exactly (the last image "holds" until the narration
  // finishes; matches the pre-Phase-5B behaviour).
  const finalSum = durations.reduce((a, b) => a + b, 0)
  const residual = audioDuration - finalSum
  if (Math.abs(residual) > 0.001) {
    durations[n - 1] = Math.max(0.5, durations[n - 1] + residual)
  }

  return durations.map((d) => Math.round(d * 1000) / 1000)
}

/**
 * Legacy fixed-duration pacing — used when no script segments are available
 * (e.g. captions + variable pacing both off). Each image is shown for exactly
 * PER_IMAGE_SECONDS (4s); the last image absorbs the remainder so the video
 * matches the voiceover length.
 */
function computeFixedDurations(imageCount: number, audioDuration: number): number[] {
  const total = imageCount * PER_IMAGE_SECONDS
  const durations = new Array<number>(imageCount).fill(PER_IMAGE_SECONDS)
  if (audioDuration > total) {
    durations[imageCount - 1] = audioDuration - (imageCount - 1) * PER_IMAGE_SECONDS
  }
  return durations
}

// ─── Phase 5B — Script segmentation + caption helpers ─────────────────────────

/**
 * Greedy sentence-aware word-wrap for a single caption line.
 *
 * Splits the input text into lines no longer than CAPTION_MAX_CHARS_PER_LINE.
 * If the text exceeds CAPTION_MAX_LINES lines, the last line is truncated
 * with an ellipsis so the caption never overflows the bottom of the frame.
 */
function wrapCaption(text: string): string {
  const raw = (text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  const words = raw.split(' ')
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w
    if (candidate.length > CAPTION_MAX_CHARS_PER_LINE && current) {
      lines.push(current)
      current = w
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)

  if (lines.length > CAPTION_MAX_LINES) {
    // Truncate the CAPTION_MAX_LINES-th line to fit + add ellipsis.
    const last = lines[CAPTION_MAX_LINES - 1]
    const trimmed = last.length > CAPTION_MAX_CHARS_PER_LINE - 1
      ? last.slice(0, CAPTION_MAX_CHARS_PER_LINE - 1).trimEnd() + '…'
      : last + ' …'
    return lines.slice(0, CAPTION_MAX_LINES - 1).concat(trimmed).join('\n')
  }
  return lines.join('\n')
}

/**
 * Split a script (a free-form narration string) into `count` sequential,
 * roughly-balanced segments for captioning + variable pacing.
 *
 * Strategy:
 *   1. Split by sentence terminators (. ! ?), keeping terminators.
 *   2. If we have ≥ count sentences, group them SEQUENTIALLY into `count`
 *      buckets, balancing by character count (so captions stay in order).
 *   3. If we have fewer sentences than `count`, fall back to word-level
 *      grouping (so we still produce `count` non-empty captions).
 *
 * The bucket-filling is "online": walk units in order, add to the current
 * bucket, and advance to the next bucket when (a) the current bucket has
 * reached the target character count OR (b) we MUST advance to ensure every
 * remaining bucket gets at least one unit.
 */
export function splitScriptIntoSegments(script: string, count: number): string[] {
  const text = (script || '').replace(/\s+/g, ' ').trim()
  if (count <= 0) return []
  if (count === 1) return [text]
  if (!text) return new Array(count).fill('')

  // Sentence split — keep terminators with their sentences.
  const sentenceMatches = text.match(/[^.!?]*[.!?]+|\S[^.!?]*$/g)
  const sentences = (sentenceMatches ?? [text]).map((s) => s.trim()).filter(Boolean)

  let units: string[]
  if (sentences.length >= count) {
    units = sentences
  } else {
    // Not enough sentences — fall back to word-level grouping.
    units = text.split(' ').filter(Boolean)
  }

  if (units.length === 0) return new Array(count).fill('')

  const totalChars = units.reduce((sum, u) => sum + u.length + 1, 0)
  const target = totalChars / count

  const bucketContents: string[][] = Array.from({ length: count }, () => [])
  let segIdx = 0
  let segSize = 0

  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const remainingUnits = units.length - i // units not yet placed (incl. this one)
    const remainingSegments = count - segIdx // buckets still to fill (incl. current)

    // We MUST advance to the next bucket when NOT advancing would starve a
    // later bucket — i.e. the remaining units are no more than the remaining
    // buckets (each remaining bucket needs at least one). Guarded by "current
    // bucket already has a unit" so we never leave the current bucket empty.
    // (Without this guard, when units.length === count the very first unit
    // would advance out of bucket 0, leaving it empty → empty caption + a
    // near-zero-duration clip that starves the xfade transition.)
    const mustAdvance =
      bucketContents[segIdx].length > 0 && remainingUnits <= remainingSegments
    // We SHOULD advance when the current bucket has reached the target AND
    // there are MORE remaining units than remaining buckets (so every bucket
    // still gets at least one unit).
    const shouldAdvance = segSize >= target && remainingUnits > remainingSegments

    if (segIdx < count - 1 && (mustAdvance || shouldAdvance)) {
      segIdx++
      segSize = 0
    }

    bucketContents[segIdx].push(u)
    segSize += u.length + 1 // +1 for the space join
  }

  return bucketContents.map((parts) => parts.join(' ').trim())
}

// ─── Phase 6 PART 1 — Smart Transitions (content-aware) ───────────────────────
//
// Choose a transition type for the boundary between clip i and clip i+1 based
// on how similar their narration segments are. Same-scene (high word overlap)
// → gentle fade/dissolve so the cut is barely noticeable. Topic/scene change
// (low overlap) → a sharper slide/wipe to signal the shift. Deterministic by
// clip index so a given script always yields the same video.

function tokenizeForSim(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2) // drop tiny stopword-ish tokens
}

/** Jaccard word-overlap similarity in [0,1] between two narration segments. */
function segmentSimilarity(a: string, b: string): number {
  const wa = new Set(tokenizeForSim(a))
  const wb = new Set(tokenizeForSim(b))
  if (wa.size === 0 && wb.size === 0) return 1
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  const union = wa.size + wb.size - inter
  return union > 0 ? inter / union : 0
}

// Gentle pool (same scene) — vary subtly to avoid monotony.
const GENTLE_TRANSITIONS: TransitionType[] = ['fade', 'dissolve', 'fade', 'smoothleft', 'smoothright']
// Sharper pool (topic change) — directional variety, deterministic by index.
const SHARPER_TRANSITIONS: TransitionType[] = ['slideleft', 'slideup', 'wipeleft', 'slideright', 'slidedown', 'wiperight']

/** Pick a transition for the boundary between clip i and clip i+1. */
function chooseTransition(segA: string, segB: string, clipIndex: number): TransitionType {
  const sim = segmentSimilarity(segA, segB)
  // Same-scene threshold: >= 0.30 word overlap → keep it gentle.
  if (sim >= 0.3) {
    return GENTLE_TRANSITIONS[clipIndex % GENTLE_TRANSITIONS.length]
  }
  return SHARPER_TRANSITIONS[clipIndex % SHARPER_TRANSITIONS.length]
}

// ─── FFmpeg argument builder ──────────────────────────────────────────────────

/**
 * Build the full FFmpeg argument list for a single-pass slideshow with
 * per-segment fade-in/fade-out (smooth fade-through-black transitions).
 *
 * Layout:
 *   inputs  : [img0..imgN-1] each as `-loop 1 -t <dur> -i <path>`, then `-i <audio>`
 *   filter  : per-image [k:v] scale→pad→setsar→fps→format→fade in→fade out [vk]
 *            then [v0][v1]...[vN-1]concat=n=N:v=1:a=0 [outv]
 *   output  : -map [outv] -map N:a  (audio is the last input index)
 *            -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -r 30
 *            -c:a aac -b:a 192k -t <audioDuration> -movflags +faststart <out>
 */
function buildFFmpegArgs(
  imagePaths: string[],
  durations: number[],
  audioPath: string,
  outputPath: string,
  audioDuration: number
): string[] {
  const args: string[] = ['-y', '-hide_banner']

  // Image inputs (indices 0 .. N-1)
  imagePaths.forEach((p, i) => {
    args.push('-loop', '1', '-t', durations[i].toFixed(3), '-i', p)
  })

  // Audio input (index N)
  args.push('-i', audioPath)

  // ── filter_complex ──
  const segFilters: string[] = []
  imagePaths.forEach((_, i) => {
    const fadeOutStart = Math.max(0, durations[i] - FADE_SECONDS).toFixed(3)
    // scale to fit inside 1920x1080 preserving aspect, then pad (letterbox) to
    // exactly 1920x1080, set SAR=1, fps=30, pixel format, then fades.
    segFilters.push(
      `[${i}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${OUT_FPS},format=yuv420p,fade=t=in:st=0:d=${FADE_SECONDS},fade=t=out:st=${fadeOutStart}:d=${FADE_SECONDS}[v${i}]`
    )
  })

  // concat filter: chain all labelled segments
  const concatInputs = imagePaths.map((_, i) => `[v${i}]`).join('')
  const n = imagePaths.length
  const filterComplex =
    segFilters.join(';') +
    `;${concatInputs}concat=n=${n}:v=1:a=0[outv]`

  args.push('-filter_complex', filterComplex)

  // Mapping + encoding
  args.push(
    '-map', '[outv]',
    '-map', `${n}:a`,
    '-c:v', 'libx264',
    // SPEED: veryfast preset + explicit -threads 2 (uses both CPU cores).
    // This is the legacy concat+audio-mux path; it runs once at the end so
    // the speed-up is bounded but still meaningful for the final mux step.
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-threads', '2',
    '-r', String(OUT_FPS),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-shortest',
    '-t', audioDuration.toFixed(3),
    '-movflags', '+faststart',
    outputPath
  )

  return args
}

// ─── Progress parsing ─────────────────────────────────────────────────────────

const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/

function parseTimeToSeconds(line: string): number | null {
  const m = TIME_RE.exec(line)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const s = parseFloat(m[3])
  return h * 3600 + min * 60 + s
}

// ─── ffprobe helpers ──────────────────────────────────────────────────────────

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ],
    { timeout: 30000 }
  )
  const dur = parseFloat(stdout.trim())
  return Number.isFinite(dur) && dur > 0 ? dur : 0
}

/**
 * Phase 6 P4 — Probe the output video's geometry (width × height + codec).
 * Used to ffprobe-verify that a 4K job actually produced 3840×2160 (and a
 * 1080p job produced 1920×1080). Returns null on probe failure.
 */
async function probeVideoGeometry(
  filePath: string
): Promise<{ width: number; height: number; codec: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,codec_name',
        '-of', 'json',
        filePath
      ],
      { timeout: 30000 }
    )
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; codec_name?: string }>
    }
    const s = parsed.streams?.[0]
    if (!s || typeof s.width !== 'number' || typeof s.height !== 'number') {
      return null
    }
    return { width: s.width, height: s.height, codec: s.codec_name ?? 'unknown' }
  } catch {
    return null
  }
}

// ─── Main assembly function ───────────────────────────────────────────────────

export interface AssembleParams {
  imageJobId: string
  imageCount: number
  audioPath: string
  audioDuration: number
  audioMime: string
  /**
   * Optional background music path (absolute). When null/undefined, the video
   * is assembled without music (existing behavior). When set, the music is
   * looped/trimmed to match the voiceover duration and ducked under the
   * voiceover using sidechain compression.
   */
  musicPath?: string | null
  /** UI label for the music source (e.g. 'calm', 'ambient', 'upbeat', 'upload'). */
  musicLabel?: string
  /**
   * Phase 5B — On-screen captions. When true, each clip gets a `drawtext`
   * overlay with its corresponding script segment. The textfile is written to
   * the job dir per-clip to avoid FFmpeg's escaping pitfalls.
   */
  captionsEnabled?: boolean
  /**
   * Phase 5B — Pre-split script segments (one per image). Used for BOTH the
   * caption text AND variable pacing (longer segments get more time). When
   * omitted or shorter than imageCount, falls back to fixed-duration pacing.
   */
  segments?: string[]
  /**
   * Phase 6 P1 — Smart Transitions. When true, Pass 2 uses FFmpeg `xfade` to
   * blend consecutive clips with content-aware transitions (gentle fade within
   * a scene, sharper slide/wipe on topic change). Default false — the legacy
   * concat-demuxer path is used otherwise.
   */
  transitionsEnabled?: boolean
  /**
   * Phase 6 P2 — Title Card. When true (and titleCardText is non-empty),
   * Pass 1 encodes a 2.5s intro clip with the first image as a blurred+darkened
   * background and the LLM-generated title text faded in centered, then Pass 2
   * prepends it to the concat/xfade chain and delays the voiceover audio by
   * TITLE_CARD_DURATION so the title card plays silently (or with music at
   * full volume when music is enabled).
   */
  titleCardEnabled?: boolean
  /** The LLM-generated title text to show on the title card. */
  titleCardText?: string
  /**
   * Phase 6 P2 — Text Highlights. When true (and textHighlights is non-empty),
   * Pass 1 burns a bold yellow text overlay onto each flagged clip (fades
   * in/out over the first ~2.5s, positioned in the upper-third so it doesn't
   * overlap with the bottom captions). Max 5 highlights per video.
   */
  textHighlightsEnabled?: boolean
  /** The LLM-identified key-moment highlights, each anchored to a segment index. */
  textHighlights?: TextHighlight[]
  /**
   * Phase 6 P3 — Outro End Card. When true (and outroCtaText is non-empty),
   * Pass 1 encodes a 3.5s outro clip with the LAST image as a blurred+darkened
   * background, "Thanks for watching" (line 1) + the LLM-generated CTA (line 2)
   * fading in centered, then Pass 2 appends it to the concat/xfade chain.
   * The voiceover audio is padded with `apad` silence through the outro, and
   * the music (if enabled) continues through the outro, fading out at the
   * very end (1.5s fade).
   */
  outroEnabled?: boolean
  /** The CTA text to show on the outro end card (line 2). */
  outroCtaText?: string
  /**
   * Phase 6 P4 — Output resolution. Default '1080p' (1920×1080). When '4k',
   * the final video is encoded at 3840×2160 — ~2-3× slower + ~4× per-clip
   * memory (~400MB peak vs ~100MB). The existing two-pass sequential
   * pipeline keeps each step memory-bounded so 4K won't OOM.
   */
  resolution?: OutputResolution
}

function getImagePath(imageJobId: string, index: number): string {
  return path.join(IMAGE_DIR_ROOT, imageJobId, `${index}.jpg`)
}

export function createVideoJob(params: AssembleParams): VideoJob {
  const id = `vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const titleOn = !!params.titleCardEnabled && typeof params.titleCardText === 'string' && params.titleCardText.trim().length > 0
  const highlightsOn =
    !!params.textHighlightsEnabled &&
    Array.isArray(params.textHighlights) &&
    params.textHighlights.length > 0
  const outroOn = !!params.outroEnabled && typeof params.outroCtaText === 'string' && params.outroCtaText.trim().length > 0
  const job: VideoJob = {
    id,
    status: 'processing',
    stage: 'preparing',
    progress: 0,
    imageCount: params.imageCount,
    audioDuration: params.audioDuration,
    imageJobId: params.imageJobId,
    kenBurnsApplied: KEN_BURNS_ENABLED,
    musicLabel: params.musicLabel,
    captionsApplied: !!params.captionsEnabled,
    variablePacingApplied: Array.isArray(params.segments) && params.segments.length >= params.imageCount,
    transitionsApplied: !!params.transitionsEnabled && params.imageCount > 1,
    titleCardApplied: titleOn,
    titleCardText: titleOn ? params.titleCardText!.trim() : undefined,
    textHighlightsApplied: highlightsOn,
    textHighlightsCount: highlightsOn ? params.textHighlights!.length : 0,
    outroApplied: outroOn,
    outroCtaText: outroOn ? params.outroCtaText!.trim() : undefined,
    resolution: params.resolution === '4k' ? '4k' : '1080p',
    createdAt: Date.now()
  }
  jobs.set(id, job)
  return job
}

// ─── Two-pass FFmpeg pipeline (memory-bounded) ──────────────────────────────
//
// The original single-pass approach opens N image inputs simultaneously in
// one FFmpeg process, with a `filter_complex` of N parallel scale/pad/fade
// chains + concat. For N=25 images at 1920×1080×30fps, FFmpeg's RSS hits
// ~2.5GB and the OOM killer terminates the process.
//
// The two-pass approach:
//   Pass 1: Encode each image as a standalone 4s clip (1920×1080, 30fps,
//           h264, yuv420p, with per-segment fades). Memory per clip ≈ 100MB.
//   Pass 2: Use the concat demuxer (-f concat -safe 0 -i list.txt) to merge
//           all clips, then mux the audio. Video is COPIED (no re-encode),
//           so Pass 2 is fast (~1-2s for 25 clips) and uses minimal memory.
//
// Total memory usage is bounded by a single image encoding at any time.
// Total wall-clock time ≈ (N × ~1-2s for clip encode) + ~2s for concat.

/**
 * Pass 1: Encode a single image as a 4s silent video clip with all transforms
 * (scale, letterbox/pillarbox pad, SAR=1, fps, pixel format, fade in/out,
 * and an optional Ken Burns zoom/pan effect).
 *
 * Phase 5B — Captions: when `captionText` is provided (non-empty string),
 * a `drawtext` filter is appended to the chain so the caption is burned into
 * the clip. The text is read from a per-clip file (`captionFilePath`) to
 * avoid FFmpeg's quoting/escaping pitfalls (drawtext treats `:`, `'`, `%`,
 * `\` specially). The caption is positioned bottom-center with a thick black
 * outline so it's readable on any background.
 *
 * Phase 6 P2 — Text Highlights: when `highlightText` is provided (non-empty),
 * an ADDITIONAL drawtext filter is appended AFTER the caption drawtext, with
 * a bold yellow fill, an `alpha` expression that fades the text in/out over
 * the first ~2.5s of the clip, and a y offset of HIGHLIGHT_TOP_MARGIN (so it
 * sits in the upper-third and never overlaps with the bottom caption).
 *
 * Memory profile: one image decoded at a time + libx264 encode buffer ≈ 100MB.
 * Ken Burns is applied via `zoompan` (single image, d=1, fps=30) which emits
 * one output frame per input frame — no full-frame buffering, so memory stays
 * bounded at ~100MB peak per clip. drawtext (caption OR highlight OR both)
 * adds negligible memory (one glyph atlas + text bitmap, both small).
 */
function buildClipEncodeArgs(
  imagePath: string,
  outPath: string,
  duration: number,
  kenBurnsVariant: KenBurnsVariant,
  captionText: string | undefined,
  captionFilePath: string | undefined,
  transitionsEnabled: boolean | undefined,
  isFirst: boolean | undefined,
  isLast: boolean | undefined,
  highlightText: string | undefined,
  highlightFilePath: string | undefined,
  geo: OutputGeometry,
  // SPEED: thread count for the libx264 encode. Default 2 (sequential mode —
  // uses both CPU cores per clip). Pass 1 in parallel mode (2 concurrent clips
  // × 1 thread each = 2 threads on 2 cores — no oversubscription).
  threads: 1 | 2 = 2
): string[] {
  const fadeOutStart = Math.max(0, duration - FADE_SECONDS).toFixed(3)
  const totalFrames = Math.max(2, Math.round(duration * geo.fps))

  // Scale + pad (letterbox) to the target geometry first.
  let filterComplex =
    `scale=${geo.w}:${geo.h}:force_original_aspect_ratio=decrease,` +
    `pad=${geo.w}:${geo.h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,`

  // Ken Burns (optional) — applied before fps/format so it operates on the
  // padded frame.
  if (kenBurnsVariant && KEN_BURNS_ENABLED) {
    filterComplex += buildKenBurnsFilter(kenBurnsVariant, totalFrames, geo) + ','
  }

  filterComplex += `fps=${geo.fps},format=yuv420p`

  // Phase 6 P1 — when smart transitions are ON, the xfade filter in Pass 2
  // owns the boundary blend. So we only bake fades on the intro (first clip
  // fade-in) and outro (last clip fade-out); middle clips have NO baked fades
  // (the xfade handles both their in and out boundaries). When transitions are
  // OFF, the legacy fade-through-black is baked on every clip.
  const txOn = !!transitionsEnabled
  const bakeFadeIn = !txOn || !!isFirst
  const bakeFadeOut = !txOn || !!isLast
  const fadeParts: string[] = []
  if (bakeFadeIn) fadeParts.push(`fade=t=in:st=0:d=${FADE_SECONDS}`)
  if (bakeFadeOut) fadeParts.push(`fade=t=out:st=${fadeOutStart}:d=${FADE_SECONDS}`)
  if (fadeParts.length > 0) {
    filterComplex += ',' + fadeParts.join(',')
  }

  // Phase 5B — Caption burn-in. Applied AFTER fades so the text isn't faded
  // at clip boundaries (the caption appears immediately and disappears at
  // the cut — typical YouTube Shorts/Reels behaviour).
  if (captionText && captionText.trim() && captionFilePath) {
    filterComplex +=
      `,drawtext=` +
      `fontfile=${CAPTION_FONT_FILE}:` +
      `textfile=${captionFilePath}:` +
      `fontcolor=white:` +
      `fontsize=${CAPTION_FONT_SIZE * geo.fontScale}:` +
      `borderw=${4 * geo.fontScale}:` +
      `bordercolor=black:` +
      `shadowx=${2 * geo.fontScale}:shadowy=${2 * geo.fontScale}:shadowcolor=black@0.6:` +
      `x=(w-text_w)/2:` +
      `y=h-text_h-${CAPTION_BOTTOM_MARGIN * geo.fontScale}`
  }

  // Phase 6 P2 — Text-highlight burn-in. Applied AFTER the caption drawtext
  // (so the highlight is layered on top, never overlapped by the caption).
  // The `alpha` expression fades the highlight in over HIGHLIGHT_FADE seconds,
  // holds it until HIGHLIGHT_DURATION - HIGHLIGHT_FADE, then fades it out over
  // HIGHLIGHT_FADE seconds. After HIGHLIGHT_DURATION the alpha is 0 → the
  // drawtext is fully transparent (no visual, no CPU).
  if (highlightText && highlightText.trim() && highlightFilePath) {
    filterComplex += ',' + buildHighlightDrawtextFilter(highlightFilePath, duration, geo)
  }

  const args = [
    '-y', '-hide_banner',
    // When using zoompan, we MUST set the input framerate so that `on` (output
    // frame counter) advances at the configured fps and the zoom expression
    // reaches its target value exactly at the end of the clip.
    '-framerate', String(geo.fps),
    '-loop', '1',
    '-t', duration.toFixed(3),
    '-i', imagePath,
    '-vf', filterComplex,
    '-c:v', 'libx264',
    // SPEED: 1080p uses veryfast (~2× faster than medium, visually lossless at
    // CRF 23 for photo slideshows); 4K keeps medium (better per-pixel quality,
    // smaller files at 4× the pixel count).
    '-preset', geo.fontScale > 1 ? 'medium' : 'veryfast',
    // 4K has 4× the pixels — use a slightly lower CRF to keep the bitrate
    // reasonable (~25Mbps for 4K vs ~8Mbps for 1080p at CRF 23). Same visual
    // quality per pixel; just larger file.
    '-crf', geo.fontScale > 1 ? '24' : '23',
    '-pix_fmt', 'yuv420p',
    // SPEED: explicit -threads param. Sequential mode = 2 (uses both CPU
    // cores per clip). Parallel Pass 1 mode = 1 (avoids oversubscription
    // when 2 clips encode simultaneously: 2 clips × 1 thread = 2 threads).
    '-threads', String(threads),
    '-r', String(geo.fps),
    '-an', // no audio (added in Pass 2)
    '-movflags', '+faststart',
    outPath
  ]
  return args
}

/**
 * Phase 6 P2 — Build the drawtext filter string for a key-moment highlight.
 *
 * The text is read from a per-clip file (same pattern as the caption textfile
 * — avoids FFmpeg's quoting/escaping pitfalls). Style:
 *   - Bold sans-serif (DejaVu Sans Bold), large (72px), yellow fill.
 *   - Thick black border + drop shadow for readability on any background.
 *   - Centered horizontally, positioned in the upper-third (y=100) so it never
 *     overlaps with the bottom captions.
 *   - The `alpha` expression fades the text in over HIGHLIGHT_FADE seconds,
 *     holds at full opacity until HIGHLIGHT_DURATION - HIGHLIGHT_FADE, then
 *     fades out over HIGHLIGHT_FADE seconds. After HIGHLIGHT_DURATION the
 *     alpha is 0 → the drawtext is fully transparent (no visual cost).
 *
 * The alpha expression is a piecewise-linear function of `t` (current time in
 * seconds) clamped to [0, 1]:
 *   if t < fade           → t/fade                       (fade-in ramp)
 *   if t < show - fade     → 1                            (full opacity hold)
 *   if t < show            → (show - t)/fade              (fade-out ramp)
 *   else                   → 0                            (off)
 *
 * We use FFmpeg's ternary `if(COND, A, B)` syntax. The `show` duration is
 * clamped to `min(HIGHLIGHT_DURATION, clipDuration - HIGHLIGHT_FADE)` so the
 * fade-out always completes within the clip (never gets clipped mid-fade).
 */
function buildHighlightDrawtextFilter(highlightFilePath: string, clipDuration: number, geo: OutputGeometry): string {
  const show = Math.min(HIGHLIGHT_DURATION, Math.max(HIGHLIGHT_FADE * 2, clipDuration - HIGHLIGHT_FADE))
  const fade = HIGHLIGHT_FADE
  // alpha piecewise: 0→1 over [0,fade], 1 over [fade, show-fade], 1→0 over [show-fade, show], 0 after.
  const alphaExpr =
    `if(lt(t,${fade}),t/${fade},if(lt(t,${show - fade}),1,if(lt(t,${show}),(${show}-t)/${fade},0)))`
  return (
    `drawtext=` +
    `fontfile=${HIGHLIGHT_FONT_FILE}:` +
    `textfile=${highlightFilePath}:` +
    `fontcolor=yellow:` +
    `fontsize=${HIGHLIGHT_FONT_SIZE * geo.fontScale}:` +
    `borderw=${4 * geo.fontScale}:` +
    `bordercolor=black@0.85:` +
    `shadowx=${2 * geo.fontScale}:shadowy=${2 * geo.fontScale}:shadowcolor=black@0.6:` +
    `x=(w-text_w)/2:` +
    `y=${HIGHLIGHT_TOP_MARGIN * geo.fontScale}:` +
    `alpha='${alphaExpr}'`
  )
}

/**
 * Phase 6 P2 — Build the FFmpeg args for the TITLE CARD clip.
 *
 * Layout:
 *   - Single input image (the first image of the video).
 *   - Filter chain:
 *       scale+pad to 1920×1080 → heavy boxblur → dark overlay (drawbox) →
 *       fps+format → drawtext with the LLM-generated title (fontfile from
 *       a textfile, large bold sans-serif white text, centered, with an
 *       `alpha` expression that fades the title in over
 *       TITLE_CARD_TEXT_FADE_IN seconds and holds at full opacity).
 *   - Output: 1920×1080, 30fps, h264, yuv420p, NO audio (muxed in Pass 2).
 *
 * Memory profile: identical to a regular image clip encode (~100MB peak) —
 * no full-frame buffering because the chain is single-pass per-frame. The
 * boxblur uses FFmpeg's separable implementation (O(radius*w*h) per frame)
 * which is bounded by the blur radius (20) — small.
 *
 * The title card does NOT bake fade-in/fade-out on the BACKGROUND (just the
 * text) so the darkened image is steady throughout the 2.5s intro — the
 * Pass 2 xfade/concat handles the visual transition into clip 0.
 */
function buildTitleCardArgs(
  imagePath: string,
  outPath: string,
  duration: number,
  titleTextFilePath: string,
  geo: OutputGeometry
): string[] {
  const alphaExpr = `if(lt(t,${TITLE_CARD_TEXT_FADE_IN}),t/${TITLE_CARD_TEXT_FADE_IN},1)`
  const filterComplex =
    // Scale + pad to the target geometry (so any source image aspect fits).
    `scale=${geo.w}:${geo.h}:force_original_aspect_ratio=decrease,` +
    `pad=${geo.w}:${geo.h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,` +
    // Heavy blur on the background image — so the title text is readable.
    `boxblur=${TITLE_CARD_BLUR_RADIUS}:1,` +
    // Dark overlay (semi-transparent black rectangle over the whole frame).
    `drawbox=0:0:${geo.w}:${geo.h}:color=black@${TITLE_CARD_DARKEN_ALPHA}:t=fill,` +
    `fps=${geo.fps},format=yuv420p,` +
    // Title text — large bold white, centered, fade-in.
    `drawtext=` +
    `fontfile=${TITLE_CARD_FONT_FILE}:` +
    `textfile=${titleTextFilePath}:` +
    `fontcolor=white:` +
    `fontsize=${TITLE_CARD_FONT_SIZE * geo.fontScale}:` +
    `borderw=${5 * geo.fontScale}:` +
    `bordercolor=black@0.9:` +
    `shadowx=${3 * geo.fontScale}:shadowy=${3 * geo.fontScale}:shadowcolor=black@0.7:` +
    `x=(w-text_w)/2:` +
    `y=(h-text_h)/2:` +
    `alpha='${alphaExpr}'`

  return [
    '-y', '-hide_banner',
    '-framerate', String(geo.fps),
    '-loop', '1',
    '-t', duration.toFixed(3),
    '-i', imagePath,
    '-vf', filterComplex,
    '-c:v', 'libx264',
    // SPEED: 1080p uses veryfast (~2× faster than medium); 4K keeps medium.
    '-preset', geo.fontScale > 1 ? 'medium' : 'veryfast',
    '-crf', geo.fontScale > 1 ? '24' : '23',
    '-pix_fmt', 'yuv420p',
    // SPEED: explicit -threads 2 (uses both CPU cores per clip encode).
    '-threads', '2',
    '-r', String(geo.fps),
    '-an',
    '-movflags', '+faststart',
    outPath
  ]
}

/**
 * Phase 6 P3 — Build the FFmpeg args for the OUTRO END CARD clip.
 *
 * Layout (mirrors the title card for symmetry, but at the END of the video):
 *   - Single input image (the LAST image of the video).
 *   - Filter chain:
 *       scale+pad to 1920×1080 → heavy boxblur → dark overlay (drawbox) →
 *       fps+format → TWO drawtext filters:
 *         (1) "Thanks for watching"  — line 1, above center, larger font
 *         (2) LLM-generated CTA      — line 2, below center, slightly smaller
 *       Both share the SAME alpha expression: fade in over the first
 *       OUTRO_TEXT_FADE_IN seconds, hold at full opacity, fade out over the
 *       last OUTRO_TEXT_FADE_OUT seconds (subtle, non-flashy per spec).
 *   - Output: 1920×1080, 30fps, h264, yuv420p, NO audio (muxed in Pass 2).
 *
 * Memory profile: identical to a regular image clip + the title card (~100MB
 * peak) — single image, single pass, no full-frame buffering. Two drawtext
 * filters add only the glyph atlas + text bitmaps (small).
 *
 * The outro does NOT bake fade-in/fade-out on the BACKGROUND (just the text)
 * so the darkened image is steady throughout the 3.5s — the Pass 2 xfade
 * (transition='fade') handles the visual blend from the last clip.
 */
function buildOutroArgs(
  imagePath: string,
  outPath: string,
  duration: number,
  thanksTextFilePath: string,
  ctaTextFilePath: string,
  geo: OutputGeometry
): string[] {
  // Shared alpha expression for both text lines.
  //   if t < FADE_IN:       alpha = t / FADE_IN          (fade in 0→1)
  //   else if t > FADE_OUT_START: alpha = max(0, 1 - (t - FADE_OUT_START) / FADE_OUT)  (fade out 1→0)
  //   else:                 alpha = 1                     (full opacity)
  const fadeInEnd = OUTRO_TEXT_FADE_IN
  const fadeOutStart = Math.max(fadeInEnd, duration - OUTRO_TEXT_FADE_OUT)
  const alphaExpr =
    `if(lt(t,${fadeInEnd.toFixed(3)}),t/${fadeInEnd.toFixed(3)},` +
    `if(gt(t,${fadeOutStart.toFixed(3)}),` +
    `max(0,1-(t-${fadeOutStart.toFixed(3)})/${OUTRO_TEXT_FADE_OUT.toFixed(3)}),1))`

  const lineGap = OUTRO_LINE_GAP * geo.fontScale
  const filterComplex =
    // Scale + pad to the target geometry (so any source image aspect fits).
    `scale=${geo.w}:${geo.h}:force_original_aspect_ratio=decrease,` +
    `pad=${geo.w}:${geo.h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,` +
    // Heavy blur on the background image — so the text is readable.
    `boxblur=${OUTRO_BLUR_RADIUS}:1,` +
    // Dark overlay (slightly darker than title for "end" feel).
    `drawbox=0:0:${geo.w}:${geo.h}:color=black@${OUTRO_DARKEN_ALPHA}:t=fill,` +
    `fps=${geo.fps},format=yuv420p,` +
    // Line 1: "Thanks for watching" — above center.
    `drawtext=` +
    `fontfile=${OUTRO_FONT_FILE}:` +
    `textfile=${thanksTextFilePath}:` +
    `fontcolor=white:` +
    `fontsize=${OUTRO_LINE1_FONT_SIZE * geo.fontScale}:` +
    `borderw=${4 * geo.fontScale}:` +
    `bordercolor=black@0.88:` +
    `shadowx=${2 * geo.fontScale}:shadowy=${2 * geo.fontScale}:shadowcolor=black@0.65:` +
    `x=(w-text_w)/2:` +
    `y=(h/2)-(text_h)-${lineGap}:` +
    `alpha='${alphaExpr}',` +
    // Line 2: LLM-generated CTA — below center, slightly smaller.
    `drawtext=` +
    `fontfile=${OUTRO_FONT_FILE}:` +
    `textfile=${ctaTextFilePath}:` +
    `fontcolor=white:` +
    `fontsize=${OUTRO_LINE2_FONT_SIZE * geo.fontScale}:` +
    `borderw=${3 * geo.fontScale}:` +
    `bordercolor=black@0.88:` +
    `shadowx=${2 * geo.fontScale}:shadowy=${2 * geo.fontScale}:shadowcolor=black@0.65:` +
    `x=(w-text_w)/2:` +
    `y=(h/2)+${lineGap}:` +
    `alpha='${alphaExpr}'`

  return [
    '-y', '-hide_banner',
    '-framerate', String(geo.fps),
    '-loop', '1',
    '-t', duration.toFixed(3),
    '-i', imagePath,
    '-vf', filterComplex,
    '-c:v', 'libx264',
    // SPEED: 1080p uses veryfast (~2× faster than medium); 4K keeps medium.
    '-preset', geo.fontScale > 1 ? 'medium' : 'veryfast',
    '-crf', geo.fontScale > 1 ? '24' : '23',
    '-pix_fmt', 'yuv420p',
    // SPEED: explicit -threads 2 (uses both CPU cores per clip encode).
    '-threads', '2',
    '-r', String(geo.fps),
    '-an',
    '-movflags', '+faststart',
    outPath
  ]
}

// ─── Ken Burns Effect (Phase 5A) ────────────────────────────────────────────────
//
// Varies the zoom/pan direction per-clip so the motion pattern doesn't repeat.
// Deterministic by clip index — reproducible across runs.
//
// Implementation notes:
//   - zoompan with `d=1` emits one output per input frame; `on` is the
//     monotonic output frame counter (0 .. totalFrames-1).
//   - With `-framerate 30 -loop 1 -t <dur> -i img`, the input provides
//     exactly `totalFrames = dur*30` frames, so `on` covers the whole clip.
//   - z, x, y are expressions evaluated per output frame.
//   - For panning to be possible, z must be > 1 (so there's "extra" image
//     area to pan within). We keep z constant at KB_MAX_ZOOM for pan-only
//     variants and ramp z between 1.0 and KB_MAX_ZOOM for zoom variants.
//   - All expressions are wrapped in single quotes inside the filter chain;
//     the zoompan options themselves are colon-separated.

type KenBurnsVariant =
  | 'zoom-in'
  | 'zoom-out'
  | 'pan-right'
  | 'pan-left'
  | 'pan-up'
  | 'pan-down'
  | 'zoom-in-pan-right'
  | 'zoom-out-pan-left'

const KB_VARIANTS: KenBurnsVariant[] = [
  'zoom-in',
  'pan-right',
  'zoom-out',
  'pan-left',
  'zoom-in-pan-right',
  'pan-down',
  'zoom-out-pan-left',
  'pan-up'
]

function getKenBurnsVariant(clipIndex: number): KenBurnsVariant {
  return KB_VARIANTS[clipIndex % KB_VARIANTS.length]
}

/**
 * Build the zoompan filter string for the given variant. The expressions are
 * parameterised by `totalFrames` so that the motion completes exactly over
 * the clip duration.
 *
 * Convention for centered x/y when zooming:
 *   x = iw/2 - (iw/zoom)/2 = (iw - iw/zoom) / 2  → center the zoomed view
 *   y = ih/2 - (ih/zoom)/2 = (ih - ih/zoom) / 2  → center the zoomed view
 *
 * For panning, the x/y range is [0, iw - iw/zoom] (the slack left over by the
 * zoom). We move within this range using `on/totalFrames` as the [0..1]
 * progress.
 */
function buildKenBurnsFilter(variant: KenBurnsVariant, totalFrames: number, geo: OutputGeometry): string {
  const zMax = KB_MAX_ZOOM.toFixed(4)
  const t = totalFrames
  // Centered (x, y) expressions — keep the zoomed region in the middle of
  // the source frame.
  const cx = '(iw-iw/zoom)/2'
  const cy = '(ih-ih/zoom)/2'
  // End-of-range expressions for panning — clamped via min() so we never
  // exceed the slack available at the current zoom level.
  const xEnd = 'iw-iw/zoom'
  const yEnd = 'ih-ih/zoom'

  // Common zoompan options: d=1 (one output per input frame), fps from geo,
  // output size from geo (1920x1080 at 1080p, 3840x2160 at 4K).
  const common = `:d=1:fps=${geo.fps}:s=${geo.w}x${geo.h}`

  // Note: ffmpeg expressions inside zoompan must use single quotes for the
  // whole z=... value, and the entire filter chain is comma-separated. We
  // build the inner expression with the values above.
  switch (variant) {
    case 'zoom-in':
      // Zoom 1.0 → zMax, centered.
      return `zoompan=z='1+(${zMax}-1)*on/${t}':x='${cx}':y='${cy}'${common}`

    case 'zoom-out':
      // Zoom zMax → 1.0, centered.
      return `zoompan=z='${zMax}-(${zMax}-1)*on/${t}':x='${cx}':y='${cy}'${common}`

    case 'pan-right':
      // Constant zoom, pan from left (x=0) to right (x=xEnd).
      return `zoompan=z='${zMax}':x='${xEnd}*on/${t}':y='${cy}'${common}`

    case 'pan-left':
      // Constant zoom, pan from right (x=xEnd) to left (x=0).
      return `zoompan=z='${zMax}':x='${xEnd}*(1-on/${t})':y='${cy}'${common}`

    case 'pan-up':
      // Constant zoom, pan from bottom (y=yEnd) to top (y=0).
      return `zoompan=z='${zMax}':x='${cx}':y='${yEnd}*(1-on/${t})'${common}`

    case 'pan-down':
      // Constant zoom, pan from top (y=0) to bottom (y=yEnd).
      return `zoompan=z='${zMax}':x='${cx}':y='${yEnd}*on/${t}'${common}`

    case 'zoom-in-pan-right':
      // Zoom 1.0 → zMax while panning right. As zoom grows, xEnd shrinks
      // (because iw/zoom grows), so we clamp x to the current xEnd.
      return `zoompan=z='1+(${zMax}-1)*on/${t}':x='min((${xEnd})*on/${t},iw-iw/zoom)':y='${cy}'${common}`

    case 'zoom-out-pan-left':
      // Zoom zMax → 1.0... wait — at z=1.0 there's no pan slack. So we ramp
      // from z=zMax+0.03 down to zMax-0.03, keeping a small but constant pan
      // budget, while panning left.
      // (We avoid z=1 entirely so panning stays valid throughout.)
      return `zoompan=z='${zMax}+0.03-0.06*on/${t}':x='min((${xEnd})*(1-on/${t}),iw-iw/zoom)':y='${cy}'${common}`

    default: {
      // Exhaustive guard — TypeScript will error if a variant is unhandled.
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}

/**
 * Pass 2: Concatenate all pre-rendered clips + mux the audio in.
 *
 * Uses the concat demuxer (-f concat -safe 0 -i list.txt) which streams the
 * clips sequentially rather than buffering them all in memory. The video
 * stream is COPIED (no re-encode) — only the audio is encoded (AAC).
 *
 * When `musicPath` is provided, the music is added as a third input (looped
 * infinitely at the demuxer level via `-stream_loop -1` — no buffer memory),
 * and sidechain compression is applied so the music ducks under the voiceover:
 *   - The voiceover is the sidechain key (controls the compressor).
 *   - The music is the main signal (gets compressed when voice is active).
 *   - Mix: voice @ 1.0 + ducked music @ 0.55.
 *   - Final 1s fade-out on the mixed audio so the ending is graceful.
 *
 * Phase 6 P2 — when `audioDelay > 0` (the title card is enabled), the voiceover
 * audio is delayed by `audioDelay` seconds via the `adelay` filter so the title
 * card plays silently at the start of the video (or with music at full volume
 * — the sidechain compressor only ducks when voice is active, so the title
 * card intro naturally gets full music). The `-t` flag is extended to
 * `audioDuration + audioDelay` so the muxed output covers the title card +
 * the full voiceover.
 */
function buildConcatArgs(
  listPath: string,
  audioPath: string,
  outPath: string,
  totalDuration: number,
  musicPath?: string | null,
  audioDelay: number = 0,
  outroDuration: number = 0
): string[] {
  const baseArgs = [
    '-y', '-hide_banner',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,    // input 0: video clips (concatenated)
    '-i', audioPath     // input 1: voiceover
  ]

  // Phase 6 P3 — when the outro is enabled, we use a slightly longer fade-out
  // (1.5s) for a graceful end. Without the outro, keep the existing 1s fade.
  const fadeOutDuration = outroDuration > 0 ? 1.5 : 1
  // The fade-out is anchored to the END of the output (the actual video stream
  // duration, which includes the title card + voiceover + outro).
  const fadeOutStart = Math.max(0, totalDuration - fadeOutDuration).toFixed(3)

  // Phase 6 P3 — the voice chain needs `apad=whole_dur=totalDuration` when
  // the outro is enabled, so the voiceover audio stream is padded with
  // silence through the outro (matching the video length). Without the outro,
  // apad is skipped (the voice naturally ends at totalDuration).
  const needsDelay = audioDelay > 0
  const needsPad = outroDuration > 0
  const needsVoiceChain = needsDelay || needsPad

  if (musicPath) {
    // input 2: background music — loop infinitely at demuxer level (memory-free).
    // We rely on `-t totalDuration` to terminate (when outro is on, `-shortest`
    // is omitted because the looped music is infinite; when outro is off, we
    // keep `-shortest` as a safety cap).
    baseArgs.push('-stream_loop', '-1', '-i', musicPath)

    // Build the audio filter graph.
    //
    //   [1:a] is the voiceover (also used as the sidechain key).
    //   [2:a] is the music (gets compressed when voice is active).
    //
    // Voice chain (when title card OR outro is enabled):
    //   [1:a] --> adelay(delay)  [title card — silent intro]
    //         --> apad(whole_dur=totalDuration)  [outro — silent tail]
    //         --> asplit=2 --> [v1] (sidechain key) + [v2] (mix input)
    //
    // Filter chain:
    //   [1:a] --> adelay --> apad --> asplit=2 --> [v1] -----+
    //                                          --> [v2] ---+ (mix input)
    //                                                         |
    //   [2:a] --> sidechaincompress(key=[v1]) --> [duck] ----+
    //                                                         v
    //                                          amix(1.0, 0.55, duration=first) --> [amix]
    //                                                                         |
    //                                                                         v
    //                                                  afade(out, fadeOutStart, fadeOutDuration) --> [aout]
    //
    // Result: during voiceover, music is auto-ducked (≈1/6 of its makeup-gained
    // volume). During silent intro/outro (incl. title card + outro end card),
    // music plays at full makeup gain (the padded silence is still "voice
    // active = no ducking" because the sidechain key sees silence → no
    // compression). The final afade gracefully fades the music out over the
    // last 1.5s of the outro.
    const voiceLabel = needsVoiceChain ? '[v1]' : '[1:a]'
    const mixLabel = needsVoiceChain ? '[v2]' : '[1:a]'
    const filters: string[] = []
    if (needsVoiceChain) {
      const delayMs = Math.round(audioDelay * 1000)
      // Build the voice filter chain. FFmpeg filter graph syntax is:
      //   [input]filter1,filter2,...[output]
      // The input label has NO comma after it, filters are comma-separated,
      // and the output label attaches directly to the LAST filter. (Using
      // parts.join(',') with the input label as a "part" would insert a
      // spurious comma after [1:a], which FFmpeg parses as an empty filter
      // name → "Filter not found" error.)
      const chainParts: string[] = []
      if (needsDelay) {
        // adelay takes per-channel delays in ms, separated by `|`. For stereo
        // (the common case) we delay both channels by the same amount.
        chainParts.push(`adelay=${delayMs}|${delayMs}`)
      }
      if (needsPad) {
        // apad pads the voice with silence to exactly `totalDuration` so the
        // audio stream matches the video length through the outro.
        chainParts.push(`apad=whole_dur=${totalDuration.toFixed(3)}`)
      }
      // asplit=2 clones the (delayed+padded) voice into [v1] (sidechain key)
      // + [v2] (mix input) — FFmpeg auto-clones INPUT pads but NOT filter
      // outputs, so we need the explicit asplit before referencing [v1]/[v2].
      chainParts.push('asplit=2[v1][v2]')
      filters.push(`[1:a]${chainParts.join(',')}`)
    }
    filters.push(
      // Music (2:a) is compressed by the sidechain key (delayed/padded voice).
      `[2:a]${voiceLabel}sidechaincompress=threshold=0.05:ratio=6:attack=0.02:release=0.4:makeup=2.5[duck]`,
      // Mix voice + ducked music. weights='1 0.55' = voice 100%, music 55%.
      // duration=first = end the mix when the FIRST input (voice) ends. With
      // apad (outro), the padded voice ends at totalDuration, so the mix ends
      // at totalDuration — the music continues through the outro (mixed with
      // the padded silence = music at full ducked volume) and ends with the
      // afade at fadeOutStart.
      `${mixLabel}[duck]amix=inputs=2:duration=first:weights=1 0.55:normalize=0[amix]`,
      // Graceful fade-out at the end (1s without outro, 1.5s with outro).
      `[amix]afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}[aout]`
    )
    const filterComplex = filters.join(';')

    baseArgs.push(
      '-filter_complex', filterComplex,
      '-map', '0:v',         // video stream from concat (copied, not re-encoded)
      '-map', '[aout]',     // mixed audio
      '-c:v', 'copy',       // stream copy — no re-encode, minimal memory
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      // When the outro is enabled, omit `-shortest` (the looped music is
      // infinite; -t totalDuration caps the output). Without the outro, keep
      // `-shortest` (existing behaviour — both inputs end at totalDuration).
      ...(needsPad ? [] : ['-shortest']),
      '-t', totalDuration.toFixed(3),
      '-movflags', '+faststart',
      outPath
    )
  } else {
    // No music — voiceover is the only audio.
    if (needsVoiceChain) {
      // Delay the voiceover (title card) AND/OR pad it with silence (outro).
      // FFmpeg filter graph syntax: [input]filter1,filter2,...[output] — the
      // input label has NO comma after it, and the output label attaches to
      // the last filter. (See the music branch above for the full rationale.)
      const delayMs = Math.round(audioDelay * 1000)
      const chainParts: string[] = []
      if (needsDelay) chainParts.push(`adelay=${delayMs}|${delayMs}`)
      if (needsPad) chainParts.push(`apad=whole_dur=${totalDuration.toFixed(3)}`)
      // The [aout] output label attaches to the LAST filter in the chain.
      const filterStr = `[1:a]${chainParts.join(',')}[aout]`
      baseArgs.push(
        '-filter_complex', filterStr,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-t', totalDuration.toFixed(3),
        '-movflags', '+faststart',
        outPath
      )
    } else {
      baseArgs.push(
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-shortest',
        '-t', totalDuration.toFixed(3),
        '-movflags', '+faststart',
        outPath
      )
    }
  }

  return baseArgs
}

/**
 * Phase 6 PART 1 — Sequential xfade build-up (MEMORY-SAFE).
 *
 * Builds ONE xfade transition between two seekable file inputs (the accumulated
 * base clip + the next clip). Each call opens only 2 file inputs, so FFmpeg
 * streams the transition overlap (just ~TD seconds of frames held + encoder
 * lookahead ≈ 600MB peak) and the accumulated base is re-read from disk on
 * demand (seekable, not buffered). Memory therefore stays flat regardless of N.
 *
 * Why not a single chained-xfade filter_complex? A chain like
 *   [0:v][1:v]xfade[vx1];[vx1][2:v]xfade[vx2];...
 * makes the intermediate `vx1` a NON-SEEKABLE filter output. xfade needs to
 * "seek" within its first input to reach the transition offset, but it cannot
 * seek a filter output backwards — so FFmpeg must buffer the entire `vx1`
 * stream in memory. For N=6 clips at 1920×1080×30fps that's already ~6GB → OOM.
 * The sequential file-based approach sidesteps this: every input is a real file.
 *
 * The video is RE-ENCODED each step (libx264 crf 20 — slightly higher quality
 * than the final-pass crf 23 to minimise generation loss across N-1 steps).
 * For small N (≤ ~15, the typical short-script case) the loss is negligible;
 * for very large N a chunked + stream-copy approach would be preferable
 * (future optimisation — the current concat path remains the default for big N).
 *
 * Offset = current base duration - TD (transition begins TD before base ends).
 */
function buildSequentialXfadeArgs(
  baseClip: string,
  nextClip: string,
  offset: number,
  transition: TransitionType,
  outPath: string
): string[] {
  return [
    '-y', '-hide_banner',
    '-i', baseClip,
    '-i', nextClip,
    '-filter_complex',
    `[0:v][1:v]xfade=transition=${transition}:duration=${TRANSITION_DURATION.toFixed(3)}:offset=${offset.toFixed(3)}[v]`,
    '-map', '[v]',
    '-c:v', 'libx264',
    // SPEED: veryfast (~2× faster than medium). xfade is run for EVERY step
    // (N-1 times), so the per-step speed-up compounds across the whole Pass-2
    // build-up. CRF stays at 20 (slightly higher quality than Pass 1's CRF 23)
    // to minimise generation loss across N-1 re-encodes.
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    // SPEED: explicit -threads 2 so the xfade re-encode uses both CPU cores.
    '-threads', '2',
    '-r', String(OUT_FPS),
    '-an', // no audio (muxed in the final step)
    '-movflags', '+faststart',
    outPath
  ]
}

/**
 * Run an FFmpeg process with stderr parsing + tail-buffering for diagnostics.
 * Returns when the process exits. Rejects on non-zero exit code.
 */
function runFFmpeg(
  args: string[],
  onProgress?: (secondsEncoded: number) => void,
  onStderr?: (line: string) => void
): Promise<{ tail: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderrBuffer = ''
    const tailLines: string[] = []

    const handleStderr = (chunk: Buffer): void => {
      stderrBuffer += chunk.toString()
      let nl: number
      while ((nl = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, nl).trim()
        stderrBuffer = stderrBuffer.slice(nl + 1)
        if (!line) continue

        tailLines.push(line)
        if (tailLines.length > 40) tailLines.shift()

        onStderr?.(line)

        const t = parseTimeToSeconds(line)
        if (t !== null) onProgress?.(t)
      }
    }

    proc.stderr?.on('data', handleStderr)
    proc.stdout?.on('data', () => {
      /* drain stdout silently */
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to launch FFmpeg: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ tail: tailLines })
      } else {
        // code === null means killed by signal (e.g. OOM SIGKILL)
        const reason =
          code === null
            ? `FFmpeg was killed by signal ${signal ?? '(unknown)'} — likely OOM.`
            : `FFmpeg exited with code ${code}.`
        reject(
          new Error(
            `${reason} ` +
              (tailLines.length ? `Last line: ${tailLines[tailLines.length - 1]}` : '')
          )
        )
      }
    })
  })
}

export async function runVideoAssembly(job: VideoJob, params: AssembleParams): Promise<void> {
  const jobDir = path.join(VIDEO_DIR_ROOT, job.id)
  fs.mkdirSync(jobDir, { recursive: true })

  const outputPath = path.join(jobDir, 'output.mp4')
  const audioExt = params.audioMime.includes('wav') ? 'wav' : params.audioMime.includes('ogg') ? 'ogg' : 'mp3'
  const stagedAudio = path.join(jobDir, `audio.${audioExt}`)
  const clipsDir = path.join(jobDir, 'clips')
  fs.mkdirSync(clipsDir, { recursive: true })

  try {
    // ── Stage 1: prepare inputs ──────────────────────────────────────────────
    job.stage = 'preparing'
    job.startedAt = Date.now()

    // Phase 6 P4 — output resolution. Compute the geometry ONCE and thread it
    // through every Pass-1 builder (per-clip, title-card, outro). Pass 2
    // (xfade + concat/mux) inherits whatever resolution Pass-1 produced — no
    // change needed there.
    const geo = getOutputGeometry(params.resolution)
    job.resolution = params.resolution === '4k' ? '4k' : '1080p'
    console.log(`[video] Resolution: ${geo.label} (fontScale=${geo.fontScale})`)

    // Verify every image exists on disk before we start a long encode.
    const imagePaths: string[] = []
    for (let i = 0; i < params.imageCount; i++) {
      const p = getImagePath(params.imageJobId, i)
      if (!fs.existsSync(p)) {
        throw new Error(
          `Image #${i} is missing on disk (job ${params.imageJobId}). Generate the AI images first.`
        )
      }
      imagePaths.push(p)
    }

    if (!fs.existsSync(params.audioPath)) {
      throw new Error('Voiceover audio file is missing. Generate the voiceover first.')
    }

    // Stage the audio into the job dir (so the path is stable + discoverable).
    fs.copyFileSync(params.audioPath, stagedAudio)

    // ── Stage 2a: per-image clip encoding (Pass 1) ───────────────────────────
    job.stage = 'assembling'

    // Phase 5B — variable pacing: if we have at least `imageCount` script
    // segments, distribute the voiceover duration proportionally to each
    // segment's character count (clamped to [3, 5]s). Otherwise fall back to
    // the legacy fixed 4s-per-image pacing.
    const hasSegments = Array.isArray(params.segments) && params.segments.length >= params.imageCount
    const segments = hasSegments
      ? (params.segments as string[]).slice(0, params.imageCount)
      : new Array(params.imageCount).fill('')

    // Phase 6 P1 — Smart Transitions. Only active when there are >= 2 clips
    // (a single clip has no boundaries to transition between).
    const transitionsEnabled = !!params.transitionsEnabled && imagePaths.length > 1

    // When transitions are ON, the xfade filter in Pass 2 overlaps each pair
    // of clips by TRANSITION_DURATION seconds, which SHORTENS the total video by
    // (N-1)*TD. Inflate the per-clip duration budget by exactly that slack so
    // the final video still matches the voiceover length.
    const transitionOverlap = transitionsEnabled ? (imagePaths.length - 1) * TRANSITION_DURATION : 0
    const effectiveDuration = params.audioDuration + transitionOverlap

    const durations = hasSegments
      ? computeVariableDurations(segments, effectiveDuration)
      : computeFixedDurations(params.imageCount, effectiveDuration)

    // Compute the content-aware transition type for each boundary (clip i → i+1).
    const transitionTypes: TransitionType[] = []
    if (transitionsEnabled) {
      for (let i = 0; i < imagePaths.length - 1; i++) {
        transitionTypes.push(chooseTransition(segments[i] || '', segments[i + 1] || '', i))
      }
    }

    const captionsEnabled = !!params.captionsEnabled && hasSegments
    const captionsDir = captionsEnabled ? path.join(jobDir, 'captions') : ''
    if (captionsEnabled) fs.mkdirSync(captionsDir, { recursive: true })

    // Phase 6 P2 — Title card + text highlights state.
    //
    // Title card: only enabled when BOTH `titleCardEnabled` is true AND the
    // LLM produced a non-empty `titleCardText`. The card is encoded once (using
    // the FIRST image as background) and prepended to the concat/xfade chain.
    // The voiceover audio is delayed by TITLE_CARD_DURATION via `adelay` so the
    // card plays silently (or with music at full volume when music is enabled).
    //
    // Text highlights: only enabled when BOTH `textHighlightsEnabled` is true
    // AND the LLM produced a non-empty `textHighlights` array. The highlights
    // are mapped by segmentIndex for O(1) lookup per-clip during Pass 1.
    const titleCardEnabled =
      !!params.titleCardEnabled &&
      typeof params.titleCardText === 'string' &&
      params.titleCardText.trim().length > 0
    const titleCardText = titleCardEnabled ? (params.titleCardText as string).trim() : ''

    const highlightsEnabled =
      !!params.textHighlightsEnabled &&
      Array.isArray(params.textHighlights) &&
      params.textHighlights.length > 0

    // Map: segmentIndex → highlight text. (The LLM is constrained to at most 5
    // highlights, and parseHighlights de-duplicates by segmentIndex.)
    const highlightByIndex = new Map<number, string>()
    if (highlightsEnabled) {
      for (const h of params.textHighlights as TextHighlight[]) {
        if (
          typeof h.segmentIndex === 'number' &&
          h.segmentIndex >= 0 &&
          h.segmentIndex < params.imageCount &&
          typeof h.text === 'string' &&
          h.text.trim().length > 0
        ) {
          highlightByIndex.set(h.segmentIndex, h.text.trim())
        }
      }
    }
    // Re-sync the job record (in case the LLM returned fewer than expected).
    job.textHighlightsApplied = highlightsEnabled && highlightByIndex.size > 0
    job.textHighlightsCount = highlightByIndex.size

    // Per-clip highlight textfile directory (mirrors the captions dir pattern
    // — avoids FFmpeg's drawtext quoting/escaping pitfalls).
    const highlightsDir =
      job.textHighlightsApplied ? path.join(jobDir, 'highlights') : ''
    if (job.textHighlightsApplied) fs.mkdirSync(highlightsDir, { recursive: true })

    const titleCardClipPath = path.join(jobDir, 'title-card.mp4')
    const titleCardTextFile = path.join(jobDir, 'title-card.txt')

    // Phase 6 P3 — Outro End Card. Only enabled when BOTH `outroEnabled` is
    // true AND the caller passed a non-empty `outroCtaText`. The outro is
    // encoded once (using the LAST image as background) and appended to the
    // concat/xfade chain. The voiceover audio is padded with `apad` silence
    // through the outro so the audio stream matches the video length, and the
    // music (if enabled) continues through the outro, fading out at the end.
    const outroEnabled =
      !!params.outroEnabled &&
      typeof params.outroCtaText === 'string' &&
      params.outroCtaText.trim().length > 0
    const outroCtaText = outroEnabled ? (params.outroCtaText as string).trim() : ''
    // Re-sync the job record (the API route already resolved the LLM/fallback
    // CTA, so this is just a consistency guard).
    job.outroApplied = outroEnabled
    job.outroCtaText = outroEnabled ? outroCtaText : undefined

    const outroClipPath = path.join(jobDir, 'outro.mp4')
    const outroThanksFile = path.join(jobDir, 'outro-thanks.txt')
    const outroCtaFile = path.join(jobDir, 'outro-cta.txt')

    const clipPaths: string[] = imagePaths.map((_, i) => path.join(clipsDir, `clip-${String(i).padStart(3, '0')}.mp4`))

    const kbEnabled = KEN_BURNS_ENABLED
    console.log(
      `[video] Job ${job.id}: starting Pass 1 (encoding ${imagePaths.length} clips, ` +
      `${params.audioDuration.toFixed(1)}s audio, Ken Burns=${kbEnabled ? 'ON' : 'OFF'}` +
      `${params.musicPath ? `, music=ON` : ', music=OFF'}` +
      `, captions=${captionsEnabled ? 'ON' : 'OFF'}` +
      `, transitions=${transitionsEnabled ? `ON (${transitionTypes.length} xfade)` : 'OFF'}` +
      `, titleCard=${titleCardEnabled ? `ON ("${titleCardText.slice(0, 40)}${titleCardText.length > 40 ? '…' : ''}")` : 'OFF'}` +
      `, highlights=${job.textHighlightsApplied ? `ON (${highlightByIndex.size})` : 'OFF'}` +
      `, outro=${outroEnabled ? `ON ("${outroCtaText.slice(0, 40)}${outroCtaText.length > 40 ? '…' : ''}")` : 'OFF'}` +
      `, pacing=${hasSegments ? 'VARIABLE' : 'FIXED'}` +
      `, resolution=${geo.label}) — two-pass memory-bounded pipeline` +
      `${geo.fontScale > 1 ? ' [4K: ~2-3× slower + ~4× memory]' : ''}`
    )

    // Phase 6 P2 — Pre-encode the TITLE CARD clip (before the N image clips)
    // if enabled. Same memory profile as a regular clip (~100MB peak — single
    // image, single pass, no full-frame buffering).
    if (titleCardEnabled) {
      fs.writeFileSync(titleCardTextFile, titleCardText, 'utf-8')
      const titleArgs = buildTitleCardArgs(
        imagePaths[0],
        titleCardClipPath,
        TITLE_CARD_DURATION,
        titleCardTextFile,
        geo
      )
      try {
        await runFFmpeg(titleArgs)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Pass 1 (title card) failed: ${msg}`)
      }
    }

    // Phase 6 P3 — Pre-encode the OUTRO END CARD clip (after the title card,
    // before the N image clips — order doesn't matter here since both are
    // standalone single-image encodes). Uses the LAST image as the blurred+
    // darkened background. Same memory profile as the title card (~100MB peak).
    if (outroEnabled) {
      fs.writeFileSync(outroThanksFile, 'Thanks for watching', 'utf-8')
      fs.writeFileSync(outroCtaFile, outroCtaText, 'utf-8')
      const outroArgs = buildOutroArgs(
        imagePaths[imagePaths.length - 1],
        outroClipPath,
        OUTRO_DURATION,
        outroThanksFile,
        outroCtaFile,
        geo
      )
      try {
        await runFFmpeg(outroArgs)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Pass 1 (outro) failed: ${msg}`)
      }
    }

    // Encode clips in PARALLEL (Pass 1 worker pool — SPEED OPTIMIZATION
    // 2026-05-12). Replaces the old sequential loop. With 2-core sandboxes
    // this halves Pass 1 wall-clock time (44 clips × 1.8s sequential ≈ 80s →
    // 44/2 × 1.8s ≈ 40s parallel). Each parallel worker uses `-threads 1`
    // (passed via buildClipEncodeArgs's threads param) so 2 workers × 1 thread
    // = 2 libx264 threads on 2 cores — no oversubscription.
    //
    // Per-clip memory stays bounded at ~100MB peak. With 2 workers that's
    // ~200MB peak total — well within the sandbox memory budget.
    const PASS1_WEIGHT = 0.85 // Pass 1 default weight (legacy concat path)
    // Phase 6 P1 — when smart transitions are on, Pass 2 runs N-1 sequential
    // xfade re-encode steps (much heavier than the concat stream-copy), so give
    // Pass 1 a smaller progress share in that case.
    const useXfade = transitionsEnabled
    const pass1Weight = useXfade ? 0.5 : PASS1_WEIGHT
    // Phase 6 P2 — when the title card is enabled, the title card clip counts
    // as one extra Pass-1 unit. Add a small slice to Pass 1's budget.
    // Phase 6 P3 — same for the outro end card.
    const pass1Extra = (titleCardEnabled ? 0.04 : 0) + (outroEnabled ? 0.04 : 0)
    const pass1Base = pass1Weight - pass1Extra

    // ── Step 1: Pre-compute all per-clip args (CPU-only, fast, ~1ms/clip) ──
    // We do this BEFORE the parallel encode so the buildClipEncodeArgs call
    // (which writes caption + highlight textfiles) doesn't race with itself
    // across workers — different paths so safe, but easier to reason about
    // when separated. Each entry also carries its progress base.
    interface Pass1Task {
      idx: number
      args: string[]
      clipDuration: number
      baseProgress: number
    }
    const tasks: Pass1Task[] = []
    for (let i = 0; i < imagePaths.length; i++) {
      const clipDuration = durations[i]
      const kbVariant = kbEnabled ? getKenBurnsVariant(i) : undefined

      // Phase 5B — write the wrapped caption text to a per-clip file so
      // drawtext's textfile= option can read it without escaping headaches.
      let captionText = ''
      let captionFilePath: string | undefined
      if (captionsEnabled) {
        const wrapped = wrapCaption(segments[i] || '')
        if (wrapped) {
          captionText = wrapped
          captionFilePath = path.join(captionsDir, `cap-${String(i).padStart(3, '0')}.txt`)
          // drawtext reads textfile as UTF-8 by default. The literal newline
          // in the file becomes a line break in the rendered caption.
          fs.writeFileSync(captionFilePath, wrapped, 'utf-8')
        }
      }

      // Phase 6 P2 — write the highlight textfile for this clip if flagged.
      let highlightText = ''
      let highlightFilePath: string | undefined
      if (job.textHighlightsApplied && highlightByIndex.has(i)) {
        highlightText = highlightByIndex.get(i)!
        highlightFilePath = path.join(highlightsDir, `hl-${String(i).padStart(3, '0')}.txt`)
        fs.writeFileSync(highlightFilePath, highlightText, 'utf-8')
      }

      const args = buildClipEncodeArgs(
        imagePaths[i],
        clipPaths[i],
        clipDuration,
        kbVariant,
        captionText,
        captionFilePath,
        transitionsEnabled,
        i === 0,
        i === imagePaths.length - 1,
        highlightText,
        highlightFilePath,
        geo,
        // Pass 1 parallel mode: 1 thread per worker (avoids oversubscription
        // when 2 clips encode simultaneously).
        1
      )
      // Title card + outro already burned their Pass-1 units of progress;
      // offset the per-clip base so the math stays correct. (Each consumes
      // 0.04 of the total budget — pass1Extra captures both.)
      const titleCardProgress = titleCardEnabled ? 0.04 * 100 : 0
      const outroProgress = outroEnabled ? 0.04 * 100 : 0
      const baseProgress =
        (titleCardProgress + outroProgress) +
        (i / imagePaths.length) * pass1Base * 100
      tasks.push({ idx: i, args, clipDuration, baseProgress })
    }

    // ── Step 2: Run the worker pool (PASS1_PARALLEL_WORKERS concurrent) ──
    // A simple bounded concurrency pool: pull tasks from the front, run
    // up to W in parallel. Each completed clip updates its slice of progress.
    // ETA is recomputed from the aggregate progress.
    let nextTaskIdx = 0
    const completedClips = new Set<number>()
    const workerCount = Math.min(PASS1_PARALLEL_WORKERS, tasks.length)
    console.log(
      `[video] Job ${job.id}: Pass 1 parallel pool starting — ${tasks.length} clips, ` +
      `${workerCount} worker${workerCount === 1 ? '' : 's'} (threads=1/clip, both cores utilised)`
    )

    const runOneTask = async (task: Pass1Task): Promise<void> => {
      try {
        await runFFmpeg(
          task.args,
          (secondsEncoded) => {
            // Per-clip progress: clip duration is ~4s, so this is fine-grained.
            const clipPct = Math.min(1, secondsEncoded / task.clipDuration)
            const perClipShare = (pass1Base * 100 / imagePaths.length)
            const totalPct = task.baseProgress + clipPct * perClipShare
            // Aggregate progress: completed clips (full share) + the in-flight
            // workers' partial share. This gives a smooth, monotonic progress
            // curve even with multiple workers.
            let aggPct = (titleCardEnabled ? 0.04 * 100 : 0) + (outroEnabled ? 0.04 * 100 : 0)
            for (const doneIdx of completedClips) {
              aggPct += perClipShare
            }
            aggPct += clipPct * perClipShare
            // Use whichever is higher — the current worker's view or the
            // aggregate — so progress never goes backwards if a slow worker
            // reports before a fast one.
            const finalPct = Math.max(aggPct, totalPct)
            job.progress = Math.min(99, Math.round(finalPct))
            // ETA
            if (job.startedAt && finalPct > 1) {
              const elapsed = (Date.now() - job.startedAt) / 1000
              const remaining = (elapsed / finalPct) * (100 - finalPct)
              job.etaSeconds = Math.max(0, Math.round(remaining))
            }
          }
        )
        completedClips.add(task.idx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Pass 1 (clip ${task.idx + 1}/${imagePaths.length}) failed: ${msg}`)
      }
    }

    // Spawn workerCount workers; each pulls the next task until the queue
    // is drained. Errors propagate via Promise rejection.
    const workers: Promise<void>[] = []
    const runWorker = async (): Promise<void> => {
      while (true) {
        const taskIdx = nextTaskIdx++
        if (taskIdx >= tasks.length) return
        await runOneTask(tasks[taskIdx])
      }
    }
    for (let w = 0; w < workerCount; w++) {
      workers.push(runWorker())
    }
    try {
      await Promise.all(workers)
    } catch (err) {
      // The first rejection wins; the rest of the workers will finish their
      // in-flight clips before Promise.all resolves (we don't abort them).
      throw err
    }

    // ── Stage 2b: concat/xfade clips + mux audio (Pass 2) ──────────────────────
    // Phase 6 P1 — choose the Pass 2 strategy. When smart transitions are ON,
    // we build the video via a SEQUENTIAL xfade build-up (one transition at a
    // time, each step opening only 2 seekable file inputs — memory-safe). When
    // OFF, we use the concat demuxer (stream copy, fast, legacy behavior).
    //
    // Phase 6 P2 — when the title card is enabled, prepend it to the Pass 2
    // chain (xfade path: an extra xfade step titleCard→clip0; concat path:
    // an extra entry at the top of the list). The voiceover audio is delayed
    // by TITLE_CARD_DURATION via `adelay` so the title card plays silently (or
    // with music at full volume).
    //
    // Phase 6 P3 — when the outro is enabled, append it to the Pass 2 chain
    // (xfade path: an extra xfade step lastClip→outro with transition='fade';
    // concat path: an extra entry at the end of the list). The voiceover audio
    // is padded with `apad` silence through the outro, and the music (if on)
    // continues through the outro, fading out at the very end (1.5s).
    let listPath = ''

    const extraXfadeSteps = (titleCardEnabled ? 1 : 0) + (outroEnabled ? 1 : 0)
    console.log(
      `[video] Job ${job.id}: Pass 1 done — ${clipPaths.length} clips encoded` +
      `${titleCardEnabled ? ' + title card' : ''}${outroEnabled ? ' + outro' : ''}. ` +
      `Starting Pass 2 (${useXfade ? `xfade build-up (${imagePaths.length - 1 + extraXfadeSteps} sequential transitions)` : 'concat demuxer (stream copy)'}${params.musicPath ? ' + music ducking' : ''}${titleCardEnabled ? ' + title card (audio delayed)' : ''}${outroEnabled ? ' + outro (audio padded)' : ''}).`
    )
    job.progress = Math.round(pass1Weight * 100)

    if (useXfade) {
      // ── Pass 2a: sequential xfade build-up ──
      // Each step: xfade(currentBase, nextClip) → newBase. Two file inputs per
      // step → FFmpeg streams the transition (no intermediate buffering → no OOM).
      const interDir = path.join(jobDir, 'xfade-steps')
      fs.mkdirSync(interDir, { recursive: true })

      // Phase 6 P2 — when the title card is enabled, the title card is the
      // initial base. The first xfade step blends titleCard → clip0. Then
      // the remaining N-1 steps blend base → clip1..N-1 as before.
      let baseClip = titleCardEnabled ? titleCardClipPath : clipPaths[0]
      let baseDuration = titleCardEnabled ? TITLE_CARD_DURATION : durations[0]
      // Phase 6 P3 — when the outro is enabled, add one more xfade step at
      // the end (lastClip → outro). Total steps = (N-1) + title + outro.
      const stepsTotal = imagePaths.length - 1 + extraXfadeSteps
      // xfade steps get 90% of the Pass-2 budget; the final audio-mux gets 10%.
      const xfadeBudget = (1 - pass1Weight) * 0.9

      // The first clip to fold in is clip 0 if we have a title card (the title
      // card is the base); otherwise the first clip is already the base and
      // we start folding from clip 1.
      const startClipIdx = titleCardEnabled ? 0 : 1
      for (let i = 0; i < stepsTotal; i++) {
        // Phase 6 P3 — the LAST step (when outro is enabled) blends the
        // accumulated base → outro clip with a gentle 'fade' transition
        // (the last sharp clip → blurred outro is a single scene change, not
        // a topic shift — keep it subtle, mirroring the title card → clip0
        // boundary). All other steps use the existing logic (content-aware
        // transition for clip i → clip i+1, or 'fade' for title → clip0).
        const isOutroStep = outroEnabled && i === stepsTotal - 1
        let nextClip: string
        let nextDuration: number
        let transition: TransitionType
        if (isOutroStep) {
          nextClip = outroClipPath
          nextDuration = OUTRO_DURATION
          transition = 'fade'
        } else {
          const nextClipIdx = startClipIdx + i
          nextClip = clipPaths[nextClipIdx]
          nextDuration = durations[nextClipIdx]
          transition =
            titleCardEnabled && i === 0
              ? 'fade'
              : transitionTypes[(titleCardEnabled ? i - 1 : i)]
        }
        const offset = Math.max(0, baseDuration - TRANSITION_DURATION)
        const stepOut = path.join(interDir, `step-${String(i).padStart(3, '0')}.mp4`)
        const stepArgs = buildSequentialXfadeArgs(
          baseClip,
          nextClip,
          offset,
          transition,
          stepOut
        )
        const stepBase = pass1Weight * 100 + (i / stepsTotal) * xfadeBudget * 100
        const stepSpan = (xfadeBudget * 100) / stepsTotal
        try {
          await runFFmpeg(
            stepArgs,
            (secondsEncoded) => {
              const stepPct = Math.min(1, secondsEncoded / (baseDuration + nextDuration))
              job.progress = Math.min(99, Math.round(stepBase + stepPct * stepSpan))
            }
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`Pass 2 (xfade step ${i + 1}/${stepsTotal}) failed: ${msg}`)
        }
        // Clean up the previous intermediate to keep disk usage flat (keep the
        // latest step — it's the audio-mux input).
        if (i > 0) {
          const prev = path.join(interDir, `step-${String(i - 1).padStart(3, '0')}.mp4`)
          try { if (fs.existsSync(prev)) fs.unlinkSync(prev) } catch { /* ignore */ }
        }
        baseClip = stepOut
        baseDuration = baseDuration + nextDuration - TRANSITION_DURATION
      }

      // ── Pass 2b: mux audio (+ optional music ducking) into the final xfade ──
      // Stream-copy the video (already h264 from the xfade steps) — only audio
      // is encoded. Reuse the concat-demuxer path with a 1-entry list.
      listPath = path.join(jobDir, 'concat-list.txt')
      fs.writeFileSync(listPath, `file '${baseClip.replace(/'/g, "'\\''")}'\n`, 'utf-8')
      const muxBudget = (1 - pass1Weight) * 0.1
      const muxBase = (pass1Weight + xfadeBudget) * 100
      // Phase 6 P2 — delay the voiceover by TITLE_CARD_DURATION when the title
      // card is on, so it plays silently (or with full music) at the start.
      // Phase 6 P3 — pass the ACTUAL baseDuration (the accumulated video
      // stream duration after all xfade steps, including the title card +
      // outro) as the totalDuration so -t matches the video exactly (no
      // frozen-frame padding, no audio cut). The outroDuration flag tells
      // buildConcatArgs to use apad + the longer 1.5s fade-out.
      const audioDelay = titleCardEnabled ? TITLE_CARD_DURATION : 0
      const outroDur = outroEnabled ? OUTRO_DURATION : 0
      const muxArgs = buildConcatArgs(listPath, stagedAudio, outputPath, baseDuration, params.musicPath, audioDelay, outroDur)
      // The mux step encodes audio over the full baseDuration. Use it for
      // progress reporting (the actual output length = baseDuration).
      const muxTotalDuration = baseDuration
      try {
        await runFFmpeg(
          muxArgs,
          (secondsEncoded) => {
            const pct = Math.min(1, secondsEncoded / muxTotalDuration)
            job.progress = Math.min(99, Math.round(muxBase + pct * muxBudget * 100))
          }
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Pass 2 (audio mux after xfade) failed: ${msg}`)
      }
      // Clean up the last intermediate step now that it's muxed into output.
      try {
        const lastStep = path.join(interDir, `step-${String(stepsTotal - 1).padStart(3, '0')}.mp4`)
        if (fs.existsSync(lastStep)) fs.unlinkSync(lastStep)
        if (fs.existsSync(interDir)) fs.rmSync(interDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    } else {
      // ── Legacy concat-demuxer path (stream copy, fast) ──
      // Phase 6 P2 — prepend the title card to the concat list when enabled.
      // Phase 6 P3 — append the outro to the concat list when enabled.
      listPath = path.join(jobDir, 'concat-list.txt')
      const entries: string[] = []
      if (titleCardEnabled) {
        entries.push(`file '${titleCardClipPath.replace(/'/g, "'\\''")}'`)
      }
      entries.push(...clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`))
      if (outroEnabled) {
        entries.push(`file '${outroClipPath.replace(/'/g, "'\\''")}'`)
      }
      const listContent = entries.join('\n')
      fs.writeFileSync(listPath, listContent, 'utf-8')
      const audioDelay = titleCardEnabled ? TITLE_CARD_DURATION : 0
      const outroDur = outroEnabled ? OUTRO_DURATION : 0
      // Total output duration = title card (audioDelay) + voiceover + outro.
      // (For the concat path, there are no xfade overlaps — the video length
      //  exactly matches audioDelay + audioDuration + outroDuration.)
      const concatTotalDuration = params.audioDuration + audioDelay + outroDur
      const concatArgs = buildConcatArgs(listPath, stagedAudio, outputPath, concatTotalDuration, params.musicPath, audioDelay, outroDur)
      try {
        await runFFmpeg(
          concatArgs,
          (secondsEncoded) => {
            const pass2Pct = Math.min(1, secondsEncoded / concatTotalDuration)
            const totalPct = pass1Weight * 100 + pass2Pct * (1 - pass1Weight) * 100
            job.progress = Math.min(99, Math.round(totalPct))
          }
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Pass 2 (concat + audio) failed: ${msg}`)
      }
    }

    // ── Stage 3: finalize ────────────────────────────────────────────────────
    job.stage = 'finalizing'
    job.progress = 99

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg finished but the output MP4 is missing.')
    }

    const stat = fs.statSync(outputPath)
    if (stat.size < 10000) {
      throw new Error(`The output MP4 is suspiciously small (${stat.size} bytes). The encode likely failed.`)
    }

    const measuredDuration = await probeDuration(outputPath)

    // Phase 6 P4 — ffprobe-verify the output geometry. Confirms a 4K job
    // actually produced 3840×2160 (and a 1080p job produced 1920×1080). The
    // measured values are written to the job record so the UI can display
    // them in the done-summary chip.
    const measuredGeo = await probeVideoGeometry(outputPath)
    if (measuredGeo) {
      job.videoWidth = measuredGeo.width
      job.videoHeight = measuredGeo.height
      const expectedW = geo.w
      const expectedH = geo.h
      const matches = measuredGeo.width === expectedW && measuredGeo.height === expectedH
      console.log(
        `[video] Job ${job.id} geometry: ${measuredGeo.width}×${measuredGeo.height} (${measuredGeo.codec})` +
          ` — expected ${expectedW}×${expectedH} → ${matches ? 'MATCH ✓' : 'MISMATCH ✗'}`
      )
      if (!matches) {
        console.warn(
          `[video] WARNING: output geometry ${measuredGeo.width}×${measuredGeo.height} does not match the requested ${geo.label}.`
        )
      }
    }

    job.videoPath = outputPath
    job.fileSize = stat.size
    job.videoDuration = Math.round((measuredDuration || params.audioDuration) * 10) / 10
    job.progress = 100
    job.stage = 'done'
    job.status = 'done'
    job.doneAt = Date.now()
    job.etaSeconds = undefined

    console.log(
      `[video] Job ${job.id} DONE: ${(stat.size / (1024 * 1024)).toFixed(2)}MB, ${job.videoDuration}s, ${imagePaths.length} images, ${geo.label}`
    )

    // Clean up intermediate clips to free disk space (the final MP4 is
    // self-contained — clips are no longer needed). Also clean up the per-clip
    // caption text files (Phase 5B) since they're burned into the video.
    // Phase 6 P2 — also clean up the title card clip + its textfile + the
    // highlights textfile dir, all of which are burned into the final MP4.
    // Phase 6 P3 — also clean up the outro clip + its textfiles.
    try {
      for (const clip of clipPaths) {
        if (fs.existsSync(clip)) fs.unlinkSync(clip)
      }
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath)
      if (captionsDir && fs.existsSync(captionsDir)) {
        fs.rmSync(captionsDir, { recursive: true, force: true })
      }
      if (highlightsDir && fs.existsSync(highlightsDir)) {
        fs.rmSync(highlightsDir, { recursive: true, force: true })
      }
      if (titleCardEnabled) {
        if (fs.existsSync(titleCardClipPath)) fs.unlinkSync(titleCardClipPath)
        if (fs.existsSync(titleCardTextFile)) fs.unlinkSync(titleCardTextFile)
      }
      if (outroEnabled) {
        if (fs.existsSync(outroClipPath)) fs.unlinkSync(outroClipPath)
        if (fs.existsSync(outroThanksFile)) fs.unlinkSync(outroThanksFile)
        if (fs.existsSync(outroCtaFile)) fs.unlinkSync(outroCtaFile)
      }
    } catch {
      /* ignore cleanup errors */
    }
  } catch (err) {
    job.status = 'error'
    job.stage = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    job.doneAt = Date.now()
    console.error(`[video] Job ${job.id} FAILED:`, job.error)
    if (job.ffmpegTail) {
      console.error(`[video] FFmpeg stderr tail:\n${job.ffmpegTail}`)
    }
  } finally {
    // Clean up the staged audio (the MP4 is self-contained now).
    try {
      if (fs.existsSync(stagedAudio)) fs.unlinkSync(stagedAudio)
    } catch {
      /* ignore */
    }
  }
}

// ─── Public snapshot for API ───────────────────────────────────────────────────

export interface VideoJobSnapshot {
  jobId: string
  status: 'processing' | 'done' | 'error'
  stage: VideoStage
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
  /** 'on' if a title card clip was prepended to this video (Phase 6 P2). */
  titleCardApplied?: boolean
  /** The LLM-generated title text shown on the title card (for UI display). */
  titleCardText?: string
  /** 'on' if key-moment text highlights were burned into specific clips (Phase 6 P2). */
  textHighlightsApplied?: boolean
  /** Number of highlights applied (for UI display). */
  textHighlightsCount?: number
  /** 'on' if an outro end card clip was appended to this video (Phase 6 P3). */
  outroApplied?: boolean
  /** The LLM-generated (or fallback) CTA text shown on the outro end card (for UI display). */
  outroCtaText?: string
  /** Phase 6 P4 — output resolution ('1080p' default, or '4k'). */
  resolution?: OutputResolution
  /** Phase 6 P4 — measured output width (ffprobe-verified, for UI display). */
  videoWidth?: number
  /** Phase 6 P4 — measured output height (ffprobe-verified, for UI display). */
  videoHeight?: number
  error?: string
  createdAt: number
  doneAt?: number
}

export function snapshotJob(job: VideoJob): VideoJobSnapshot {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    imageCount: job.imageCount,
    audioDuration: job.audioDuration,
    fileSize: job.fileSize,
    videoDuration: job.videoDuration,
    etaSeconds: job.etaSeconds,
    kenBurnsApplied: job.kenBurnsApplied,
    musicLabel: job.musicLabel,
    captionsApplied: job.captionsApplied,
    variablePacingApplied: job.variablePacingApplied,
    transitionsApplied: job.transitionsApplied,
    titleCardApplied: job.titleCardApplied,
    titleCardText: job.titleCardText,
    textHighlightsApplied: job.textHighlightsApplied,
    textHighlightsCount: job.textHighlightsCount,
    outroApplied: job.outroApplied,
    outroCtaText: job.outroCtaText,
    resolution: job.resolution,
    videoWidth: job.videoWidth,
    videoHeight: job.videoHeight,
    error: job.error,
    createdAt: job.createdAt,
    doneAt: job.doneAt
  }
}

// ─── Helpers used by the API route ────────────────────────────────────────────

/** Write a base64 audio payload to a temp file and return its path. */
export function stageAudioFromBase64(jobDir: string, base64: string, mime: string): string {
  const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'mp3'
  const outPath = path.join(jobDir, `source-audio.${ext}`)
  fs.mkdirSync(jobDir, { recursive: true })
  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'))
  return outPath
}

export function getVideoOutputPath(jobId: string): string {
  return path.join(VIDEO_DIR_ROOT, jobId, 'output.mp4')
}

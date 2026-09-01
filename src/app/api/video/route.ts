import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'
import {
  createVideoJob,
  runVideoAssembly,
  getVideoJob,
  snapshotJob,
  stageAudioFromBase64,
  splitScriptIntoSegments,
  VIDEO_DIR_ROOT,
  type VideoJobSnapshot
} from '@/lib/video-assembly'
import {
  generateTitleCard,
  extractKeyHighlights,
  generateOutroCta
} from '@/lib/video-script-llm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── MULTI-USER: assembly concurrency gate ────────────────────────────────────
//
// Unlimited jobs are accepted; at most MAX_CONCURRENT_ASSEMBLES ffmpeg
// pipelines run simultaneously. Excess jobs wait in a FIFO (their polled
// snapshot shows a "queued" stage) and start as slots free. Cached on
// globalThis so dev HMR cannot fork the counter across module instances.
const MAX_CONCURRENT_ASSEMBLIES = 2
const gSem = globalThis as unknown as { __videoAssemblySem?: { active: number; queue: number[] } }
const SEM = (gSem.__videoAssemblySem ??= { active: 0, queue: [] })

/**
 * Run `runVideoAssembly` under the concurrency gate. Resolves when the job has
 * been STARTED (not finished) — identical fire-and-forget semantics to the old
 * direct call, plus queueing for the multi-user case.
 */
function enqueueAssembly(job: VideoJobT, params: AssembleParamsT): Promise<void> {
  return new Promise((resolve) => {
    const start = () => {
      SEM.active++
      resolve() // slot acquired — the caller's response goes out now
      runVideoAssembly(job, params)
        .catch((err) => {
          // runVideoAssembly handles its own error state; safety net only.
          job.status = 'error'
          job.stage = 'error'
          job.error = err instanceof Error ? err.message : String(err)
          console.error(`[video] Job ${job.id} crashed unexpectedly:`, job.error)
        })
        .finally(() => {
          SEM.active--
          const next = SEM.queue.shift()
          if (next) next()
        })
    }
    if (SEM.active < MAX_CONCURRENT_ASSEMBLIES) {
      start()
    } else {
      // Queued — mirror the wait into the job's own live snapshot.
      job.stage = 'queued — waiting for a free assembly slot'
      console.log(
        `[video] Job ${job.id} queued (${SEM.queue.length} waiting, ${SEM.active} assembling)`
      )
      SEM.queue.push(start)
    }
  })
}

// Local structural types (avoid importing the full internal VideoJob surface).
type VideoJobT = Parameters<typeof runVideoAssembly>[0]
type AssembleParamsT = Parameters<typeof runVideoAssembly>[1]

// ─── Music library (bundled, royalty-free) ──────────────────────────────────────
//
// Three 60-second MP3 tracks synthesised with FFmpeg's `aevalsrc` + LFO
// effects. Stored in /public/music/ — accessible both from the browser
// (via /music/<track>.mp3) and from the backend (via fs). Truly royalty-free
// because we generated them ourselves (no third-party licensing).

const MUSIC_LIBRARY_DIR = path.join(process.cwd(), 'public', 'music')
const MUSIC_UPLOAD_DIR = process.env.AUTOTUBE_MUSIC_DIR || '/tmp/autotube-music'

const LIBRARY_TRACKS = new Set(['calm', 'ambient', 'upbeat'])

/**
 * Resolve the music source from the request body to a concrete file path
 * (and a UI label). Returns { path: null, label: undefined } when no music
 * is requested.
 */
function resolveMusicPath(body: PostBody): { path: string | null; label: string | undefined } {
  if (!body.musicSource || body.musicSource === 'none') {
    return { path: null, label: undefined }
  }

  if (body.musicSource === 'library') {
    const track = body.musicTrack
    if (!track || !LIBRARY_TRACKS.has(track)) {
      throw new Error(`Unknown library track: "${track}". Available: calm, ambient, upbeat.`)
    }
    const p = path.join(MUSIC_LIBRARY_DIR, `${track}.mp3`)
    if (!fs.existsSync(p)) {
      throw new Error(`Library track "${track}" is missing on disk at ${p}.`)
    }
    return { path: p, label: track }
  }

  if (body.musicSource === 'upload') {
    const fileId = body.musicFileId
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      throw new Error('Invalid or missing musicFileId for uploaded music.')
    }
    // Try a few common extensions — the upload route saves with the original ext.
    const candidates = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']
    for (const ext of candidates) {
      const p = path.join(MUSIC_UPLOAD_DIR, `${fileId}.${ext}`)
      if (fs.existsSync(p)) {
        return { path: p, label: 'upload' }
      }
    }
    throw new Error(
      `Uploaded music file not found for fileId="${fileId}". The upload may have expired (TTL 1 hour).`
    )
  }

  throw new Error(`Unknown musicSource: "${body.musicSource}".`)
}

// ─── POST: start a video-assembly job ────────────────────────────────────────

interface PostBody {
  imageJobId?: string
  imageCount?: number
  audioBase64?: string
  audioDuration?: number
  mimeType?: string
  // Phase 5A — music:
  musicSource?: 'library' | 'upload' | 'none'
  musicTrack?: string
  musicFileId?: string
  // Phase 5B — captions + variable pacing:
  // The rewritten narration script. When captionsEnabled is true OR the
  // frontend wants variable pacing, this script is split into imageCount
  // sequential segments and used for both caption text + per-clip duration.
  script?: string
  captionsEnabled?: boolean
  // Phase 6 P1 — Smart Transitions. When true, Pass 2 uses FFmpeg xfade to
  // blend consecutive clips with content-aware transitions (gentle fade within
  // a scene, sharper slide/wipe on topic change). Default false.
  transitionsEnabled?: boolean
  // Phase 6 P2 — Title Card. When true, the backend calls the LLM to generate
  // a short catchy title from the rewritten script, encodes a 2.5s intro clip
  // (first image blurred+darkened + the title text), and prepends it to the
  // video. The voiceover is delayed by 2.5s via `adelay` so the card plays
  // silently (or with full music) at the start.
  titleCardEnabled?: boolean
  // Phase 6 P2 — Text Highlights. When true, the backend calls the LLM to
  // identify 3-5 key moments (stats, quotes) in the script, each anchored to a
  // segment index, then burns a bold yellow text overlay onto those specific
  // clips (fades in/out over the first ~2.5s, upper-third of the screen).
  textHighlightsEnabled?: boolean
  // Phase 6 P3 — Outro End Card. When true, the backend calls the LLM to
  // generate a short topic-relevant CTA (e.g. "Subscribe for more 1% habits"),
  // encodes a 3.5s outro clip (last image blurred+darkened + "Thanks for
  // watching" + the CTA, both fading in/out), and appends it to the video.
  // The voiceover is padded with `apad` silence through the outro, and the
  // music (if enabled) continues through the outro, fading out at the end.
  // If the LLM fails, the CTA falls back to "Subscribe for more" — the outro
  // is still applied (only the personalised CTA is lost).
  outroEnabled?: boolean
  // Phase 6 P4 — Output resolution. '1080p' (default) = 1920×1080 Full HD.
  // '4k' = 3840×2160 Ultra HD (~2-3× slower + ~4× per-clip memory; the two-pass
  // sequential pipeline keeps each step bounded so 4K won't OOM).
  resolution?: '1080p' | '4k'
}

export async function POST(req: NextRequest) {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // ── Validate ──
  if (!body.imageJobId || typeof body.imageJobId !== 'string') {
    return NextResponse.json({ error: '"imageJobId" is required (the AI-images job id).' }, { status: 400 })
  }
  if (!Number.isInteger(body.imageCount) || (body.imageCount as number) < 1 || (body.imageCount as number) > 400) {
    return NextResponse.json({ error: '"imageCount" must be an integer between 1 and 400.' }, { status: 400 })
  }
  if (!body.audioBase64 || typeof body.audioBase64 !== 'string') {
    return NextResponse.json({ error: '"audioBase64" is required (the voiceover audio).' }, { status: 400 })
  }
  if (typeof body.audioDuration !== 'number' || !Number.isFinite(body.audioDuration) || body.audioDuration < 1) {
    return NextResponse.json({ error: '"audioDuration" (seconds, >= 1) is required.' }, { status: 400 })
  }
  const mimeType = body.mimeType && typeof body.mimeType === 'string' ? body.mimeType : 'audio/mpeg'

  // ── Quick sanity: reject absurdly large audio payloads early ──
  // base64 length ≈ 4/3 * raw bytes. Allow up to ~60MB raw (~80MB b64).
  const MAX_AUDIO_BYTES = 60 * 1024 * 1024
  const approxBytes = Math.ceil((body.audioBase64.length * 3) / 4)
  if (approxBytes > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: `Audio payload too large (${(approxBytes / (1024 * 1024)).toFixed(1)}MB). Max ${MAX_AUDIO_BYTES / (1024 * 1024)}MB.` },
      { status: 413 }
    )
  }

  // ── Resolve music source (if any) ──
  let musicPath: string | null = null
  let musicLabel: string | undefined
  try {
    const resolved = resolveMusicPath(body)
    musicPath = resolved.path
    musicLabel = resolved.label
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    )
  }

  // ── Phase 5B — Split the script into imageCount segments ──
  // We do this when EITHER captions are enabled OR the script was provided
  // (since variable pacing also benefits from segments). When the script
  // is missing or too short, segments is empty and the assembly falls back
  // to fixed 4s-per-image pacing with no captions.
  const captionsEnabled = !!body.captionsEnabled
  const scriptText = typeof body.script === 'string' ? body.script.trim() : ''
  let segments: string[] = []
  if (scriptText.length >= 20 && (body.imageCount as number) > 0) {
    try {
      segments = splitScriptIntoSegments(scriptText, body.imageCount as number)
    } catch (err) {
      console.warn(
        `[video] Script segmentation failed (continuing without captions):`,
        err instanceof Error ? err.message : String(err)
      )
      segments = []
    }
  }
  // Only pass captionsEnabled through if we actually have segments to render.
  const effectiveCaptionsEnabled = captionsEnabled && segments.length >= (body.imageCount as number)

  // ── Phase 6 P2 — LLM calls for Title Card + Text Highlights ──
  // We call the LLM HERE (synchronously, before kicking off the assembly) so:
  //   - The job record carries the actual title text + highlight list from
  //     the start (the UI snapshot will reflect what was applied).
  //   - If the LLM fails (rate-limit, timeout), we fail-soft: skip the feature
  //     rather than crash the whole video build. The user sees the toggle as
  //     "off" in the chips row.
  //   - The POST request will take a bit longer to return (~2-4s for the LLM
  //     calls), but that's acceptable since the user has already pressed
  //     "Generate Video" and is expecting a wait.
  let titleCardText: string | null = null
  let highlights: { segmentIndex: number; text: string }[] = []
  let outroCtaText: string | null = null
  const titleCardRequested = !!body.titleCardEnabled && scriptText.length >= 20
  const highlightsRequested = !!body.textHighlightsEnabled && scriptText.length >= 20 && segments.length > 0
  const outroRequested = !!body.outroEnabled && scriptText.length >= 20

  if (titleCardRequested) {
    try {
      titleCardText = await generateTitleCard(scriptText)
      if (!titleCardText) {
        console.warn('[video] Title card LLM returned no usable title — skipping title card.')
      }
    } catch (err) {
      console.warn(
        '[video] Title card LLM call failed (fail-soft — skipping title card):',
        err instanceof Error ? err.message : String(err)
      )
      titleCardText = null
    }
  }

  if (highlightsRequested) {
    try {
      highlights = await extractKeyHighlights(scriptText, segments, body.imageCount as number)
      if (highlights.length === 0) {
        console.warn('[video] Highlights LLM returned no usable highlights — skipping text highlights.')
      }
    } catch (err) {
      console.warn(
        '[video] Highlights LLM call failed (fail-soft — skipping text highlights):',
        err instanceof Error ? err.message : String(err)
      )
      highlights = []
    }
  }

  if (outroRequested) {
    try {
      outroCtaText = await generateOutroCta(scriptText)
      if (!outroCtaText) {
        // Fail-soft: the LLM returned nothing usable, but the user explicitly
        // enabled the outro, so use a fixed fallback CTA rather than skipping
        // the whole feature. The outro still plays — only the personalised
        // CTA is lost.
        console.warn('[video] Outro LLM returned no usable CTA — using fallback "Subscribe for more".')
        outroCtaText = 'Subscribe for more'
      }
    } catch (err) {
      console.warn(
        '[video] Outro LLM call failed (fail-soft — using fallback CTA "Subscribe for more"):',
        err instanceof Error ? err.message : String(err)
      )
      outroCtaText = 'Subscribe for more'
    }
  }

  // Effective toggles: only "on" if the user requested AND the LLM produced
  // usable output. (This guards against the case where the LLM returns an
  // empty/garbage response — we don't want to start a job claiming the feature
  // is on but produce no visual change.)
  // The outro is the exception: it falls back to "Subscribe for more" so the
  // outro still applies even if the LLM failed (only the personalised CTA is
  // lost). So effectiveOutroEnabled = outroRequested (the fallback guarantees
  // a non-empty outroCtaText when outroRequested is true).
  const effectiveTitleCardEnabled = !!titleCardText
  const effectiveHighlightsEnabled = highlights.length > 0
  const effectiveOutroEnabled = outroRequested && !!outroCtaText

  // ── Create job + stage inputs ──
  // Phase 6 P4 — resolution is a pure user-choice (no LLM dependency, no
  // fail-soft needed). Default to '1080p' when the body field is missing.
  const resolution = body.resolution === '4k' ? '4k' : '1080p'
  const job = createVideoJob({
    imageJobId: body.imageJobId,
    imageCount: body.imageCount as number,
    audioPath: '', // filled below
    audioDuration: body.audioDuration as number,
    audioMime: mimeType,
    musicPath,
    musicLabel,
    captionsEnabled: effectiveCaptionsEnabled,
    segments,
    transitionsEnabled: !!body.transitionsEnabled,
    titleCardEnabled: effectiveTitleCardEnabled,
    titleCardText: titleCardText ?? undefined,
    textHighlightsEnabled: effectiveHighlightsEnabled,
    textHighlights: highlights,
    outroEnabled: effectiveOutroEnabled,
    outroCtaText: outroCtaText ?? undefined,
    resolution
  })

  const jobDir = path.join(VIDEO_DIR_ROOT, job.id)
  let audioPath: string
  try {
    audioPath = stageAudioFromBase64(jobDir, body.audioBase64, mimeType)
  } catch (err) {
    job.status = 'error'
    job.stage = 'error'
    job.error = `Could not stage audio: ${err instanceof Error ? err.message : String(err)}`
    return NextResponse.json({ error: job.error }, { status: 500 })
  }

  // ── Kick off background assembly (does not block the response) ──
  // MULTI-USER: unlimited jobs are accepted, but at most MAX_CONCURRENT_ASSEMBLIES
  // ffmpeg pipelines run at once — the rest queue here (status "processing",
  // stage "queued — waiting for a free assembly slot") and start the moment a
  // slot frees. This keeps N simultaneous users working without thrashing
  // CPU/RAM into OOM. The video route's own per-job state map is keyed by id,
  // so every user's job is fully independent.
  void enqueueAssembly(job, {
    imageJobId: body.imageJobId,
    imageCount: body.imageCount as number,
    audioPath,
    audioDuration: body.audioDuration as number,
    audioMime: mimeType,
    musicPath,
    musicLabel,
    captionsEnabled: effectiveCaptionsEnabled,
    segments,
    transitionsEnabled: !!body.transitionsEnabled,
    titleCardEnabled: effectiveTitleCardEnabled,
    titleCardText: titleCardText ?? undefined,
    textHighlightsEnabled: effectiveHighlightsEnabled,
    textHighlights: highlights,
    outroEnabled: effectiveOutroEnabled,
    outroCtaText: outroCtaText ?? undefined,
    resolution
  })

  const snap = snapshotJob(job)
  return NextResponse.json({
    jobId: job.id,
    status: snap.status,
    stage: snap.stage,
    progress: snap.progress,
    imageCount: snap.imageCount,
    audioDuration: snap.audioDuration,
    musicLabel: snap.musicLabel,
    kenBurnsApplied: snap.kenBurnsApplied,
    captionsApplied: snap.captionsApplied,
    variablePacingApplied: snap.variablePacingApplied,
    transitionsApplied: snap.transitionsApplied,
    titleCardApplied: snap.titleCardApplied,
    titleCardText: snap.titleCardText,
    textHighlightsApplied: snap.textHighlightsApplied,
    textHighlightsCount: snap.textHighlightsCount,
    outroApplied: snap.outroApplied,
    outroCtaText: snap.outroCtaText,
    resolution: snap.resolution,
    videoWidth: snap.videoWidth,
    videoHeight: snap.videoHeight
  })
}

// ─── GET: poll job progress ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId query param.' }, { status: 400 })
  }
  const job = getVideoJob(jobId)
  if (!job) {
    return NextResponse.json(
      { error: 'Video job not found (may have expired — TTL 2 hours).' },
      { status: 404 }
    )
  }
  const snap: VideoJobSnapshot = snapshotJob(job)
  return NextResponse.json(snap)
}

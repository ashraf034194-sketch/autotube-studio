import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import {
  createVideoJob,
  runVideoAssembly,
  getVideoJob,
  snapshotJob,
  stageAudioFromBase64,
  VIDEO_DIR_ROOT,
  type VideoJobSnapshot
} from '@/lib/video-assembly'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── POST: start a video-assembly job ────────────────────────────────────────

interface PostBody {
  imageJobId?: string
  imageCount?: number
  audioBase64?: string
  audioDuration?: number
  mimeType?: string
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

  // ── Create job + stage inputs ──
  const job = createVideoJob({
    imageJobId: body.imageJobId,
    imageCount: body.imageCount as number,
    audioPath: '', // filled below
    audioDuration: body.audioDuration as number,
    audioMime: mimeType
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
  runVideoAssembly(job, {
    imageJobId: body.imageJobId,
    imageCount: body.imageCount as number,
    audioPath,
    audioDuration: body.audioDuration as number,
    audioMime: mimeType
  }).catch((err) => {
    // runVideoAssembly handles its own error state; this is a safety net.
    job.status = 'error'
    job.stage = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    console.error(`[video] Job ${job.id} crashed unexpectedly:`, job.error)
  })

  const snap = snapshotJob(job)
  return NextResponse.json({
    jobId: job.id,
    status: snap.status,
    stage: snap.stage,
    progress: snap.progress,
    imageCount: snap.imageCount,
    audioDuration: snap.audioDuration
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

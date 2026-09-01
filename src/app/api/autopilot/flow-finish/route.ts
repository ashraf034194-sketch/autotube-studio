import { NextRequest, NextResponse } from 'next/server'
import { finalizeFlowImages, getFlowImageJob } from '@/app/api/images/route'
import {
  beginStage,
  cleanupExpiredAutopilotJobs,
  finishStage,
  getAutopilotJob,
  runVideoStage
} from '@/lib/autopilot/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/autopilot/flow-finish — close the Google Flow handoff and resume
 * the pipeline.
 *
 * Called by the frontend's "Assemble video" button once the user has uploaded
 * at least one image. Compacts the uploaded images to a gap-free 0..N-1
 * sequence (the video pipeline reads {index}.jpg for i < imageCount), marks
 * the image job done, then fires stage 5 (video assembly) in the background —
 * exactly as the pre-handoff autopilot would have.
 */
export async function POST(req: NextRequest) {
  cleanupExpiredAutopilotJobs()

  let body: { autopilotId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!body.autopilotId) {
    return NextResponse.json({ error: 'Missing autopilotId.' }, { status: 400 })
  }

  const job = getAutopilotJob(body.autopilotId)
  if (!job) {
    return NextResponse.json({ error: 'Autopilot run not found (it may have expired).' }, { status: 404 })
  }
  if (job.status !== 'awaiting_images') {
    return NextResponse.json(
      { error: `This run is not waiting for uploads (status: ${job.status}).` },
      { status: 409 }
    )
  }
  if (!job.live.images.jobId) {
    return NextResponse.json({ error: 'This run has no image job.' }, { status: 400 })
  }

  // Compact the uploaded images + mark the image job done.
  const res = finalizeFlowImages(job.live.images.jobId)
  if (!res.ok || !res.total) {
    return NextResponse.json({ error: res.error }, { status: 400 })
  }
  const total = res.total

  // Mirror the finalized image job onto the autopilot's live state.
  const imageJob = getFlowImageJob(job.live.images.jobId)
  if (imageJob) {
    job.live.images.status = imageJob.status
    job.live.images.total = imageJob.total
    job.live.images.completed = imageJob.completed
    job.live.images.failed = imageJob.failed
    job.live.images.progress = 100
    job.live.images.currentLabel = imageJob.currentLabel ?? null
    job.live.images.slots = imageJob.slots.map((s) => ({
      index: s.index,
      status: s.status,
      chunkText: s.chunkText,
      error: s.error
    }))
  }
  job.artifacts.imageCount = total

  finishStage(
    job,
    'images',
    `${total}/${total} images received from Google Flow — handoff complete.`
  )

  // Back to 'running' and fire stage 5 in the background (fire-and-forget —
  // the browser keeps polling GET /api/autopilot?id=).
  job.status = 'running'
  beginStage(job, 'video', 'Preparing clips, captions and music…')
  void runVideoStage(job)

  console.log(
    `[autopilot ${job.id}] FLOW HANDOFF FINISHED — ${total} images, video assembly resuming (run back to 'running')`
  )

  return NextResponse.json({ ok: true, imageCount: total })
}

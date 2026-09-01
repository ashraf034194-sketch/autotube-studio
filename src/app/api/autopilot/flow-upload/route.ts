import { NextRequest, NextResponse } from 'next/server'
import {
  emptyFlowSlots,
  getFlowImageJob,
  removeFlowImage,
  saveFlowImage
} from '@/app/api/images/route'
import {
  cleanupExpiredAutopilotJobs,
  getAutopilotJob,
  updateStage,
  type AutopilotJobInternal
} from '@/lib/autopilot/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/autopilot/flow-upload — the Google Flow handoff upload endpoint.
 *
 * Google Flow (https://labs.google/fx/tools/flow) has NO public API, so the
 * autopilot pauses after writing the prompts; the user generates the images
 * in Flow with their own account, downloads them, and batch-uploads them
 * here. Two request shapes:
 *
 *   1. multipart/form-data:  autopilotId=<uuid> + files=<image files...>
 *      → each file is normalized to JPEG via FFmpeg and fills the first
 *        empty slots in natural-filename order.
 *
 *   2. application/json:     { autopilotId, action: 'remove', slotIndex }
 *      → removes an uploaded image from a slot (back to pending).
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB per image — Imagen exports are far smaller

/** Mirror the image job's state onto the autopilot job's live.images.
 *  Shared by the manual upload path AND the Flow Bridge auto-generation
 *  engine (src/lib/autopilot/flow-auto.ts) so both keep live.images in
 *  lockstep. */
export function mirrorToAutopilot(job: AutopilotJobInternal, via: 'manual' | 'bridge' = 'manual'): void {
  const imageJob = job.live.images.jobId ? getFlowImageJob(job.live.images.jobId) : undefined
  if (!imageJob) return
  job.live.images.status = imageJob.status
  job.live.images.total = imageJob.total
  job.live.images.completed = imageJob.completed
  job.live.images.failed = imageJob.failed
  job.live.images.progress =
    imageJob.total > 0 ? Math.round((imageJob.completed / imageJob.total) * 100) : 0
  job.live.images.currentLabel = imageJob.currentLabel ?? null
  job.live.images.slots = imageJob.slots.map((s) => ({
    index: s.index,
    status: s.status,
    chunkText: s.chunkText,
    error: s.error
  }))
  job.artifacts.imageCount = imageJob.completed
  const detail =
    via === 'bridge'
      ? `Flow Bridge auto-generation — ${imageJob.completed}/${imageJob.total} images generated in the real Google Flow.`
      : `Google Flow handoff — ${imageJob.completed}/${imageJob.total} images received. Upload more, or press “Assemble video” when ready.`
  updateStage(
    job,
    'images',
    detail,
    imageJob.total > 0
      ? Math.round((imageJob.completed / imageJob.total) * 100)
      : null
  )
}

export async function POST(req: NextRequest) {
  cleanupExpiredAutopilotJobs()

  const contentType = req.headers.get('content-type') ?? ''

  // ── Shape 2: JSON "remove" action ──────────────────────────────────────────
  if (contentType.includes('application/json')) {
    let body: { autopilotId?: string; action?: string; slotIndex?: number }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    if (body.action !== 'remove') {
      return NextResponse.json(
        { error: 'JSON requests must use { action: "remove", slotIndex }.' },
        { status: 400 }
      )
    }
    const job = body.autopilotId ? getAutopilotJob(body.autopilotId) : undefined
    if (!job) {
      return NextResponse.json({ error: 'Autopilot run not found (it may have expired).' }, { status: 404 })
    }
    if (job.status !== 'awaiting_images') {
      return NextResponse.json(
        { error: `This run is not waiting for uploads (status: ${job.status}).` },
        { status: 409 }
      )
    }
    if (!job.live.images.jobId || typeof body.slotIndex !== 'number') {
      return NextResponse.json({ error: 'Missing image job or slotIndex.' }, { status: 400 })
    }
    const res = removeFlowImage(job.live.images.jobId, body.slotIndex)
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400 })
    }
    mirrorToAutopilot(job)
    return NextResponse.json({
      ok: true,
      removed: body.slotIndex,
      completed: job.live.images.completed,
      total: job.live.images.total
    })
  }

  // ── Shape 1: multipart upload ──────────────────────────────────────────────
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Unsupported content-type — use multipart/form-data for uploads.' },
      { status: 400 }
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Could not read the multipart form data.' }, { status: 400 })
  }

  const autopilotId = form.get('autopilotId')
  if (typeof autopilotId !== 'string' || !autopilotId) {
    return NextResponse.json({ error: 'Missing autopilotId field.' }, { status: 400 })
  }
  const job = getAutopilotJob(autopilotId)
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
  const imageJobId = job.live.images.jobId

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files were uploaded.' }, { status: 400 })
  }

  // Validate each file BEFORE consuming slots.
  for (const f of files) {
    if (!f.type.startsWith('image/')) {
      return NextResponse.json(
        { error: `“${f.name}” is not an image (got ${f.type || 'unknown type'}). Export images from Google Flow and upload those.` },
        { status: 400 }
      )
    }
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `“${f.name}” is larger than 25 MB (${(f.size / 1024 / 1024).toFixed(1)} MB).` },
        { status: 400 }
      )
    }
    if (f.size < 1000) {
      return NextResponse.json({ error: `“${f.name}” looks empty or corrupt.` }, { status: 400 })
    }
  }

  // Natural filename sort (image2.png before image10.png) so the user's
  // numbered Flow exports map onto slots in order.
  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )

  const empty = emptyFlowSlots(imageJobId)
  if (sorted.length > empty.length) {
    return NextResponse.json(
      {
        error: `You uploaded ${sorted.length} images but only ${empty.length} slot${empty.length === 1 ? '' : 's'} ${empty.length === 1 ? 'remains' : 'remain'} empty (${job.live.images.total} total). Remove some first, or assemble with the current set.`
      },
      { status: 400 }
    )
  }

  const errors: string[] = []
  let saved = 0
  for (let i = 0; i < sorted.length; i++) {
    const slotIndex = empty[i]
    const buf = Buffer.from(await sorted[i].arrayBuffer())
    const res = await saveFlowImage(imageJobId, slotIndex, buf, sorted[i].name)
    if (res.ok) {
      saved++
    } else {
      errors.push(res.error ?? `Slot ${slotIndex} failed.`)
    }
  }

  mirrorToAutopilot(job)
  console.log(
    `[autopilot ${autopilotId}] FLOW UPLOAD — ${saved}/${sorted.length} saved to image job ${imageJobId} (${job.live.images.completed}/${job.live.images.total} total)${errors.length ? `; errors: ${errors.join(' | ').slice(0, 300)}` : ''}`
  )

  return NextResponse.json({
    ok: saved > 0,
    saved,
    failed: errors.length,
    errors,
    completed: job.live.images.completed,
    total: job.live.images.total
  })
}

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import {
  generateImageWithRetryQueue,
  type TrailEntry,
  type ProviderName
} from '@/lib/image-providers'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Job store (in-memory, TTL 1 hour) ──────────────────────────────────────

interface ImageSlot {
  index: number
  status: 'pending' | 'processing' | 'waiting' | 'done' | 'error'
  provider?: ProviderName
  trail?: TrailEntry[]
  retryCount: number
  nextRetryAt?: number
  waitMs?: number
  error?: string
}

interface ImageJob {
  id: string
  status: 'processing' | 'done' | 'error'
  total: number
  completed: number
  waiting: number
  failed: number
  slots: ImageSlot[]
  prompts: string[]
  createdAt: number
  doneAt?: number
  error?: string
}

const jobs = new Map<string, ImageJob>()
const JOB_TTL_MS = 60 * 60 * 1000 // 1 hour

function cleanupExpiredJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)
  }
}

// ─── Image storage ──────────────────────────────────────────────────────────

const IMAGE_DIR_ROOT = '/tmp/autotube-images'

function getImagePath(jobId: string, index: number): string {
  return path.join(IMAGE_DIR_ROOT, jobId, `${index}.jpg`)
}

// ─── Prompt generation (one LLM call, ~2-5s) ───────────────────────────────

const PROMPT_SYSTEM = `You are a cinematic storyboard artist. Given a narration script, break it into N sequential visual scenes (one image per ~4 seconds of narration). For each scene, write a SINGLE detailed image-generation prompt: a vivid, photorealistic, cinematic wide-shot description (lighting, mood, camera angle, subject, setting, colors). Each prompt MUST be visually distinct from the others (no repeated subjects/angles). Plain text only, one prompt per line, NO numbering, NO preamble, NO markdown. Output exactly N prompts.`

async function generateImagePrompts(script: string, count: number): Promise<string[]> {
  const zai = await ZAI.create()
  const userContent = `SCRIPT:\n${script.slice(0, 8000)}\n\nN = ${count}\n\nOutput ${count} visually-distinct cinematic image prompts, one per line:`
  const res = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: PROMPT_SYSTEM },
      { role: 'user', content: userContent }
    ]
  } as never)
  const text = (res as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\d+[\.)]\s*/, '').trim())
    .filter((l) => l.length > 15)
  if (lines.length < count) {
    while (lines.length < count) {
      lines.push(`cinematic wide shot scene ${lines.length + 1}, photorealistic, dramatic lighting, 16:9`)
    }
  }
  return lines.slice(0, count)
}

// ─── POST: start image-generation job ───────────────────────────────────────

export async function POST(req: NextRequest) {
  cleanupExpiredJobs()
  let body: { text?: string; durationSeconds?: number; prompts?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  let prompts: string[]
  if (Array.isArray(body.prompts) && body.prompts.length > 0) {
    prompts = body.prompts
  } else {
    if (!body.text || body.text.trim().length < 20) {
      return NextResponse.json({ error: 'Either "prompts" array or "text" (min 20 chars) is required.' }, { status: 400 })
    }
    if (!body.durationSeconds || body.durationSeconds < 4) {
      return NextResponse.json({ error: '"durationSeconds" (>= 4) is required when prompts not provided.' }, { status: 400 })
    }
    const count = Math.min(200, Math.max(1, Math.ceil(body.durationSeconds / 4)))
    try {
      prompts = await generateImagePrompts(body.text, count)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: `Prompt generation failed: ${msg.slice(0, 150)}` }, { status: 500 })
    }
  }

  const jobId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const total = prompts.length
  const job: ImageJob = {
    id: jobId,
    status: 'processing',
    total,
    completed: 0,
    waiting: 0,
    failed: 0,
    slots: prompts.map((_, i) => ({ index: i, status: 'pending' as const, retryCount: 0 })),
    prompts,
    createdAt: Date.now()
  }
  jobs.set(jobId, job)

  processJob(job).catch((err) => {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    console.error(`[images] Job ${jobId} crashed:`, job.error)
  })

  return NextResponse.json({ jobId, total, prompts })
}

// ─── GET: poll job progress ─────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  cleanupExpiredJobs()
  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId query param.' }, { status: 400 })
  }
  const job = jobs.get(jobId)
  if (!job) {
    return NextResponse.json({ error: 'Job not found (may have expired — TTL 1 hour).' }, { status: 404 })
  }

  const waitingSlots = job.slots
    .filter((s) => s.status === 'waiting')
    .map((s) => ({ index: s.index, retryCount: s.retryCount, nextRetryAt: s.nextRetryAt, waitMs: s.waitMs }))

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    waiting: job.waiting,
    failed: job.failed,
    progress: job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0,
    waitingSlots,
    slots: job.slots.map((s) => ({
      index: s.index,
      status: s.status,
      provider: s.provider,
      retryCount: s.retryCount,
      error: s.error
    })),
    prompts: job.prompts,
    doneAt: job.doneAt,
    error: job.error
  })
}

// ─── Background job processor ────────────────────────────────────────────────

const IMAGE_GEN_CONCURRENCY = 2

async function processJob(job: ImageJob): Promise<void> {
  fs.mkdirSync(path.join(IMAGE_DIR_ROOT, job.id), { recursive: true })
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < job.total) {
      const i = cursor++
      const slot = job.slots[i]
      slot.status = 'processing'
      const outPath = getImagePath(job.id, i)
      const prompt = job.prompts[i]

      try {
        const outcome = await generateImageWithRetryQueue(prompt, outPath, {
          onWait: (info) => {
            slot.status = 'waiting'
            slot.retryCount = info.retryCount
            slot.nextRetryAt = info.nextRetryAt
            slot.waitMs = info.waitMs
            slot.trail = info.lastTrail
            job.waiting = job.slots.filter((s) => s.status === 'waiting').length
            console.log(`[images] Job ${job.id} image ${i}: waiting for provider capacity (retry ${info.retryCount} in ${info.waitMs / 1000}s)`)
          },
          onRetry: (info) => {
            slot.status = 'processing'
            slot.retryCount = info.retryCount
            job.waiting = job.slots.filter((s) => s.status === 'waiting').length
            console.log(`[images] Job ${job.id} image ${i}: retrying full chain (round ${info.retryCount})`)
          }
        })
        slot.status = 'done'
        slot.provider = outcome.provider
        slot.trail = [{ provider: outcome.provider, ok: true }]
        slot.nextRetryAt = undefined
        slot.waitMs = undefined
        job.completed = job.slots.filter((s) => s.status === 'done').length
        job.waiting = job.slots.filter((s) => s.status === 'waiting').length
      } catch (err) {
        slot.status = 'error'
        slot.error = err instanceof Error ? err.message : String(err)
        job.failed = job.slots.filter((s) => s.status === 'error').length
        console.error(`[images] Job ${job.id} image ${i} gave up:`, slot.error)
      }
      job.waiting = job.slots.filter((s) => s.status === 'waiting').length
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < IMAGE_GEN_CONCURRENCY; i++) workers.push(worker())
  await Promise.all(workers)

  job.status = job.failed > 0 ? 'error' : 'done'
  job.doneAt = Date.now()
  console.log(`[images] Job ${job.id} done: ${job.completed}/${job.total} ok, ${job.failed} failed`)
}

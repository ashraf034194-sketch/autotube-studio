import { spawn, type ChildProcess } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execFileAsync = promisify(execFile)

// ─── Constants ────────────────────────────────────────────────────────────────

const IMAGE_DIR_ROOT = '/tmp/autotube-images'
export const VIDEO_DIR_ROOT = '/tmp/autotube-videos'
const VIDEO_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours — videos are big; keep long enough to download

/** Each image is shown for exactly 4 seconds (per spec). */
const PER_IMAGE_SECONDS = 4

/** Light fade duration (in + out per segment) — "halka fade effect", no jerky cuts. */
const FADE_SECONDS = 0.5

/** Target output geometry. */
const OUT_W = 1920
const OUT_H = 1080
const OUT_FPS = 30

// ─── Types ────────────────────────────────────────────────────────────────────

export type VideoStage =
  | 'preparing'
  | 'assembling'
  | 'finalizing'
  | 'done'
  | 'error'

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
 * Compute the display duration for each image so the total matches the voiceover
 * duration. Images 1..N-1 are exactly 4s; the last image absorbs the remainder
 * (so it holds while the narration finishes). If the narration is shorter than
 * N*4s, all images stay 4s and the output is capped with -t.
 */
function computeDurations(imageCount: number, audioDuration: number): number[] {
  const total = imageCount * PER_IMAGE_SECONDS
  const durations = new Array<number>(imageCount).fill(PER_IMAGE_SECONDS)
  if (audioDuration > total) {
    // Extend the last image so the video matches the narration length.
    durations[imageCount - 1] = audioDuration - (imageCount - 1) * PER_IMAGE_SECONDS
  }
  return durations
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
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
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

// ─── Main assembly function ───────────────────────────────────────────────────

export interface AssembleParams {
  imageJobId: string
  imageCount: number
  audioPath: string
  audioDuration: number
  audioMime: string
}

function getImagePath(imageJobId: string, index: number): string {
  return path.join(IMAGE_DIR_ROOT, imageJobId, `${index}.jpg`)
}

export function createVideoJob(params: AssembleParams): VideoJob {
  const id = `vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const job: VideoJob = {
    id,
    status: 'processing',
    stage: 'preparing',
    progress: 0,
    imageCount: params.imageCount,
    audioDuration: params.audioDuration,
    imageJobId: params.imageJobId,
    createdAt: Date.now()
  }
  jobs.set(id, job)
  return job
}

export async function runVideoAssembly(job: VideoJob, params: AssembleParams): Promise<void> {
  const jobDir = path.join(VIDEO_DIR_ROOT, job.id)
  fs.mkdirSync(jobDir, { recursive: true })

  const outputPath = path.join(jobDir, 'output.mp4')
  const audioExt = params.audioMime.includes('wav') ? 'wav' : params.audioMime.includes('ogg') ? 'ogg' : 'mp3'
  const stagedAudio = path.join(jobDir, `audio.${audioExt}`)

  try {
    // ── Stage 1: prepare inputs ──────────────────────────────────────────────
    job.stage = 'preparing'
    job.startedAt = Date.now()

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

    // ── Stage 2: assemble (the long encode) ─────────────────────────────────
    job.stage = 'assembling'

    const durations = computeDurations(params.imageCount, params.audioDuration)
    const args = buildFFmpegArgs(imagePaths, durations, stagedAudio, outputPath, params.audioDuration)

    console.log(`[video] Job ${job.id}: starting FFmpeg (${imagePaths.length} images, ${params.audioDuration.toFixed(1)}s audio)`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      abortControllers.set(job.id, proc)

      let stderrBuffer = ''
      const tailLines: string[] = []
      let lastProgressUpdate = 0

      const handleStderr = (chunk: Buffer): void => {
        stderrBuffer += chunk.toString()
        let nl: number
        while ((nl = stderrBuffer.indexOf('\n')) >= 0) {
          const line = stderrBuffer.slice(0, nl).trim()
          stderrBuffer = stderrBuffer.slice(nl + 1)
          if (!line) continue

          // Keep a rolling tail for error diagnostics.
          tailLines.push(line)
          if (tailLines.length > 40) tailLines.shift()

          // Parse progress from "time=HH:MM:SS.ff"
          const t = parseTimeToSeconds(line)
          if (t !== null && params.audioDuration > 0) {
            const pct = Math.min(99, Math.max(0, (t / params.audioDuration) * 100))
            // Throttle updates to avoid spamming (every ~400ms)
            const now = Date.now()
            if (now - lastProgressUpdate > 400 || pct >= 99) {
              lastProgressUpdate = now
              job.progress = Math.round(pct)
              // ETA
              if (job.startedAt && pct > 2) {
                const elapsed = (now - job.startedAt) / 1000
                const remaining = (elapsed / pct) * (100 - pct)
                job.etaSeconds = Math.max(0, Math.round(remaining))
              }
            }
          }
        }
      }

      proc.stderr?.on('data', handleStderr)
      proc.stdout?.on('data', () => {
        /* ffmpeg writes progress to stderr only; drain stdout silently */
      })

      proc.on('error', (err) => {
        abortControllers.delete(job.id)
        reject(new Error(`Failed to launch FFmpeg: ${err.message}`))
      })

      proc.on('close', (code) => {
        abortControllers.delete(job.id)
        if (code === 0) {
          resolve()
        } else {
          job.ffmpegTail = tailLines.join('\n')
          reject(
            new Error(
              `FFmpeg exited with code ${code}. ` +
                (tailLines.length ? `Last line: ${tailLines[tailLines.length - 1]}` : '')
            )
          )
        }
      })
    })

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

    job.videoPath = outputPath
    job.fileSize = stat.size
    job.videoDuration = Math.round((measuredDuration || params.audioDuration) * 10) / 10
    job.progress = 100
    job.stage = 'done'
    job.status = 'done'
    job.doneAt = Date.now()
    job.etaSeconds = undefined

    console.log(
      `[video] Job ${job.id} DONE: ${(stat.size / (1024 * 1024)).toFixed(2)}MB, ${job.videoDuration}s, ${imagePaths.length} images`
    )
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

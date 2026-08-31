import { NextRequest, NextResponse } from 'next/server'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

const execFileAsync = promisify(execFile)

// ─── Runtime config ──────────────────────────────────────────────────────────
// CRITICAL: must run in the Node.js runtime (not edge) because we spawn ffmpeg
// and keep long-running background work in module-level memory. force-dynamic
// prevents Next from statically optimizing this route away.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_CHARS = 20
const MAX_CHARS = 20000

/**
 * Edge TTS handles longer inputs comfortably; sentence-aware chunks stay below this.
 *
 * 2026-05-11: lowered from 1200 → 300 so each chunk ≈ 1-3 sentences ≈ 4-7s of
 * narration. This makes image N visualize the EXACT text chunk N the narrator
 * speaks (true script-to-image match), and yields ~30-50 images for a typical
 * 10-15 min / 1500-2300 word script — the user's target pacing for long-form
 * YouTube content.
 *
 * 2026-08-29: lowered from 300 → 140 so each chunk ≈ 1 sentence ≈ 2-3s of
 * narration. This produces ~2x more images (~60-115 per batch) for denser
 * visual coverage — one image per ~2-3s matches the YouTube pacing standard
 * (a fresh visual every 2-4s keeps viewer engagement). The 300-char setting
 * was producing too few images (~32 for a 7-min video) leaving long stretches
 * of static frames in the final video.
 *
 * 2026-08-29b: lowered from 140 → 80 so each chunk ≈ 5s of narration (at the
 * typical 16 chars/sec Edge TTS rate). This matches the user's "1 image per ~4s
 * of narration" rule closely: 80s voiceover → 16 chunks → 16 images, vs the
 * previous 140-char setting which produced only 13 chunks for the same 80s
 * (1 image per ~6s — too sparse, broke the user's pacing rule, and the UI's
 * "1 per 4s" estimate didn't match the actual count). 80 chars still preserves
 * sentence boundaries (chunker falls back to word-boundary split for oversized
 * sentences) so chunks remain semantically coherent.
 */
const CHUNK_MAX_CHARS = 80

/** Professional adult neural voices (Microsoft Edge Read-Aloud service). */
const ALLOWED_VOICES = [
  'en-US-ChristopherNeural', // deep, calm, documentary-style male
  'en-US-AndrewNeural', // warm, confident male
  'en-US-GuyNeural', // energetic male news-anchor
  'en-US-BrianNeural', // warm male
  'en-US-AriaNeural', // clear professional female
  'en-US-MichelleNeural', // warm female
  'en-GB-RyanNeural', // British male
  'en-GB-SoniaNeural' // British female
] as const

type Voice = (typeof ALLOWED_VOICES)[number]

/** Finished jobs are kept for this long, then garbage-collected. */
const JOB_TTL_MS = 60 * 60 * 1000 // 1 hour

// ─── Job store (in-memory; survives across requests in the server process) ────

/** One segment of the script + its precise timing inside the final audio.
 *  The images route consumes this to make image N visualize the EXACT text
 *  chunk N the narrator speaks (true script-to-image match). */
interface VoiceoverChunk {
  /** The literal text of this segment (1-3 sentences, ~300 chars max). */
  text: string
  /** Start of this segment in the merged audio, milliseconds. */
  startMs: number
  /** End of this segment in the merged audio, milliseconds. */
  endMs: number
}

interface VoiceoverResult {
  audioBase64: string
  mimeType: string
  durationSeconds: number
  sizeBytes: number
  chunkCount: number
  voice: string
  speed: number
  /** Per-segment script text + audio timing — consumed by /api/images to
   *  achieve exact script-to-image alignment. */
  chunks: VoiceoverChunk[]
}

interface VoiceoverJob {
  id: string
  status: 'processing' | 'done' | 'error'
  createdAt: number
  totalChunks: number
  completedChunks: number
  currentLabel?: string
  result?: VoiceoverResult
  error?: string
}

const jobs = new Map<string, VoiceoverJob>()

function cleanupExpiredJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split text into sentence-aware chunks without breaking sentences when possible.
 * Falls back to word-boundary splitting for oversized sentences.
 */
function splitTextIntoChunks(text: string, maxLength = CHUNK_MAX_CHARS): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return [normalized]

  const sentences = normalized.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [normalized]
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if ((current + sentence).length <= maxLength) {
      current += sentence
      continue
    }
    if (current.trim()) chunks.push(current.trim())
    current = ''

    if (sentence.length <= maxLength) {
      current = sentence
    } else {
      const words = sentence.split(' ')
      let piece = ''
      for (const word of words) {
        if ((piece + ' ' + word).trim().length > maxLength) {
          if (piece.trim()) chunks.push(piece.trim())
          piece = word
        } else {
          piece = piece ? `${piece} ${word}` : word
        }
      }
      if (piece.trim()) chunks.push(piece.trim())
    }
  }
  if (current.trim()) chunks.push(current.trim())

  return chunks.filter((c) => c.length > 0)
}

/** Run ffmpeg/ffprobe and return trimmed stdout. */
async function run(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, { timeout: 120000 })
  return stdout.trim()
}

async function getAudioDuration(filePath: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ])
  const duration = parseFloat(out)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine the duration of the generated audio.')
  }
  return duration
}

/**
 * Generate one audio chunk with Microsoft Edge neural TTS.
 * Retries on transient WebSocket/service failures.
 */
async function synthesizeChunk(
  voice: Voice,
  rateString: string,
  chunk: string,
  chunkIndex: number,
  totalChunks: number
): Promise<Buffer> {
  const MAX_ATTEMPTS = 3
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let tts: MsEdgeTTS | null = null
    try {
      tts = new MsEdgeTTS()
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)

      const { audioStream } = tts.toStream(chunk, { rate: rateString })

      const chunks: Buffer[] = []
      for await (const part of audioStream) {
        chunks.push(Buffer.from(part as Buffer))
      }
      const buffer = Buffer.concat(chunks)

      if (buffer.length < 2000) {
        throw new Error(`synthesis returned only ${buffer.length} bytes (empty/corrupted audio)`)
      }
      return buffer
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      console.error(
        `[voiceover] Edge TTS chunk ${chunkIndex}/${totalChunks} attempt ${attempt} failed:`,
        lastErr.message
      )
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
    } finally {
      // Make sure the underlying socket is released
      try {
        tts?.close()
      } catch {
        // ignore close errors
      }
    }
  }

  throw new Error(
    `Speech synthesis failed for part ${chunkIndex} of ${totalChunks} after ${MAX_ATTEMPTS} attempts: ${lastErr?.message ?? 'unknown error'}`
  )
}

/** Map a raw technical failure message to a friendly, user-readable sentence. */
function friendlyErrorMessage(rawMessage: string): string {
  if (/synthesis failed|no turn\.end|WebSocket|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(rawMessage)) {
    return 'The speech service is temporarily unreachable. Please wait a few seconds and try again.'
  }
  if (/duration/i.test(rawMessage)) {
    return 'The audio was generated but its duration could not be measured. Please try again.'
  }
  if (/ffmpeg|ffprobe|concat/i.test(rawMessage)) {
    return 'Audio processing failed while assembling the voiceover. Please try again.'
  }
  return 'Voiceover generation failed. Please try again in a moment.'
}

// ─── Background job processor ────────────────────────────────────────────────
//
// Runs fully detached from the HTTP request that started it. Never throws —
// any failure is stored on the job record so the polling endpoint can surface
// a friendly error to the client. The request handler returns immediately
// (with a jobId) so gateway/HTTP timeouts are impossible regardless of how
// long TTS + ffmpeg take.

async function processVoiceoverJob(
  job: VoiceoverJob,
  text: string,
  voice: Voice,
  rateString: string,
  speed: number
): Promise<void> {
  let workDir: string | null = null
  try {
    const chunks = splitTextIntoChunks(text)
    job.totalChunks = chunks.length
    if (chunks.length === 0) {
      throw new Error('Could not extract any speakable text from the script.')
    }

    workDir = await mkdtemp(path.join(tmpdir(), 'autotube-tts-'))

    // ── TTS generation (sequential — Edge service dislikes rapid back-to-back sockets) ──
    // Each chunk is measured individually via ffprobe so we can build an
    // exact-startMs/endMs map per segment. The images route consumes this map
    // to align image N with the LITERAL text chunk N the narrator speaks.
    const mp3Files: string[] = []
    const chunkMetadata: VoiceoverChunk[] = []
    let runningMs = 0
    for (let i = 0; i < chunks.length; i++) {
      job.currentLabel = `Narrating segment ${i + 1} of ${chunks.length}`
      const buffer = await synthesizeChunk(voice, rateString, chunks[i], i + 1, chunks.length)
      const filePath = path.join(workDir, `chunk_${String(i).padStart(4, '0')}.mp3`)
      await writeFile(filePath, buffer)
      mp3Files.push(filePath)

      // Measure this chunk's exact duration so we can map audio offsets → script text.
      let chunkDurSec = 0
      try {
        chunkDurSec = await getAudioDuration(filePath)
      } catch (err) {
        // Fall back to a rough estimate (Edge TTS @ ~16 chars/sec @ 1.0× speed).
        chunkDurSec = Math.max(2, chunks[i].length / 16)
        console.warn(
          `[voiceover] Job ${job.id} chunk ${i + 1} duration probe failed — estimating ${chunkDurSec.toFixed(1)}s:`,
          err instanceof Error ? err.message : String(err)
        )
      }
      const chunkDurMs = Math.round(chunkDurSec * 1000)
      chunkMetadata.push({
        text: chunks[i],
        startMs: runningMs,
        endMs: runningMs + chunkDurMs
      })
      runningMs += chunkDurMs

      job.completedChunks = i + 1

      // Brief pause between chunks — the Edge service dislikes rapid back-to-back sockets
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 600))
      }
    }

    job.currentLabel = 'Merging audio segments'

    // ── Merge MP3 chunks with re-encode (gapless, uniform output) ──
    let mergedPath: string
    if (mp3Files.length === 1) {
      mergedPath = mp3Files[0]
    } else {
      const concatListPath = path.join(workDir, 'list.txt')
      const listContent = mp3Files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
      await writeFile(concatListPath, listContent, 'utf-8')

      mergedPath = path.join(workDir, 'voiceover-merged.mp3')
      await run('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-codec:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '24000',
        '-ac', '1',
        mergedPath
      ])
    }

    job.currentLabel = 'Measuring final duration'

    // ── Measure exact duration ──
    const durationSeconds = await getAudioDuration(mergedPath)

    // ── Read final MP3 ──
    const mp3Buffer = await readFile(mergedPath)
    if (mp3Buffer.length < 1000) {
      throw new Error('The generated audio file appears to be empty.')
    }

    job.result = {
      audioBase64: mp3Buffer.toString('base64'),
      mimeType: 'audio/mpeg',
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      sizeBytes: mp3Buffer.length,
      chunkCount: chunks.length,
      voice,
      speed,
      chunks: chunkMetadata
    }
    job.status = 'done'
    job.currentLabel = undefined
    console.log(
      `[voiceover] Job ${job.id} done: ${chunks.length} chunk(s), voice=${voice}, rate=${rateString}, duration=${durationSeconds.toFixed(1)}s, size=${mp3Buffer.length}B`
    )
  } catch (error) {
    job.status = 'error'
    const raw = error instanceof Error && error.message ? error.message : String(error)
    job.error = `${friendlyErrorMessage(raw)} (Details: ${raw.slice(0, 200)})`
    console.error(`[voiceover] Job ${job.id} failed:`, raw)
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/voiceover — starts an async voiceover job and returns the jobId
 * immediately. Long scripts never hold the HTTP connection open, so gateway
 * timeouts are impossible (the previous synchronous version returned 502 for
 * any script long enough to push TTS+ffmpeg past ~60s).
 */
export async function POST(req: NextRequest) {
  cleanupExpiredJobs()

  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request: request body must be valid JSON.' },
        { status: 400 }
      )
    }

    const { text, voice, speed } = (body ?? {}) as {
      text?: string
      voice?: string
      speed?: number
    }

    // ── Validation ──
    if (typeof text !== 'string' || !text.trim()) {
      return NextResponse.json(
        { success: false, error: 'Script text is required. Rewrite a script first, then generate the voiceover.' },
        { status: 400 }
      )
    }
    if (text.trim().length < MIN_CHARS) {
      return NextResponse.json(
        { success: false, error: `Script text is too short for a voiceover (minimum ${MIN_CHARS} characters).` },
        { status: 400 }
      )
    }
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        { success: false, error: `Script text is too long (${text.length} characters). Maximum allowed is ${MAX_CHARS.toLocaleString()} characters.` },
        { status: 400 }
      )
    }

    const selectedVoice: Voice =
      typeof voice === 'string' && (ALLOWED_VOICES as readonly string[]).includes(voice)
        ? (voice as Voice)
        : 'en-US-ChristopherNeural'

    let selectedSpeed = 1.0
    if (typeof speed === 'number') {
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
        return NextResponse.json(
          { success: false, error: 'Speed must be a number between 0.5 and 2.0.' },
          { status: 400 }
        )
      }
      selectedSpeed = speed
    }
    // Map linear speed multiplier to an explicit SSML percentage string ("+15%" = 1.15×).
    // NOTE: this library expects a percentage string or a multiplier number — passing a raw
    // percentage number (e.g. 15) would be treated as a 15× multiplier and break pacing.
    const ratePercent = Math.round((selectedSpeed - 1) * 100)
    const rateString = `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`

    // Pre-compute chunk count so the client can show a real progress bar from
    // the very first poll (otherwise totalChunks stays 0 for ~1s until the
    // background worker actually splits the text).
    const chunks = splitTextIntoChunks(text)
    if (chunks.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Could not extract any speakable text from the script.' },
        { status: 400 }
      )
    }

    const job: VoiceoverJob = {
      id: randomUUID(),
      status: 'processing',
      createdAt: Date.now(),
      totalChunks: chunks.length,
      completedChunks: 0,
      currentLabel: 'Starting synthesis'
    }
    jobs.set(job.id, job)

    // Fire-and-forget background processing (never blocks the response)
    void processVoiceoverJob(job, text, selectedVoice, rateString, selectedSpeed)

    console.log(
      `[voiceover] Job ${job.id} started: ${chunks.length} chunks, voice=${selectedVoice}, rate=${rateString}, ${text.length} chars`
    )

    return NextResponse.json({
      success: true,
      data: { jobId: job.id, total: chunks.length }
    })
  } catch (error) {
    console.error('[voiceover] Unexpected error:', error)
    const rawMessage = error instanceof Error && error.message ? error.message : String(error)
    return NextResponse.json(
      {
        success: false,
        error: `Voiceover generation failed to start. Please try again. (Details: ${rawMessage.slice(0, 180)})`
      },
      { status: 502 }
    )
  }
}

/**
 * GET /api/voiceover?jobId=... — poll endpoint for job progress / result.
 */
export async function GET(req: NextRequest) {
  cleanupExpiredJobs()

  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return NextResponse.json(
      { success: false, error: 'Missing jobId query parameter.' },
      { status: 400 }
    )
  }

  const job = jobs.get(jobId)
  if (!job) {
    return NextResponse.json(
      {
        success: false,
        error: 'Voiceover job not found. It may have expired (jobs are kept for 1 hour) — please start again.'
      },
      { status: 404 }
    )
  }

  if (job.status === 'processing') {
    return NextResponse.json({
      success: true,
      data: {
        status: 'processing',
        completedChunks: job.completedChunks,
        totalChunks: job.totalChunks,
        currentLabel: job.currentLabel ?? null
      }
    })
  }

  if (job.status === 'error') {
    // Job consumed — clean it up
    jobs.delete(job.id)
    return NextResponse.json({
      success: false,
      error: job.error ?? 'Voiceover generation failed. Please try again.'
    })
  }

  // done — return the result and clean up
  const result = job.result!
  jobs.delete(job.id)
  return NextResponse.json({
    success: true,
    data: {
      status: 'done',
      ...result
    }
  })
}

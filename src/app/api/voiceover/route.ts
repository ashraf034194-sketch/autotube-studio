import { NextRequest, NextResponse } from 'next/server'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

const execFileAsync = promisify(execFile)

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_CHARS = 20
const MAX_CHARS = 20000

/** Edge TTS handles longer inputs comfortably; sentence-aware chunks stay below this. */
const CHUNK_MAX_CHARS = 1200

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

export const maxDuration = 300

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

// ─── API Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let workDir: string | null = null

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

    // ── Chunking ──
    const chunks = splitTextIntoChunks(text)
    if (chunks.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Could not extract any speakable text from the script.' },
        { status: 400 }
      )
    }

    workDir = await mkdtemp(path.join(tmpdir(), 'autotube-tts-'))

    // ── TTS generation (sequential, per-chunk retry) ──
    const mp3Files: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const buffer = await synthesizeChunk(selectedVoice, rateString, chunks[i], i + 1, chunks.length)
      const filePath = path.join(workDir, `chunk_${String(i).padStart(4, '0')}.mp3`)
      await writeFile(filePath, buffer)
      mp3Files.push(filePath)

      // Brief pause between chunks — the Edge service dislikes rapid back-to-back sockets
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 600))
      }
    }

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

    // ── Measure exact duration ──
    const durationSeconds = await getAudioDuration(mergedPath)

    // ── Read final MP3 and return as base64 ──
    const mp3Buffer = await readFile(mergedPath)
    if (mp3Buffer.length < 1000) {
      throw new Error('The generated audio file appears to be empty.')
    }

    console.log(
      `[voiceover] OK: ${chunks.length} chunk(s), voice=${selectedVoice}, rate=${rateString}, duration=${durationSeconds.toFixed(1)}s, size=${mp3Buffer.length}B`
    )

    return NextResponse.json({
      success: true,
      data: {
        audioBase64: mp3Buffer.toString('base64'),
        mimeType: 'audio/mpeg',
        durationSeconds: Math.round(durationSeconds * 10) / 10,
        sizeBytes: mp3Buffer.length,
        chunkCount: chunks.length,
        voice: selectedVoice,
        speed: selectedSpeed
      }
    })
  } catch (error) {
    // Full error details to the server console for debugging
    console.error('[voiceover] Generation failed:', error)

    const rawMessage = error instanceof Error && error.message ? error.message : String(error)
    const friendly = /synthesis failed|no turn\.end|WebSocket|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(
      rawMessage
    )
      ? 'The speech service is temporarily unreachable. Please wait a few seconds and try again.'
      : /duration/i.test(rawMessage)
        ? 'The audio was generated but its duration could not be measured. Please try again.'
        : /ffmpeg|ffprobe|concat/i.test(rawMessage)
          ? 'Audio processing failed while assembling the voiceover. Please try again.'
          : 'Voiceover generation failed. Please try again in a moment.'

    return NextResponse.json(
      { success: false, error: `${friendly} (Details: ${rawMessage.slice(0, 200)})` },
      { status: 502 }
    )
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

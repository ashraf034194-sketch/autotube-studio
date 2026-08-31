import { spawn } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execFileAsync = promisify(execFile)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VideoBuildOptions {
  /** Ordered list of image file paths (only the ones that exist on disk). */
  imagePaths: string[]
  /** Path to the voiceover audio file (mp3). */
  audioPath: string
  /** Where to write the final MP4. */
  outputPath: string
  /** Voiceover duration in seconds (drives per-image timing). */
  audioDuration: number
  /** Output width (1920 for Full HD). */
  width: number
  /** Output height (1080 for Full HD). */
  height: number
  /** Output framerate (30 fps — smooth + widely compatible). */
  fps: number
  /** Crossfade duration between consecutive images (~0.5s for a soft fade). */
  transitionDuration: number
  /** Progress callback (0–100). */
  onProgress?: (pct: number) => void
}

export interface VideoBuildResult {
  durationSeconds: number
  sizeBytes: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Per-image display duration.
 *
 * We want:  total video duration == voiceover duration (audio drives the whole
 * video), AND each image to show ~4 seconds. The image-generation phase already
 * picks N = ceil(audio / 4), so audio / N ≈ 4. With crossfades overlapping by T,
 * the exact per-image duration that makes the chain sum to the audio length is:
 *
 *      D = (audioDuration + (N - 1) * T) / N
 *
 * For a typical 16s voiceover (N=4, T=0.5): D = (16 + 1.5) / 4 = 4.375s ≈ 4s. ✓
 */
export function computePerImageDuration(
  audioDuration: number,
  imageCount: number,
  transition: number
): number {
  if (imageCount <= 1) return audioDuration
  return (audioDuration + (imageCount - 1) * transition) / imageCount
}

/**
 * Build the FFmpeg argument list that assembles images + audio into a 1920×1080
 * H.264 MP4 with smooth `xfade` crossfades between consecutive images.
 *
 * Strategy:
 *  - Each image is fed via `-loop 1 -t (D+buffer)` so frames are always available.
 *  - A `scale + pad + fps + format` filter normalises every image to 16:9 Full HD.
 *  - A chain of `xfade=transition=fade` nodes dissolves each image into the next.
 *    The i-th xfade (1-indexed) starts at offset O_i = i * (D - T).
 *  - The audio is muxed in as the soundtrack.
 *  - `-shortest` trims any tiny rounding mismatch to the audio length.
 *
 * For N = 1 there are no xfades — the single image is shown for the full audio
 * duration.
 */
export function buildVideoCommand(opts: VideoBuildOptions): string[] {
  const {
    imagePaths,
    audioPath,
    outputPath,
    audioDuration,
    width,
    height,
    fps,
    transitionDuration
  } = opts

  const N = imagePaths.length
  if (N < 1) throw new Error('No images available to assemble into a video.')

  const D = computePerImageDuration(audioDuration, N, transitionDuration)
  // Cap the transition so it never exceeds a third of a single image's slot.
  const T = Math.min(transitionDuration, D / 3)
  // Small extra time on each image input so the xfade always has frames to
  // sample at the transition boundary (defends against off-by-one starvation).
  const perInputDuration = D + Math.max(T, 0.5)

  const args: string[] = ['-y', '-hide_banner']

  // ── Image inputs (indices 0 .. N-1) ──
  for (const img of imagePaths) {
    args.push('-loop', '1', '-t', perInputDuration.toFixed(4), '-i', img)
  }
  // ── Audio input (index N) ──
  args.push('-i', audioPath)

  // ── filter_complex ──
  // Issue 2a fix: crop-to-fill (object-fit: cover) instead of pad/letterbox —
  // center-crop fills the whole 16:9 frame with no black bars. Non-16:9
  // sources (4:3, square, portrait stock photos) now cover-crop exactly.
  const parts: string[] = []
  for (let i = 0; i < N; i++) {
    parts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    )
  }

  if (N === 1) {
    // Single image — no crossfade; map [v0] directly.
    args.push('-filter_complex', parts.join(';'))
    args.push('-map', '[v0]', '-map', `${N}:a`)
  } else {
    // Chain xfades: [v0][v1]xfade...[vx1]; [vx1][v2]xfade...[vx2]; ...
    const chain: string[] = [...parts]
    let prev = 'v0'
    for (let i = 1; i < N; i++) {
      const offset = i * (D - T)
      const label = i === N - 1 ? 'vout' : `vx${i}`
      chain.push(
        `[${prev}][v${i}]xfade=transition=fade:duration=${T.toFixed(4)}:offset=${offset.toFixed(4)}[${label}]`
      )
      prev = label
    }
    args.push('-filter_complex', chain.join(';'))
    args.push('-map', '[vout]', '-map', `${N}:a`)
  }

  // ── Encoding (H.264 + AAC, faststart for web playback) ──
  // preset=veryfast keeps encoding quick on modest hardware; crf=23 is visually
  // lossless for photo-based slideshows.
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath
  )

  return args
}

// ─── Progress parsing ─────────────────────────────────────────────────────────

/**
 * Parse a `time=HH:MM:SS.ss` value out of an FFmpeg stderr chunk and return the
 * equivalent seconds, or null if no timecode is present.
 */
export function parseFfmpegTime(text: string): number | null {
  const matches = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  const secs =
    parseInt(last[1], 10) * 3600 +
    parseInt(last[2], 10) * 60 +
    parseFloat(last[3])
  return Number.isFinite(secs) ? secs : null
}

// ─── Duration probing ─────────────────────────────────────────────────────────

/** Run ffprobe and return the media duration in seconds. */
export async function probeDuration(filePath: string): Promise<number> {
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

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Spawn FFmpeg with the assembled command, stream-progress the `time=` field
 * from stderr, and resolve with { duration, sizeBytes } on a clean exit.
 *
 * Rejects with a trimmed stderr tail on non-zero exit or spawn failure.
 */
export function runFfmpegVideo(opts: VideoBuildOptions): Promise<VideoBuildResult> {
  return new Promise((resolve, reject) => {
    const args = buildVideoCommand(opts)
    let stderrBuf = ''
    let lastPct = 0

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      reject(new Error(`Failed to start FFmpeg: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    const stdoutPath = opts.outputPath
    let stderrClosed = false
    let procExited = false

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
      // Keep the buffer bounded so a 10-minute encode doesn't eat memory.
      if (stderrBuf.length > 60000) stderrBuf = stderrBuf.slice(-60000)

      const secs = parseFfmpegTime(text)
      if (secs !== null) {
        const pct = Math.min(99, Math.max(0, (secs / opts.audioDuration) * 100))
        if (pct > lastPct) {
          lastPct = pct
          opts.onProgress?.(Math.round(pct * 10) / 10)
        }
      }
    })

    const finalize = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (procExited) return
      procExited = true

      if (code !== 0) {
        const tail = stderrBuf.slice(-2500).trim()
        reject(
          new Error(
            `FFmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${
              tail ? `Last output:\n${tail}` : 'No output captured.'
            }`
          )
        )
        return
      }

      // Success — verify the output file exists and probe its duration/size.
      try {
        const stat = fs.statSync(stdoutPath)
        if (stat.size < 1000) {
          reject(new Error('FFmpeg reported success but the output file is empty or missing.'))
          return
        }
        let duration = opts.audioDuration
        try {
          const probed = await probeDuration(stdoutPath)
          if (probed > 0) duration = probed
        } catch {
          // fall back to the audio duration we already know
        }
        // Bump progress to 100 now that the file is verified.
        opts.onProgress?.(100)
        resolve({ durationSeconds: Math.round(duration * 10) / 10, sizeBytes: stat.size })
      } catch (err) {
        reject(new Error(`Output file verification failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }

    proc.on('error', (err) => {
      if (procExited) return
      procExited = true
      reject(new Error(`FFmpeg failed to launch: ${err.message}`))
    })

    proc.on('exit', (code, signal) => finalize(code, signal))

    // Guard against the stderr stream closing before 'exit' fires (rare).
    proc.stderr.on('end', () => {
      stderrClosed = true
    })
    void stderrClosed
  })
}

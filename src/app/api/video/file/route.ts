import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Root directory under which assembled video files are stored. */
const VIDEO_ROOT = process.env.AUTOTUBE_VIDEO_DIR || '/tmp/autotube-videos'

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * GET /api/video/file?jobId=...
 *
 * Serves the assembled MP4 file for a previously-completed video job. Supports
 * HTTP `Range:` requests so the browser's <video> player can seek freely
 * (browsers always send Range for media — without range support, the whole
 * file would be downloaded before playback starts).
 *
 * Returns:
 *   200 / 206 + video/mp4 body  — on success
 *   404 + JSON error             — when the job/file does not exist
 *   400 + JSON error             — when the jobId is missing or invalid
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')

  if (!jobId || !/^[a-f0-9-]{1,64}$/i.test(jobId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid or missing jobId.' },
      { status: 400 }
    )
  }

  const filePath = path.join(VIDEO_ROOT, jobId, 'final.mp4')

  // Defense in depth against path traversal.
  const resolvedRoot = path.resolve(VIDEO_ROOT)
  const resolvedFile = path.resolve(filePath)
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
    return NextResponse.json(
      { success: false, error: 'Invalid path.' },
      { status: 400 }
    )
  }

  if (!fs.existsSync(resolvedFile)) {
    return NextResponse.json(
      {
        success: false,
        error:
          'Video file not found. It may still be assembling, may have failed, or the job may have expired (videos are kept for 1 hour).'
      },
      { status: 404 }
    )
  }

  try {
    const stat = fs.statSync(resolvedFile)
    const fileSize = stat.size
    const range = req.headers.get('range')

    // ── Range request → 206 Partial Content ──
    if (range) {
      // Parse "bytes=START-END" (END is optional).
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const validStart = Number.isFinite(start) && start >= 0 && start < fileSize
        const validEnd = Number.isFinite(end) && end >= start && end < fileSize
        if (validStart && validEnd) {
          const chunkSize = end - start + 1
          const fd = fs.openSync(resolvedFile, 'r')
          try {
            const buffer = Buffer.alloc(chunkSize)
            fs.readSync(fd, buffer, 0, chunkSize, start)
            return new NextResponse(new Uint8Array(buffer), {
              status: 206,
              headers: {
                'Content-Type': 'video/mp4',
                'Content-Length': String(chunkSize),
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=3600'
              }
            })
          } finally {
            fs.closeSync(fd)
          }
        }
      }
      // Malformed range → 416 (browsers will retry with a full request)
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`
        }
      })
    }

    // ── Full request → 200 OK with the whole file ──
    const buffer = fs.readFileSync(resolvedFile)
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      }
    })
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to read the video file.' },
      { status: 500 }
    )
  }
}

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const IMAGE_DIR_ROOT = '/tmp/autotube-images'

/**
 * Serve a generated image by jobId + index. Supports HTTP Range for video
 * player seek (though images are small, the player may request ranges).
 * Images are stored at /tmp/autotube-images/<jobId>/<index>.jpg.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')
  const indexParam = req.nextUrl.searchParams.get('index')
  if (!jobId || indexParam === null) {
    return NextResponse.json({ error: 'Missing jobId or index query param.' }, { status: 400 })
  }
  const index = parseInt(indexParam, 10)
  if (Number.isNaN(index) || index < 0) {
    return NextResponse.json({ error: 'index must be a non-negative integer.' }, { status: 400 })
  }

  const filePath = path.join(IMAGE_DIR_ROOT, jobId, `${index}.jpg`)
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Image not found.' }, { status: 404 })
  }

  const stat = fs.statSync(filePath)
  const range = req.headers.get('range')

  // Full file (no range request).
  if (!range) {
    const buf = fs.readFileSync(filePath)
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes'
      }
    })
  }

  // Range request (206 Partial Content).
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) {
    return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
  }
  const start = match[1] ? parseInt(match[1], 10) : 0
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1
  if (start > end || start >= stat.size) {
    return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
  }
  const chunkSize = end - start + 1
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(chunkSize)
  fs.readSync(fd, buf, 0, chunkSize, start)
  fs.closeSync(fd)
  return new NextResponse(new Uint8Array(buf), {
    status: 206,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600'
    }
  })
}

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { getVideoOutputPath } from '@/lib/video-assembly'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Stream the finished MP4 with HTTP Range support so the <video> element can
 * seek freely. Path: /api/video/download?jobId=xxx
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId query param.' }, { status: 400 })
  }

  const filePath = getVideoOutputPath(jobId)
  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: 'Video file not found. The job may not be done yet or has expired.' },
      { status: 404 }
    )
  }

  const stat = fs.statSync(filePath)
  const fileSize = stat.size
  const range = req.headers.get('range')

  // No range → serve the whole file (200 OK). Browsers usually send range.
  if (!range) {
    const buf = fs.readFileSync(filePath)
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'Content-Disposition': `attachment; filename="autotube-${jobId}.mp4"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600'
      }
    })
  }

  // Range request → 206 Partial Content
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) {
    return new NextResponse(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` }
    })
  }
  const start = match[1] ? parseInt(match[1], 10) : 0
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
  if (start > end || start >= fileSize) {
    return new NextResponse(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` }
    })
  }
  const chunkSize = end - start + 1
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(chunkSize)
  fs.readSync(fd, buf, 0, chunkSize, start)
  fs.closeSync(fd)

  return new NextResponse(new Uint8Array(buf), {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600'
    }
  })
}

import { NextResponse } from 'next/server'
import { getBridgeFrame } from '@/lib/flow-bridge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/flow-bridge/frame — live-view screenshot of the REAL Google Flow
 * page open in the bridge's Chromium (JPEG, no-store). 503 when the bridge
 * has no page yet — the client <img> falls back to its offline placeholder.
 */
export async function GET() {
  const buf = await getBridgeFrame()
  if (!buf) {
    return new NextResponse('bridge frame unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store' }
    })
  }
  return new NextResponse(buf, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'no-store'
    }
  })
}

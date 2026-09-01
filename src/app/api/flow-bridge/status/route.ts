import { NextResponse } from 'next/server'
import { getBridgeStatus } from '@/lib/flow-bridge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/flow-bridge/status — Flow Bridge health for the pause UI.
 * Returns { ok:false, offline:true, ... } when the bridge process is not
 * running — the manual handoff stays available in that case.
 */
export async function GET() {
  const status = await getBridgeStatus()
  return NextResponse.json(status)
}

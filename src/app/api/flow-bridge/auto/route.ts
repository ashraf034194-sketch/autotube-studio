import { NextRequest, NextResponse } from 'next/server'
import {
  cleanupExpiredAutoRuns,
  getFlowAutoRun,
  serializeRun,
  startFlowAuto,
  stopFlowAuto
} from '@/lib/autopilot/flow-auto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Flow Bridge auto-generation endpoints.
 *
 *   GET  /api/flow-bridge/auto?autopilotId=…   → engine state (or none)
 *   POST /api/flow-bridge/auto { autopilotId } → start the engine
 *   POST /api/flow-bridge/auto { autopilotId, action: 'stop' } → stop it
 *
 * The engine drives the REAL Google Flow page via the bridge, saves each
 * finished image into its slot, and — when every slot is filled — calls
 * flow-finish internally so video assembly resumes with zero clicks.
 */
export async function GET(req: NextRequest) {
  cleanupExpiredAutoRuns()
  const autopilotId = req.nextUrl.searchParams.get('autopilotId')
  if (!autopilotId) {
    return NextResponse.json({ error: 'Missing autopilotId query parameter.' }, { status: 400 })
  }
  const run = getFlowAutoRun(autopilotId)
  return NextResponse.json(run ? serializeRun(run) : { autopilotId, status: 'none' })
}

export async function POST(req: NextRequest) {
  cleanupExpiredAutoRuns()

  let body: { autopilotId?: string; action?: string }
  try {
    body = (await req.json()) as { autopilotId?: string; action?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!body.autopilotId) {
    return NextResponse.json({ error: 'Missing autopilotId.' }, { status: 400 })
  }

  if (body.action === 'stop') {
    const res = stopFlowAuto(body.autopilotId)
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  if (body.action && body.action !== 'start') {
    return NextResponse.json(
      { error: `Unknown action "${body.action}" — use "start" (default) or "stop".` },
      { status: 400 }
    )
  }

  const res = await startFlowAuto(body.autopilotId)
  if (!res.ok) return NextResponse.json(res, { status: 409 })
  return NextResponse.json(res)
}

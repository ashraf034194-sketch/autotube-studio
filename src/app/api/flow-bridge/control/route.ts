import { NextRequest, NextResponse } from 'next/server'
import { bridgeControl } from '@/lib/flow-bridge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/flow-bridge/control — remote-control relay for the bridge's
 * Chromium (the "second tab" with the real Google Flow). The pause UI uses
 * this to: open the Flow login page, open Google's own sign-in page
 * ("Sign in with Google" — email / phone-tap / QR / account chooser),
 * click/typing for the Google sign-in (live view), reload, and switch
 * simulation/real mode.
 *
 * Actions: login | google-signin | open-app | reload | back | click | type | key | mode | close-browser
 */
const ACTIONS = new Set([
  'login', 'google-signin', 'open-app', 'reload', 'back', 'click', 'type', 'key', 'mode', 'close-browser'
])

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const action = String(body.action ?? '')
  if (!ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `Unknown action "${action}" — use one of ${[...ACTIONS].join(', ')}.` },
      { status: 400 }
    )
  }

  // Validate the security-relevant payloads here (defense in depth — the
  // bridge validates again with the same rules).
  if (action === 'click') {
    const x = Number(body.x)
    const y = Number(body.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      return NextResponse.json({ error: 'click expects normalized x/y in [0,1].' }, { status: 400 })
    }
  }
  if (action === 'type' && (typeof body.text !== 'string' || !body.text || body.text.length > 500)) {
    return NextResponse.json({ error: 'type expects text (max 500 chars).' }, { status: 400 })
  }
  if (action === 'mode' && body.mode !== 'simulation' && body.mode !== 'real') {
    return NextResponse.json({ error: "mode must be 'simulation' or 'real'." }, { status: 400 })
  }
  if (action === 'key' && typeof body.key !== 'string') {
    return NextResponse.json({ error: 'key expects a key name.' }, { status: 400 })
  }

  const res = await bridgeControl(action, body)
  return NextResponse.json(res, { status: res.ok ? 200 : 502 })
}

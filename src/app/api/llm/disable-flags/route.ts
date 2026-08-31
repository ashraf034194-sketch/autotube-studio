import { NextRequest, NextResponse } from 'next/server'
import {
  setLlmDisableFlags,
  llmProviderStatus
} from '@/lib/llm-wrapper'

// ─── /api/llm/disable-flags — TEST-ONLY endpoint for flipping the LLM tier ─
// disable flags at RUNTIME, without restarting the dev server.
//
// WHY: the smart retry-queue + 3-tier fallback chain (Z.ai → Cloudflare →
// Groq → retry-queue) need to be tested by SIMULATING all-three-failures.
// Restarting the dev server with LLM_DISABLE_* env vars set would kill the
// persistent dev server (which the user explicitly asked us not to do).
// This endpoint flips in-memory runtime overrides that take precedence over
// env vars — so a test script can simulate failures in the live dev server
// and reset them when done.
//
// USAGE:
//   GET  /api/llm/disable-flags              → returns current flag state
//   POST /api/llm/disable-flags              → body: { zai: true, cloudflare: true, groq: false }
//                                            → sets the flags, returns new state
//   POST /api/llm/disable-flags (body: {})   → no changes, returns current state
//   POST /api/llm/disable-flags (body: {reset:true}) → resets all to env-var defaults

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      flags: {
        zai: llmProviderStatus().zai,
        cloudflare: llmProviderStatus().cloudflare,
        groq: llmProviderStatus().groq,
        retryQueue: llmProviderStatus().retryQueue
      },
      note: 'POST with {zai:true/false, cloudflare:true/false, groq:true/false} to set. POST with {reset:true} to reset to env defaults.'
    }
  })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body.' },
      { status: 400 }
    )
  }

  const { zai, cloudflare, groq, reset } = (body ?? {}) as {
    zai?: boolean
    cloudflare?: boolean
    groq?: boolean
    reset?: boolean
  }

  // Reset: flip all three flags to false (env vars still apply, but in dev
  // they're not set so this effectively re-enables all three tiers).
  if (reset) {
    const newFlags = setLlmDisableFlags({
      zai: false,
      cloudflare: false,
      groq: false
    })
    return NextResponse.json({
      success: true,
      data: {
        flags: {
          zai: { live: !newFlags.zai },
          cloudflare: { live: !newFlags.cloudflare },
          groq: { live: !newFlags.groq }
        },
        message: 'All disable flags reset to false (env-var defaults apply).'
      }
    })
  }

  const newFlags = setLlmDisableFlags({
    zai: typeof zai === 'boolean' ? zai : undefined,
    cloudflare: typeof cloudflare === 'boolean' ? cloudflare : undefined,
    groq: typeof groq === 'boolean' ? groq : undefined
  })

  return NextResponse.json({
    success: true,
    data: {
      flags: {
        zai: {
          live: !newFlags.zai,
          reason: newFlags.zai ? 'disabled via runtime override' : undefined
        },
        cloudflare: {
          live: !newFlags.cloudflare,
          reason: newFlags.cloudflare ? 'disabled via runtime override' : undefined
        },
        groq: {
          live: !newFlags.groq,
          reason: newFlags.groq ? 'disabled via runtime override' : undefined
        }
      }
    }
  })
}

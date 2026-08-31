import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
  generateWithNanoBanana2,
  NANO_BANANA_2_STYLE_DNA,
  NANO_BANANA_2_WIDTH,
  NANO_BANANA_2_HEIGHT
} from '@/lib/image-providers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── GET /api/nano-banana-2 — Tool documentation for external integrators ──
//
// Returns the tool's name, pricing, quality, and a copy-pasteable integration
// example. This is what an external developer hits first to learn the API.
export async function GET() {
  return NextResponse.json({
    name: 'Nano Banana 2',
    tagline: 'FREE + UNLIMITED highest-quality image generation (≥ Gemini 2.5 Flash Image / Nano Banana)',
    pricing: 'FREE · UNLIMITED · no API key required',
    quality: 'highest class — cinematic photorealistic 16:9, matches or exceeds Nano Banana',
    engines: [
      { name: 'Cloudflare Workers AI', model: 'FLUX.1-schnell', role: 'primary', speed: '~1.5s/image' },
      { name: 'Pollinations.ai', model: 'flux', role: 'fallback', speed: '~3-5s/image' },
      { name: 'Z.ai SDK', model: 'bundled', role: 'final fallback', speed: '~2-4s/image' }
    ],
    styleDna: NANO_BANANA_2_STYLE_DNA,
    dimensions: {
      width: NANO_BANANA_2_WIDTH,
      height: NANO_BANANA_2_HEIGHT,
      aspectRatio: '16:9'
    },
    endpoints: {
      generate: {
        method: 'POST',
        path: '/api/nano-banana-2',
        requestFormat: {
          prompt: 'string (required, 3-2000 chars) — the image description',
          width: 'number (optional, default 2048) — override output width',
          height: 'number (optional, default 1152) — override output height'
        },
        responseFormat: {
          ok: 'boolean — true on success',
          provider: 'string — always "nanoBanana2"',
          engine: 'string — which engine produced the image (cloudflare-flux-schnell | pollinations-flux | zai-sdk)',
          bytes: 'number — image size in bytes',
          mimeType: 'string — always "image/jpeg"',
          imageBase64: 'string — base64-encoded JPEG image data',
          styledPrompt: 'string — the actual prompt sent to the engine (with Style DNA prepended)',
          durationMs: 'number — generation time in milliseconds'
        }
      },
      docs: { method: 'GET', path: '/api/nano-banana-2' }
    },
    example: {
      request: { prompt: 'a serene mountain lake at sunrise with mist rising from the water' },
      curl:
        "curl -X POST https://YOUR-DOMAIN/api/nano-banana-2 " +
        "-H 'Content-Type: application/json' " +
        "-d '{\"prompt\":\"a serene mountain lake at sunrise with mist rising from the water\"}'"
    },
    notes: [
      'Every prompt is automatically prepended with a cinematic Style DNA preamble — no need to craft long prompts.',
      'Even a 3-word prompt produces a polished, film-grade 16:9 frame.',
      'The composite never permanently fails — if all 3 engines are simultaneously down, the outer retry-queue waits 30s→60s→2min→5min and retries.',
      'No authentication required. No rate limit on the tool itself (the underlying engines have their own limits but the composite auto-falls-back).'
    ]
  })
}

// ─── POST /api/nano-banana-2 — Generate one Nano Banana 2 image ─────────────
//
// Body: { prompt: string, width?: number, height?: number }
// Returns: { ok, provider, engine, imageBase64, mimeType, bytes, styledPrompt, durationMs }
//
// The image is generated to a temp file, read back as base64, and the temp
// file is deleted — so the caller always gets a clean base64 payload they can
// embed directly in their own system (no file hosting needed on this server).
export async function POST(req: Request) {
  const startedAt = Date.now()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body. Expected { prompt: string }.' },
      { status: 400 }
    )
  }

  const prompt = (body as { prompt?: unknown })?.prompt
  if (typeof prompt !== 'string' || prompt.trim().length < 3) {
    return NextResponse.json(
      { ok: false, error: 'prompt is required (min 3 chars).' },
      { status: 400 }
    )
  }
  if (prompt.length > 2000) {
    return NextResponse.json(
      { ok: false, error: 'prompt too long (max 2000 chars).' },
      { status: 400 }
    )
  }

  // Temp output path — deleted after we read back as base64.
  const tmpDir = '/tmp/nano-banana-2'
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  const outPath = path.join(
    tmpDir,
    `nb2-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`
  )

  try {
    const result = await generateWithNanoBanana2(prompt, outPath)
    const durationMs = Date.now() - startedAt

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          provider: 'nanoBanana2',
          durationMs
        },
        { status: 502 }
      )
    }

    // Read back as base64 for the response payload.
    let buf: Buffer
    try {
      buf = fs.readFileSync(result.outPath)
    } catch (readErr) {
      console.error('[nano-banana-2] Failed to read generated image file:', readErr)
      return NextResponse.json(
        {
          ok: false,
          error: `Generated image but could not read it back: ${readErr instanceof Error ? readErr.message : 'unknown'}`,
          provider: 'nanoBanana2',
          durationMs
        },
        { status: 500 }
      )
    }

    const imageBase64 = buf.toString('base64')
    const engine = (result.meta?.engine as string) || 'unknown'
    const model = (result.meta?.model as string) || ''

    // Cleanup temp file — the caller holds the base64 payload now.
    try {
      fs.unlinkSync(result.outPath)
    } catch {
      // non-fatal — temp file will be cleaned by OS tmp rotation
    }

    const styledPrompt = `${NANO_BANANA_2_STYLE_DNA}${prompt}`

    return NextResponse.json({
      ok: true,
      provider: 'nanoBanana2',
      engine,
      model,
      bytes: buf.length,
      mimeType: 'image/jpeg',
      imageBase64,
      styledPrompt,
      durationMs,
      dimensions: { width: NANO_BANANA_2_WIDTH, height: NANO_BANANA_2_HEIGHT, aspectRatio: '16:9' }
    })
  } catch (err) {
    const durationMs = Date.now() - startedAt
    console.error('[nano-banana-2] Unhandled error:', err)
    return NextResponse.json(
      {
        ok: false,
        error: `Internal error: ${err instanceof Error ? err.message : 'unknown'}`,
        provider: 'nanoBanana2',
        durationMs
      },
      { status: 500 }
    )
  }
}

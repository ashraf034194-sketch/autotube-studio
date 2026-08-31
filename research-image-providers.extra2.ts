/**
 * research-image-providers.extra2.ts
 *
 * Round-3 with per-page save (so a single hang doesn't lose all results).
 */

import ZAI from 'z-ai-web-dev-sdk'
import { readFileSync, writeFileSync } from 'fs'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PAGES: { id: string; url: string }[] = [
  { id: 'cf_workers_pricing', url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/' },
  { id: 'cf_flux_schnell', url: 'https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/' },
  { id: 'puter_free', url: 'https://developer.puter.com/tutorials/free-unlimited-image-generation-api' },
  { id: 'together_flux_schnell', url: 'https://www.together.ai/models/flux-1-schnell' },
  { id: 'replicate_tryfree', url: 'https://replicate.com/collections/try-for-free' },
  { id: 'hf_inference_index', url: 'https://huggingface.co/docs/inference-providers/en/index' },
  { id: 'prodia_ref', url: 'https://prodia.readme.io/reference/generate' },
  { id: 'deapi_ai', url: 'https://deapi.ai/use-cases/text-to-image' },
  { id: 'nscale_imagegen', url: 'https://docs.nscale.com/docs/use-cases/image-generation' }
]

async function fetchOne(zai: any, id: string, url: string): Promise<{ ok: boolean; text?: string; title?: string; err?: string }> {
  // 60s timeout per fetch via Promise.race
  const fetchPromise = zai.functions.invoke('page_reader', { url })
  const timeout = new Promise<{ ok: false; err: string }>((resolve) =>
    setTimeout(() => resolve({ ok: false, err: 'timeout 60s' }), 60_000)
  )
  const result = await Promise.race([fetchPromise, timeout])
  if (!('data' in (result || {})) && !result?.data) {
    return { ok: false, err: (result as any)?.err || 'no data' }
  }
  const data = (result as any).data
  const text =
    (data?.html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000)
  return { ok: true, text, title: data?.title }
}

async function main() {
  const zai = await ZAI.create()
  const outPath = '/home/z/my-project/research-image-providers.results.json'
  const out = JSON.parse(readFileSync(outPath, 'utf-8'))

  for (const { id, url } of PAGES) {
    try {
      console.log(`[extra2] page ${id} (${url}) ...`)
      const r = await fetchOne(zai, id, url)
      if (r.ok) {
        out.pages[id] = { url, title: r.title, textExcerpt: r.text }
        console.log(`  ✓ ${id}: ${r.text?.length} chars`)
      } else {
        out.pages[id] = { url, error: r.err || 'unknown' }
        console.error(`  ✗ ${id}: ${r.err}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.pages[id] = { url, error: msg }
      console.error(`  ✗ ${id}: ${msg.slice(0, 140)}`)
    }
    // Save after every fetch (idempotent — preserves results even on crash)
    writeFileSync(outPath, JSON.stringify(out, null, 2))
    await sleep(5000)
  }

  console.log(`[extra2] saved ${outPath}`)
}

main().catch((err) => {
  console.error('[extra2] FATAL:', err)
  process.exit(1)
})

/**
 * research-image-providers.extra.ts
 *
 * Round-3 page reads on remaining high-value docs pages that we missed:
 *   - Cloudflare Workers AI pricing (free allocation per day)
 *   - Puter.js (free, no-key)
 *   - Together AI FLUX.1-schnell free endpoint
 *   - Replicate try-for-free collection
 *   - HuggingFace inference-providers index (revised URL)
 *   - Prodia docs (revised URL)
 *   - deAPI.ai free tier
 *   - BFL docs/pricing (alternative URL)
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

async function main() {
  const zai = await ZAI.create()
  const outPath = '/home/z/my-project/research-image-providers.results.json'
  const out = JSON.parse(readFileSync(outPath, 'utf-8'))

  for (const { id, url } of PAGES) {
    try {
      console.log(`[extra] page ${id} (${url}) ...`)
      const result: any = await zai.functions.invoke('page_reader', { url })
      const text =
        (result?.data?.html || '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 6000)
      out.pages[id] = { url, title: result?.data?.title, publishedTime: result?.data?.publishedTime, textExcerpt: text }
      console.log(`  ✓ ${id}: ${text.length} chars  (${result?.data?.title?.slice(0, 60)})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.pages[id] = { url, error: msg }
      console.error(`  ✗ ${id}: ${msg.slice(0, 140)}`)
    }
    await sleep(6000)
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`[extra] saved ${outPath}`)
}

main().catch((err) => {
  console.error('[extra] FATAL:', err)
  process.exit(1)
})

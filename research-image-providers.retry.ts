/**
 * research-image-providers.retry.ts
 *
 * Sequential retry of the queries / pages that hit 429s or 500s in the first
 * pass. Writes back into the same results JSON file. Reuses ZAI.create().
 */

import ZAI from 'z-ai-web-dev-sdk'
import { readFileSync, writeFileSync } from 'fs'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const RETRY_QUERIES: { id: string; query: string; num?: number }[] = [
  { id: 'general_endpoints_list', query: 'free text-to-image API endpoints list 2025', num: 8 },
  { id: 'huggingface_providers', query: 'HuggingFace Inference free providers list FLUX Stable Diffusion 2025', num: 8 },
  { id: 'together_ai', query: 'Together AI free tier image generation FLUX', num: 8 },
  { id: 'cloudflare', query: 'Cloudflare Workers AI free image generation FLUX models', num: 8 },
  { id: 'leonardo', query: 'Leonardo.ai free API image generation tokens', num: 8 },
  { id: 'runway', query: 'Runway free image generation API endpoint', num: 8 },
  { id: 'dezgo', query: 'Dezgo free image generation API pricing', num: 8 },
  { id: 'craiyon', query: 'Craiyon free image generation API endpoint 2025', num: 8 },
  { id: 'glif', query: 'Glif API free image generation endpoint', num: 8 },
  { id: 'prodia', query: 'Prodia free image generation API no key documentation', num: 8 }
]

const RETRY_PAGES: { id: string; url: string }[] = [
  { id: 'pollinations_github', url: 'https://raw.githubusercontent.com/pollinations/pollinations/master/APIDOCS.md' },
  { id: 'pollinations_readme', url: 'https://pollinations.ai/' },
  { id: 'prodia_docs', url: 'https://docs.prodia.com/reference/introduction' },
  { id: 'cloudflare_workers_models', url: 'https://developers.cloudflare.com/workers-ai/models/' },
  { id: 'bfl_pricing', url: 'https://docs.bfl.ai/' },
  { id: 'dezgo_docs', url: 'https://docs.dezgo.com/' }
]

async function main() {
  const zai = await ZAI.create()
  const outPath = '/home/z/my-project/research-image-providers.results.json'
  const out = JSON.parse(readFileSync(outPath, 'utf-8'))

  for (const { id, query, num } of RETRY_QUERIES) {
    try {
      console.log(`[retry] search ${id} ...`)
      const results = await zai.functions.invoke('web_search', { query, num: num ?? 8 })
      out.searches[id] = { query, results }
      console.log(`  ✓ ${id}: ${(results as any[]).length} hits`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.searches[id] = { query, results: [], error: msg }
      console.error(`  ✗ ${id}: ${msg.slice(0, 120)}`)
    }
    await sleep(7000) // 7s between calls to avoid 429
  }

  for (const { id, url } of RETRY_PAGES) {
    try {
      console.log(`[retry] page ${id} (${url}) ...`)
      const result: any = await zai.functions.invoke('page_reader', { url })
      const text =
        (result?.data?.html || '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4500)
      out.pages[id] = { url, title: result?.data?.title, publishedTime: result?.data?.publishedTime, textExcerpt: text }
      console.log(`  ✓ ${id}: ${text.length} chars`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.pages[id] = { url, error: msg }
      console.error(`  ✗ ${id}: ${msg.slice(0, 120)}`)
    }
    await sleep(7000)
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`[retry] saved ${outPath}`)
}

main().catch((err) => {
  console.error('[retry] FATAL:', err)
  process.exit(1)
})

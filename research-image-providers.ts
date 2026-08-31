/**
 * research-image-providers.ts
 *
 * Research-only script. Uses z-ai-web-dev-sdk's `web_search` + `page_reader`
 * functions to gather pricing/quota/endpoint information for a wide list of
 * image-generation API providers in 2025.
 *
 * Usage:
 *   bun /home/z/my-project/research-image-providers.ts
 *
 * Output:
 *   /home/z/my-project/research-image-providers.results.json
 *
 * NOTE: This script is RESEARCH-ONLY. It does NOT modify any source files.
 * The results JSON is read by the human (and the markdown report
 * `research-image-providers.md` is then written by hand).
 */

import ZAI from 'z-ai-web-dev-sdk'
import { writeFileSync } from 'fs'

// ─── Search queries ──────────────────────────────────────────────────────────

const SEARCH_QUERIES: { id: string; query: string; num?: number }[] = [
  // Broad surveys
  { id: 'general_free_apis_2025', query: 'free image generation API 2025 no API key', num: 10 },
  { id: 'general_endpoints_list', query: 'free text-to-image API endpoints list 2025', num: 10 },

  // Specific providers (must cover all candidates from the task spec)
  { id: 'pollinations', query: 'Pollinations.ai free image generation API documentation', num: 8 },
  { id: 'huggingface_providers', query: 'HuggingFace Inference free providers list FLUX Stable Diffusion 2025', num: 10 },
  { id: 'together_ai', query: 'Together AI free tier image generation FLUX', num: 8 },
  { id: 'replicate', query: 'Replicate free credits image generation new account', num: 8 },
  { id: 'fal_ai', query: 'fal.ai free credits image generation quota', num: 8 },
  { id: 'cloudflare', query: 'Cloudflare Workers AI free image generation FLUX models', num: 8 },
  { id: 'segmind', query: 'Segmind free image generation API tier', num: 8 },
  { id: 'leonardo', query: 'Leonardo.ai free API image generation tokens', num: 8 },
  { id: 'eden_ai', query: 'Eden AI free image generation API gateway', num: 8 },
  { id: 'runway', query: 'Runway free image generation API endpoint', num: 8 },
  { id: 'craiyon', query: 'Craiyon free image generation API endpoint 2025', num: 8 },
  { id: 'dezgo', query: 'Dezgo free image generation API pricing', num: 8 },

  // Additional candidates discovered during initial searches
  { id: 'blackforestlabs', query: 'Black Forest Labs BFL API free credits FLUX.1', num: 8 },
  { id: 'novita', query: 'Novita AI free image generation API key', num: 8 },
  { id: 'glif', query: 'Gliff Glif API free image generation', num: 8 },
  { id: 'ryrob_streamdiffusion', query: 'free hosted Stable Diffusion API endpoint no auth 2025', num: 8 },
  { id: 'prodia', query: 'Prodia free image generation API no key', num: 8 },
  { id: 'automa_api', query: 'free image generation REST API curl 2025', num: 10 },
  { id: 'nscale_direct', query: 'nscale FLUX.1-schnell free API endpoint huggingface', num: 8 },
  { id: 'flux_labs_official', query: 'FLUX.1 official API free tier pricing bfl', num: 8 }
]

// ─── Page-reader targets ───────────────────────────────────────────────────
//
// These are official docs / pricing pages we want to fetch in full to confirm
// quota / endpoint shape. Hand-picked based on which providers are most likely
// to be added to the chain. Keep this list short — page_reader is slow.

const PAGE_READER_TARGETS: { id: string; url: string }[] = [
  // Pollinations — already used by Nano Banana 2 in the codebase
  { id: 'pollinations_github', url: 'https://github.com/pollinations/pollinations/blob/master/APIDOCS.md' },
  { id: 'pollinations_readme', url: 'https://pollinations.ai/' },

  // Prodia — frequently cited as free + no-auth
  { id: 'prodia_docs', url: 'https://docs.prodia.com/' },

  // Cloudflare Workers AI — boundless plan free tier
  { id: 'cloudflare_workers_models', url: 'https://developers.cloudflare.com/workers-ai/models/' },

  // Together AI pricing
  { id: 'together_pricing', url: 'https://www.together.ai/pricing' },

  // fal.ai pricing
  { id: 'fal_pricing', url: 'https://fal.ai/pricing' },

  // Replicate pricing
  { id: 'replicate_pricing', url: 'https://replicate.com/pricing' },

  // Segmind
  { id: 'segmind_pricing', url: 'https://www.segmind.com/pricing' },

  // Leonardo API
  { id: 'leonardo_api_docs', url: 'https://docs.leonardo.ai/' },

  // Eden AI
  { id: 'edenai_docs', url: 'https://docs.edenai.ai/' },

  // Dezgo
  { id: 'dezgo_docs', url: 'https://docs.dezgo.com/' },

  // BFL official
  { id: 'bfl_pricing', url: 'https://bfl.ai/' },

  // Novita
  { id: 'novita_pricing', url: 'https://novita.ai/pricing' },

  // HuggingFace inference providers
  { id: 'hf_inference_providers', url: 'https://huggingface.co/docs/inference/en/index' }
]

// ─── Script ──────────────────────────────────────────────────────────────────

interface SearchResultItem {
  url: string
  name: string
  snippet: string
  host_name: string
  rank: number
  date: string
  favicon: string
}

interface PageReaderResult {
  code: number
  data: {
    html: string
    publishedTime?: string
    title: string
    url: string
    usage: { tokens: number }
  }
}

interface ResearchOutput {
  generatedAt: string
  searches: Record<string, { query: string; results: SearchResultItem[] | string; error?: string }>
  pages: Record<string, { url: string; title?: string; publishedTime?: string; textExcerpt?: string; error?: string }>
}

async function main() {
  console.log('[research] booting z-ai-web-dev-sdk…')
  const zai = await ZAI.create()
  console.log('[research] ZAI ready.')

  const out: ResearchOutput = {
    generatedAt: new Date().toISOString(),
    searches: {},
    pages: {}
  }

  // Phase 1 — web search for every query in parallel batches of 4
  const BATCH = 4
  for (let i = 0; i < SEARCH_QUERIES.length; i += BATCH) {
    const batch = SEARCH_QUERIES.slice(i, i + BATCH)
    console.log(`[research] search batch ${i / BATCH + 1}/${Math.ceil(SEARCH_QUERIES.length / BATCH)} (${batch.length} queries)`)
    await Promise.all(
      batch.map(async ({ id, query, num }) => {
        try {
          const results = await zai.functions.invoke('web_search', {
            query,
            num: num ?? 8
          })
          out.searches[id] = { query, results }
          console.log(`  ✓ ${id}: ${Array.isArray(results) ? results.length : 0} hits`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          out.searches[id] = { query, results: [], error: msg }
          console.error(`  ✗ ${id}: ${msg.slice(0, 120)}`)
        }
      })
    )
  }

  // Phase 2 — page_reader on official docs (slower, batch of 2)
  for (let i = 0; i < PAGE_READER_TARGETS.length; i += 2) {
    const batch = PAGE_READER_TARGETS.slice(i, i + 2)
    console.log(`[research] page batch ${i / 2 + 1}/${Math.ceil(PAGE_READER_TARGETS.length / 2)} (${batch.length} urls)`)
    await Promise.all(
      batch.map(async ({ id, url }) => {
        try {
          const result: PageReaderResult = await zai.functions.invoke('page_reader', { url })
          // Strip HTML tags for a text excerpt (keep first ~3500 chars)
          const text = (result?.data?.html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3500)
          out.pages[id] = {
            url,
            title: result?.data?.title,
            publishedTime: result?.data?.publishedTime,
            textExcerpt: text
          }
          console.log(`  ✓ ${id}: ${text.length} chars  (${result?.data?.title?.slice(0, 60)})`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          out.pages[id] = { url, error: msg }
          console.error(`  ✗ ${id}: ${msg.slice(0, 120)}`)
        }
      })
    )
  }

  // Persist
  const outPath = '/home/z/my-project/research-image-providers.results.json'
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`[research] wrote ${outPath}`)

  // Phase 3 — print a quick per-provider summary so the agent can scan results
  console.log('\n======================== QUICK SUMMARY ========================')
  for (const [id, entry] of Object.entries(out.searches)) {
    const arr = entry.results as SearchResultItem[]
    if (!Array.isArray(arr) || arr.length === 0) {
      console.log(`\n## ${id}  (${entry.query})\n  (no results)`)
      continue
    }
    console.log(`\n## ${id}  (${entry.query})`)
    for (const r of arr.slice(0, 5)) {
      console.log(`  • ${r.name}  —  ${r.host_name}`)
      console.log(`    ${r.url}`)
      console.log(`    ${r.snippet.slice(0, 180).replace(/\s+/g, ' ')}`)
    }
  }

  console.log('\n[research] done.')
}

main().catch((err) => {
  console.error('[research] FATAL:', err)
  process.exit(1)
})

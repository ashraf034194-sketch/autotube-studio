import { InferenceClient } from '@huggingface/inference'
import fs from 'fs'

const HF_TOKEN = process.env.HF_TOKEN
console.log('HF_TOKEN set?', !!HF_TOKEN, 'length:', HF_TOKEN?.length)

if (!HF_TOKEN) {
  console.error('HF_TOKEN required')
  process.exit(1)
}

process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); process.exit(2) })
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); process.exit(3) })

const client = new InferenceClient(HF_TOKEN)

async function test(model: string, provider: string): Promise<boolean> {
  const t0 = Date.now()
  console.log(`trying ${provider}/${model} ...`)
  try {
    // Add 60s timeout via AbortController
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60000)
    const image = await client.textToImage({
      provider: provider as any,
      model,
      inputs: 'a single red apple on a white table, photorealistic',
      parameters: { width: 1024, height: 576, num_inference_steps: 4 },
      // @ts-ignore
      signal: ac.signal,
    } as any)
    clearTimeout(timer)
    const buf = Buffer.from(await image.arrayBuffer())
    const ms = Date.now() - t0
    if (buf.length > 1000) {
      console.log(`  ✓ OK ${buf.length}B ${ms}ms`)
      fs.writeFileSync(`/tmp/hf-success-${provider}-${model.replace(/\//g, '-')}.bin`, buf)
      return true
    } else {
      console.log(`  ✗ tiny response (${buf.length}B): ${buf.toString().slice(0, 200)}`)
      return false
    }
  } catch (e: any) {
    const ms = Date.now() - t0
    console.log(`  ✗ err ${ms}ms: ${e.message?.slice(0, 200)}`)
    return false
  }
}

async function main() {
  console.log('--- Test 1: FLUX.1-schnell via fal-ai ---')
  await test('black-forest-labs/FLUX.1-schnell', 'fal-ai')
  console.log('--- Test 2: FLUX.1-schnell via nscale ---')
  await test('black-forest-labs/FLUX.1-schnell', 'nscale')
  console.log('--- Test 3: FLUX.1-dev via fal-ai ---')
  await test('black-forest-labs/FLUX.1-dev', 'fal-ai')
  console.log('--- Test 4: FLUX.1-dev via replicate ---')
  await test('black-forest-labs/FLUX.1-dev', 'replicate')
  console.log('--- Done ---')
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })

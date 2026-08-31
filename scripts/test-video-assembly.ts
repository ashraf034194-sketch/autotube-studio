#!/usr/bin/env bun
/**
 * Video Assembly BEFORE/AFTER timing test — runs the FULL 44-image + 3m08s
 * pipeline through POST /api/video, polls until done, and reports:
 *   - Total wall-clock time
 *   - Per-stage timing (Pass 1 per-clip encode, Pass 2 xfade/mux)
 *   - Output file size + duration
 *
 * Uses the existing 44-image job img-1788109098324-ja2cyk that's already on
 * disk + a SYNTHESIZED 188s silent audio track (ffmpeg-generated, no LLM/TTS
 * cost). This makes the test fully reproducible + fast to set up — the video
 * assembly doesn't care what's IN the audio, only its duration + format.
 *
 * Usage:
 *   bun run scripts/test-video-assembly.ts before   # baseline run
 *   bun run scripts/test-video-assembly.ts after    # post-optimization run
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const API_BASE = 'http://localhost:3000'
const PHASE = (process.argv[2] ?? 'before').toLowerCase() as 'before' | 'after'
const IMAGE_JOB_ID = 'img-1788109098324-ja2cyk' // existing 44-image job (verified in /tmp/autotube-images/)
const AUDIO_DURATION_S = 188 // 3m08s — matches the voiceover the user originally generated
const IMAGE_COUNT = 44
const SILENT_AUDIO_PATH = '/tmp/test-silent-188s.mp3'

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}

async function ensureSilentAudio(): Promise<void> {
  if (fs.existsSync(SILENT_AUDIO_PATH)) {
    const size = fs.statSync(SILENT_AUDIO_PATH).size
    if (size > 1000) {
      log(`✓ Silent audio already exists (${(size / 1024).toFixed(0)}KB)`)
      return
    }
  }
  log(`Generating 188s silent mp3 via ffmpeg (synthesizes the test audio)...`)
  execFileSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(AUDIO_DURATION_S),
      '-b:a', '192k',
      SILENT_AUDIO_PATH
    ],
    { stdio: 'pipe' }
  )
  const size = fs.statSync(SILENT_AUDIO_PATH).size
  log(`✓ Silent audio ready (${(size / 1024).toFixed(0)}KB, ${AUDIO_DURATION_S}s)`)
}

async function main(): Promise<void> {
  console.log('═'.repeat(82))
  console.log(` VIDEO ASSEMBLY ${PHASE.toUpperCase()} TIMING TEST`)
  console.log(` 44 images × ${AUDIO_DURATION_S}s audio (3m08s) — full Pass 1 + Pass 2`)
  console.log('═'.repeat(82))
  console.log()

  // ── Pre-flight checks ─────────────────────────────────────────────
  log('STEP 1 — Pre-flight checks')

  // Check dev server is up (ISSUE 1 verification)
  const healthStart = Date.now()
  try {
    const r = await fetch(`${API_BASE}/api/images/providers`, { method: 'GET' })
    const healthMs = Date.now() - healthStart
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    log(`  ✓ Dev server reachable — HTTP ${r.status} in ${healthMs}ms (ISSUE 1 confirmed: server stable)`)
  } catch (err) {
    console.error(`  ✗ Dev server unreachable: ${err}`)
    console.error('  This is the root cause of "Could not reach video API after 3 retries".')
    process.exit(1)
  }

  // Check existing 44-image job still has images on disk
  const imageDir = `/tmp/autotube-images/${IMAGE_JOB_ID}`
  if (!fs.existsSync(imageDir)) {
    console.error(`  ✗ Image directory not found: ${imageDir}`)
    console.error('  Run a fresh image generation first.')
    process.exit(1)
  }
  const imageFiles = fs.readdirSync(imageDir).filter(f => f.endsWith('.jpg'))
  log(`  ✓ Image job ${IMAGE_JOB_ID} has ${imageFiles.length} images on disk`)

  // Synthesize silent audio
  await ensureSilentAudio()
  console.log()

  // ── POST /api/video ───────────────────────────────────────────────
  log('STEP 2 — POST /api/video with 44 images + 188s silent audio')
  log('  Options: 1080p, transitions OFF (concat demuxer, stream-copy Pass 2),')
  log('           no title card, no outro, no captions, no music')
  log('  (Minimal-config baseline isolates the FFmpeg speed; toggling features adds')
  log('   LLM latency which would muddy the speed comparison.)')
  console.log()

  const audioBase64 = fs.readFileSync(SILENT_AUDIO_PATH).toString('base64')
  const postStart = Date.now()
  let postRes: Response
  try {
    postRes = await fetch(`${API_BASE}/api/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageJobId: IMAGE_JOB_ID,
        imageCount: IMAGE_COUNT,
        audioBase64,
        audioDuration: AUDIO_DURATION_S,
        mimeType: 'audio/mpeg',
        musicSource: 'none',
        script: 'Test script for video assembly timing benchmark. ' + 'Lorem ipsum '.repeat(80),
        captionsEnabled: false,
        transitionsEnabled: false,
        titleCardEnabled: false,
        textHighlightsEnabled: false,
        outroEnabled: false,
        resolution: '1080p'
      })
    })
  } catch (err) {
    const elapsed = Date.now() - postStart
    console.error(`  ✗ POST /api/video FAILED after ${elapsed}ms: ${err}`)
    console.error('  This reproduces ISSUE 1 — dev server was unreachable.')
    process.exit(1)
  }

  if (!postRes.ok) {
    const elapsed = Date.now() - postStart
    const text = await postRes.text()
    console.error(`  ✗ POST /api/video failed: HTTP ${postRes.status} after ${elapsed}ms`)
    console.error(`  body: ${text.slice(0, 500)}`)
    process.exit(1)
  }

  const postJson = (await postRes.json()) as { jobId: string }
  const postMs = Date.now() - postStart
  log(`  ✓ POST accepted — jobId=${postJson.jobId}, accept-latency=${postMs}ms`)
  console.log()

  // ── Poll GET /api/video?jobId=... ─────────────────────────────────
  log('STEP 3 — Poll GET /api/video?jobId=... until done')
  let lastProgress = -1
  let lastStage = ''
  let done = false
  let finalJob: any = null
  const stages: { stage: string; t: number; pct: number }[] = []
  const jobStart = Date.now()

  while (!done) {
    await new Promise(r => setTimeout(r, 1500))
    const r = await fetch(`${API_BASE}/api/video?jobId=${postJson.jobId}`)
    if (!r.ok) {
      log(`  GET failed (HTTP ${r.status}) — retrying`)
      continue
    }
    const job = (await r.json()) as any
    finalJob = job

    if (job.progress !== lastProgress || job.stage !== lastStage) {
      lastProgress = job.progress
      lastStage = job.stage ?? ''
      const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1)
      log(`  [${elapsed}s] ${job.status}/${job.stage ?? '?'}: ${job.progress}% — ${job.currentLabel ?? ''}`)
      stages.push({ stage: job.stage ?? '?', t: Date.now() - jobStart, pct: job.progress })
    }

    if (job.status === 'done' || job.status === 'error') done = true
  }

  const totalMs = Date.now() - jobStart
  console.log()

  if (finalJob.status !== 'done') {
    console.error(`✗ Job FAILED — status=${finalJob.status}, error=${finalJob.error}`)
    process.exit(1)
  }

  // ── Final report ──────────────────────────────────────────────────
  console.log('═'.repeat(82))
  console.log(` FINAL RESULTS — ${PHASE.toUpperCase()}`)
  console.log('═'.repeat(82))
  log(`Status:        ${finalJob.status}`)
  log(`Total time:    ${(totalMs / 1000).toFixed(1)}s`)
  log(`Progress:      ${finalJob.progress}%`)
  log(`Video path:    ${finalJob.videoPath ?? '(not in response)'}`)
  log(`Video size:    ${finalJob.videoSizeBytes ?? '?'}B`)
  log(`Video dur:     ${finalJob.videoDuration ?? '?'}s`)
  console.log()

  // Stage transitions
  console.log('Stage timeline:')
  let prevT = 0
  for (const s of stages) {
    const dt = ((s.t - prevT) / 1000).toFixed(1)
    console.log(`  +${(s.t / 1000).toFixed(1).padStart(6)}s  (${dt.padStart(5)}s since last)  ${s.stage.padEnd(15)} @ ${s.pct}%`)
    prevT = s.t
  }
  console.log()
  console.log(`  → TOTAL: ${(totalMs / 1000).toFixed(1)}s`)
  console.log()

  // Write a machine-readable result file for cross-run comparison
  const resultFile = `/tmp/video-timing-${PHASE}.json`
  fs.writeFileSync(
    resultFile,
    JSON.stringify(
      {
        phase: PHASE,
        imageCount: IMAGE_COUNT,
        audioDuration: AUDIO_DURATION_S,
        jobId: postJson.jobId,
        totalMs,
        totalSeconds: totalMs / 1000,
        progress: finalJob.progress,
        videoPath: finalJob.videoPath ?? null,
        videoSizeBytes: finalJob.videoSizeBytes ?? null,
        videoDuration: finalJob.videoDuration ?? null,
        stages
      },
      null,
      2
    )
  )
  console.log(`Result written to: ${resultFile}`)
  console.log('═'.repeat(82))
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

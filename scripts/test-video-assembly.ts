/**
 * Standalone test for the video-assembly FFmpeg orchestrator.
 * Creates 4 synthetic test images (colored panels with index text) + a short
 * 18-second sine-wave audio, then runs runVideoAssembly and verifies output.
 *
 * Run: npx tsx scripts/test-video-assembly.ts
 */
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  createVideoJob,
  runVideoAssembly,
  getVideoJob
} from '../src/lib/video-assembly'

const execFileAsync = promisify(execFile)

const COLORS = [
  { name: 'red', rgb: '0x441111' },
  { name: 'green', rgb: '0x114411' },
  { name: 'teal', rgb: '0x113333' },
  { name: 'gold', rgb: '0x443311' }
]

async function makeTestImage(outPath: string, color: string, label: string): Promise<void> {
  // 1920x1080 solid color with a big white label in the center
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=1920x1080:d=0.04`,
    '-vf',
    `drawtext=text='${label}':fontcolor=white:fontsize=180:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-frames:v', '1',
    '-q:v', '3',
    outPath
  ]
  await execFileAsync('ffmpeg', args, { timeout: 30000 })
}

async function makeTestAudio(outPath: string, seconds: number): Promise<void> {
  // 18s 440Hz sine wave, 44.1kHz stereo, mp3
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${seconds}`,
    '-ac', '2',
    '-ar', '44100',
    '-b:a', '96k',
    outPath
  ]
  await execFileAsync('ffmpeg', args, { timeout: 30000 })
}

async function getDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { timeout: 15000 }
  )
  return parseFloat(stdout.trim())
}

async function main(): Promise<void> {
  console.log('=== Video Assembly Standalone Test ===\n')

  // 1. Create a fake image job dir with 4 test images
  const imageJobId = `test-${Date.now()}`
  const imageDir = path.join('/tmp/autotube-images', imageJobId)
  fs.mkdirSync(imageDir, { recursive: true })

  console.log(`[1/4] Generating 4 test images in ${imageDir}`)
  for (let i = 0; i < 4; i++) {
    const outPath = path.join(imageDir, `${i}.jpg`)
    await makeTestImage(outPath, COLORS[i].name, `IMG ${i + 1}`)
    const stat = fs.statSync(outPath)
    console.log(`   ✓ image ${i}: ${(stat.size / 1024).toFixed(0)}KB`)
  }

  // 2. Create a short test audio (18s — slightly more than 4 images * 4s = 16s, to test last-image-extend)
  const audioDir = path.join('/tmp', 'autotube-test-audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const audioPath = path.join(audioDir, `test-${Date.now()}.mp3`)
  const AUDIO_SECONDS = 18
  console.log(`[2/4] Generating ${AUDIO_SECONDS}s test audio → ${audioPath}`)
  await makeTestAudio(audioPath, AUDIO_SECONDS)
  const audioSize = fs.statSync(audioPath).size
  console.log(`   ✓ audio: ${(audioSize / 1024).toFixed(0)}KB`)

  // 3. Run the assembly
  console.log(`[3/4] Starting video assembly (4 images @ 4s, audio ${AUDIO_SECONDS}s)`)
  const job = createVideoJob({
    imageJobId,
    imageCount: 4,
    audioPath,
    audioDuration: AUDIO_SECONDS,
    audioMime: 'audio/mpeg'
  })

  // Poll progress while the job runs
  const start = Date.now()
  let lastPct = -1
  const pollInterval = setInterval(() => {
    const current = getVideoJob(job.id)
    if (current && current.progress !== lastPct) {
      lastPct = current.progress
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`   progress: ${current.progress}% (stage=${current.stage}, elapsed=${elapsed}s, eta=${current.etaSeconds ?? '-'}s)`)
    }
  }, 500)

  await runVideoAssembly(job, {
    imageJobId,
    imageCount: 4,
    audioPath,
    audioDuration: AUDIO_SECONDS,
    audioMime: 'audio/mpeg'
  })

  clearInterval(pollInterval)

  // 4. Verify output
  const finalJob = getVideoJob(job.id)
  console.log(`\n[4/4] Result:`)
  console.log(`   status      = ${finalJob?.status}`)
  console.log(`   stage       = ${finalJob?.stage}`)
  console.log(`   progress    = ${finalJob?.progress}%`)
  console.log(`   videoPath   = ${finalJob?.videoPath ?? '(none)'}`)
  console.log(`   fileSize    = ${finalJob?.fileSize ?? 0} bytes (${((finalJob?.fileSize ?? 0) / (1024 * 1024)).toFixed(2)}MB)`)
  console.log(`   videoDur    = ${finalJob?.videoDuration ?? 0}s`)
  console.log(`   error       = ${finalJob?.error ?? '(none)'}`)
  if (finalJob?.ffmpegTail) {
    console.log(`   ffmpeg tail:\n${finalJob.ffmpegTail.split('\n').slice(-5).map((l) => '     ' + l).join('\n')}`)
  }

  if (finalJob?.status === 'done' && finalJob.videoPath) {
    // Cross-check duration independently
    const actualDur = await getDuration(finalJob.videoPath)
    const pass = Math.abs(actualDur - AUDIO_SECONDS) < 1.5
    console.log(`\n   actual MP4 duration = ${actualDur.toFixed(2)}s (target ${AUDIO_SECONDS}s) → ${pass ? '✅ PASS' : '❌ FAIL'}`)

    // Verify H.264 codec + geometry
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate',
      '-of', 'default=noprint_wrappers=1',
      finalJob.videoPath
    ], { timeout: 15000 })
    console.log(`   stream info:\n${stdout.split('\n').map((l) => '     ' + l).join('\n')}`)

    console.log(`\n✅ Video assembly test COMPLETE. Output: ${finalJob.videoPath}`)
    console.log(`   Total elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } else {
    console.log(`\n❌ Video assembly test FAILED.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Test crashed:', err)
  process.exit(1)
})

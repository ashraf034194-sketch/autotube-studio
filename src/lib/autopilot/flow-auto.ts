// ── AutoTube Flow Bridge auto-dispatch engine ─────────────────────────────────
//
// The missing "autopilot" half of the Google Flow handoff. When a run pauses
// in 'awaiting_images' and the Flow Bridge (mini-services/flow-bridge) is
// reachable, this engine:
//
//   1. walks the pending image slots in order,
//   2. sends each prompt to the bridge, which drives the REAL Flow UI in the
//      logged-in Chromium (or, in clearly-labelled simulation mode, produces
//      placeholder frames),
//   3. pulls the generated image bytes back and saves them into the slot via
//      saveFlowImage (ffmpeg JPEG normalization, exactly like manual uploads),
//   4. mirrors progress onto the autopilot job (the pause UI fills up live),
//   5. when every slot is filled, calls POST /api/autopilot/flow-finish
//      internally so video assembly resumes WITHOUT any user click.
//
// Flow has no public API and the bridge consumes the user's OWN logged-in
// Flow account at natural speed — nothing is bypassed. If the bridge is
// offline or not logged in, the run simply stays in 'awaiting_images' and
// the manual handoff (copy prompts → generate in Flow → upload) still works.

import { getFlowImageJob, saveFlowImage } from '@/app/api/images/route'
import { POST as flowFinishPOST } from '@/app/api/autopilot/flow-finish/route'
import { mirrorToAutopilot } from '@/app/api/autopilot/flow-upload/route'
import {
  callRoute,
  getAutopilotJob,
  INTERNAL_BASE,
  jsonPOST,
  type AutopilotJobInternal
} from '@/lib/autopilot/store'
import {
  bridgeControl,
  bridgeEnqueue,
  bridgeImage,
  bridgeTask,
  getBridgeStatus
} from '@/lib/flow-bridge'

export interface FlowAutoLogEntry {
  t: number
  msg: string
}

export type FlowAutoStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'partial'
  | 'error'
  | 'stopped'

export interface FlowAutoRun {
  autopilotId: string
  imageJobId: string
  status: FlowAutoStatus
  mode: 'real' | 'simulation' | 'unknown'
  total: number
  doneCount: number
  failedCount: number
  currentSlot: number | null
  currentPrompt: string | null
  lastError: string | null
  logs: FlowAutoLogEntry[]
  startedAt: number
  doneAt: number | null
  stopRequested: boolean
  finishing: boolean
}

/** One auto-run per autopilot job (key = autopilotId). Cached on globalThis
 *  so HMR module re-evaluation cannot fork the state across routes. */
const gAuto = globalThis as unknown as { __flowAutoRuns?: Map<string, FlowAutoRun> }
export const flowAutoRuns: Map<string, FlowAutoRun> = (gAuto.__flowAutoRuns ??=
  new Map<string, FlowAutoRun>())

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Keep finished auto-runs around for 1 hour so the UI can show the outcome. */
const AUTO_RUN_TTL_MS = 60 * 60 * 1000
export function cleanupExpiredAutoRuns(): void {
  const now = Date.now()
  for (const [id, run] of flowAutoRuns) {
    if (run.status !== 'running' && run.status !== 'starting' && run.doneAt && now - run.doneAt > AUTO_RUN_TTL_MS) {
      flowAutoRuns.delete(id)
    }
  }
}

function log(run: FlowAutoRun, msg: string): void {
  run.logs.push({ t: Date.now(), msg })
  if (run.logs.length > 100) run.logs.shift()
  console.log(`[flow-auto ${run.autopilotId.slice(0, 8)}] ${msg}`)
}

export function getFlowAutoRun(autopilotId: string): FlowAutoRun | undefined {
  return flowAutoRuns.get(autopilotId)
}

/** Public shape for GET /api/flow-bridge/auto (no internal flags). */
export function serializeRun(run: FlowAutoRun): Record<string, unknown> {
  return {
    autopilotId: run.autopilotId,
    status: run.status,
    mode: run.mode,
    total: run.total,
    doneCount: run.doneCount,
    failedCount: run.failedCount,
    currentSlot: run.currentSlot,
    currentPrompt: run.currentPrompt,
    lastError: run.lastError,
    logs: run.logs.slice(-12),
    startedAt: run.startedAt,
    doneAt: run.doneAt,
    finishing: run.finishing
  }
}

/**
 * Start (or re-attach to) the auto-generation engine for an awaiting run.
 * Validates everything up-front so failures come back as actionable errors.
 */
export async function startFlowAuto(
  autopilotId: string
): Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }> {
  cleanupExpiredAutoRuns()

  const existing = flowAutoRuns.get(autopilotId)
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    return { ok: true, alreadyRunning: true }
  }

  const job = getAutopilotJob(autopilotId)
  if (!job) return { ok: false, error: 'Autopilot run not found (it may have expired).' }
  if (job.status !== 'awaiting_images') {
    return { ok: false, error: `This run is not waiting for images (status: ${job.status}).` }
  }
  if (!job.live.images.jobId) return { ok: false, error: 'This run has no image job.' }
  const imageJob = getFlowImageJob(job.live.images.jobId)
  if (!imageJob || !imageJob.prompts || imageJob.status !== 'awaiting') {
    return { ok: false, error: 'The image job is not ready for generation (prompts missing).' }
  }

  const status = await getBridgeStatus()
  if (!status.ok || status.offline) {
    return {
      ok: false,
      error:
        'Flow Bridge is offline — run `bun run dev` inside mini-services/flow-bridge (this machine), or use the manual handoff below.'
    }
  }

  const run: FlowAutoRun = {
    autopilotId,
    imageJobId: job.live.images.jobId,
    status: 'starting',
    mode: status.mode ?? 'unknown',
    total: imageJob.total,
    doneCount: 0,
    failedCount: 0,
    currentSlot: null,
    currentPrompt: null,
    lastError: null,
    logs: [],
    startedAt: Date.now(),
    doneAt: null,
    stopRequested: false,
    finishing: false
  }
  flowAutoRuns.set(autopilotId, run)
  log(run, `Engine started — ${run.total} slots, bridge mode "${run.mode}".`)
  void worker(run)
  return { ok: true }
}

export function stopFlowAuto(autopilotId: string): { ok: boolean; error?: string } {
  const run = flowAutoRuns.get(autopilotId)
  if (!run) return { ok: false, error: 'No auto-generation run for this job.' }
  if (run.status !== 'running' && run.status !== 'starting') {
    return { ok: false, error: `The auto-run already finished (${run.status}).` }
  }
  run.stopRequested = true
  log(run, 'Stop requested — halting after the current image.')
  return { ok: true }
}

// ── worker ───────────────────────────────────────────────────────────────────

async function worker(run: FlowAutoRun): Promise<void> {
  try {
    run.status = 'running'
    for (;;) {
      if (run.stopRequested) break

      // The autopilot job must still be paused and waiting.
      const job = getAutopilotJob(run.autopilotId) as AutopilotJobInternal | undefined
      if (!job || job.status !== 'awaiting_images') {
        log(run, 'The autopilot job left the awaiting state — engine halting.')
        run.status = 'stopped'
        break
      }

      const imageJob = getFlowImageJob(run.imageJobId)
      if (!imageJob) {
        run.status = 'error'
        run.lastError = 'The image job expired while auto-generating.'
        break
      }

      const next = imageJob.slots.find((s) => s.status === 'pending')
      if (!next) break // every slot filled — success path
      const prompt = imageJob.prompts[next.index]
      if (!prompt) {
        run.failedCount++
        log(run, `Slot ${next.index + 1} has no prompt — skipping.`)
        // Mark it failed so we don't loop forever on a broken slot.
        const slot = imageJob.slots[next.index]
        slot.status = 'error'
        slot.error = 'No prompt was written for this slot.'
        continue
      }

      run.currentSlot = next.index
      run.currentPrompt = prompt
      // NOTE: no colons in the task id — the bridge extracts ids from URL
      // paths, and ":" gets percent-encoded there (img-…:0 became img-…%3A0).
      const taskId = `${run.imageJobId}-${next.index}`

      const enq = await bridgeEnqueue(taskId, prompt)
      if (!enq.ok) {
        run.failedCount++
        run.lastError = enq.error || 'The bridge refused the task.'
        log(run, `Slot ${next.index + 1}: enqueue failed — ${run.lastError}`)
        const st = await getBridgeStatus()
        if (!st.ok || st.offline) {
          run.status = 'error'
          run.lastError = 'Flow Bridge went offline — remaining slots stay pending (manual upload still works).'
          break
        }
        continue
      }

      // Poll the bridge until this task resolves (per-task timeout).
      const perTaskTimeout = run.mode === 'simulation' ? 60_000 : 6 * 60_000
      const deadline = Date.now() + perTaskTimeout
      let taskDone = false
      let taskError: string | null = null
      for (;;) {
        if (run.stopRequested) break
        const t = await bridgeTask(taskId)
        if (!t.ok) {
          taskError = t.error || 'Lost track of the bridge task.'
          break
        }
        if (t.status === 'done') {
          taskDone = true
          break
        }
        if (t.status === 'error') {
          taskError = t.error || 'Generation failed in the bridge.'
          break
        }
        if (Date.now() > deadline) {
          taskError = 'Timed out waiting for the bridge task.'
          break
        }
        await sleep(1500)
      }

      if (taskDone) {
        const bytes = await bridgeImage(taskId)
        const jobNow = getAutopilotJob(run.autopilotId) as AutopilotJobInternal | undefined
        if (bytes && jobNow && jobNow.status === 'awaiting_images') {
          const save = await saveFlowImage(
            run.imageJobId,
            next.index,
            bytes,
            `flow-bridge-${next.index + 1}.png`
          )
          if (save.ok) {
            run.doneCount++
            mirrorToAutopilot(jobNow, 'bridge')
            log(run, `Slot ${next.index + 1}/${run.total} — image generated and saved.`)
          } else {
            run.failedCount++
            run.lastError = save.error || 'Saving the image failed.'
            log(run, `Slot ${next.index + 1}: save failed — ${run.lastError}`)
          }
        } else if (!bytes) {
          run.failedCount++
          run.lastError = 'Could not download the image bytes from the bridge.'
          log(run, `Slot ${next.index + 1}: ${run.lastError}`)
        }
      } else if (taskError) {
        run.failedCount++
        run.lastError = taskError
        log(run, `Slot ${next.index + 1}: ${taskError}`)
        const st = await getBridgeStatus()
        if (!st.ok || st.offline) {
          run.status = 'error'
          run.lastError = 'Flow Bridge went offline mid-run — remaining slots stay pending (manual upload still works).'
          break
        }
        // Login-required in real mode is fatal for the rest of the batch —
        // no point failing every remaining slot with the same error.
        if (run.mode === 'real' && /login required|login now/i.test(taskError)) {
          run.status = 'error'
          break
        }
      }

      run.currentSlot = null
      run.currentPrompt = null
    }

    // ── finalization ────────────────────────────────────────────────────────
    if (run.status === 'running') {
      const imageJob = getFlowImageJob(run.imageJobId)
      const job = getAutopilotJob(run.autopilotId) as AutopilotJobInternal | undefined
      const completed = imageJob?.completed ?? 0
      const total = imageJob?.total ?? run.total

      if (imageJob && job && job.status === 'awaiting_images' && completed >= total && total > 0) {
        // FULL AUTOPILOT: every slot filled → resume video assembly now.
        run.finishing = true
        mirrorToAutopilot(job, 'bridge')
        log(run, `All ${completed} images generated — resuming video assembly automatically.`)
        const fin = await callRoute(
          flowFinishPOST,
          jsonPOST(`${INTERNAL_BASE}/api/autopilot/flow-finish`, { autopilotId: run.autopilotId })
        )
        if (fin.ok) {
          run.status = 'completed'
          log(run, 'Video assembly resumed — the run is back to "running".')
        } else {
          run.status = 'error'
          run.lastError = String(fin.json.error ?? 'flow-finish failed.')
          log(run, `Auto-finish failed — ${run.lastError}`)
        }
        run.finishing = false
      } else if (run.stopRequested) {
        run.status = 'stopped'
        log(run, `Stopped — ${completed}/${total} images were generated. Press "Assemble video" or restart auto-generation.`)
      } else if (completed > 0) {
        run.status = 'partial'
        log(run, `${completed}/${total} images — press "Assemble video" to continue with these, or restart auto-generation for the rest.`)
      } else {
        run.status = 'error'
        if (!run.lastError) run.lastError = 'No images were generated.'
      }
    }
  } catch (err) {
    run.status = 'error'
    run.lastError = err instanceof Error ? err.message : String(err)
    log(run, `Engine crashed — ${run.lastError}`)
  } finally {
    if (run.status === 'starting') run.status = 'stopped'
    run.currentSlot = null
    run.currentPrompt = null
    run.doneAt = Date.now()
    // The next stage (video assembly) needs the RAM that the bridge's Chromium
    // holds — close the background browser now. The persistent profile keeps
    // the Google login, and it relaunches on demand (login / open-app / the
    // next generate task), so this is invisible to the user.
    void bridgeControl('close-browser').catch(() => {})
  }
}

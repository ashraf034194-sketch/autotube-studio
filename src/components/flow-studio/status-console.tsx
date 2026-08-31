'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Status Console — the generation state machine panel
//
// Renders the 9-state workflow as a timeline with the CURRENT live status,
// plus the contextual action buttons for the Google Flow hand-off:
//
//   REQUIRES_USER_ACTION → [Copy & open Google Flow] [I pasted it & started]
//   GENERATING           → [✓ result appeared] [✗ failed] [⚠ platform limit]
//   COMPLETED/FAILED/    → terminal summary (+ retry / new request)
//   LIMIT_REACHED
//
// COMPLETED can ONLY be reached through the attestation checkbox below —
// the tool never claims success without the user confirming a real result
// exists in their Flow project (spec: "Never display COMPLETED unless a
// valid generation result actually exists").
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import {
  Check,
  X,
  AlertTriangle,
  Clock,
  Loader2,
  ArrowRight,
  ExternalLink,
  ClipboardCopy,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Circle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { FlowState, STATE_MESSAGES } from '@/lib/flow-studio/types'

interface TimelineStep {
  state: FlowState
  label: string
  /** Whether this step is active/done/pending/skipped on the timeline. */
  status: 'done' | 'active' | 'pending' | 'error'
}

/** The canonical 6-step workflow shown as a timeline. */
function buildTimeline(current: FlowState): TimelineStep[] {
  const order: FlowState[] = [
    'VALIDATING',
    'ANALYZING_PROMPT',
    'PREPARING_GENERATION',
    'REQUIRES_USER_ACTION',
    'GENERATING',
    'COMPLETED'
  ]
  const labels: Record<string, string> = {
    VALIDATING: 'Validate input',
    ANALYZING_PROMPT: 'Analyze & structure prompt',
    PREPARING_GENERATION: 'Prepare Flow instructions',
    REQUIRES_USER_ACTION: 'Hand off to Google Flow',
    GENERATING: 'Generate in Google Flow',
    COMPLETED: 'Validate result'
  }

  let reachedIndex = order.indexOf(current)
  if (current === 'FAILED' || current === 'LIMIT_REACHED') {
    // Terminal failure states: mark GENERATING as reached (that's where the
    // failure was observed) and the final step as error.
    reachedIndex = order.indexOf('GENERATING')
  }
  if (current === 'IDLE') reachedIndex = -1

  return order.map((state, i) => {
    let status: TimelineStep['status'] = 'pending'
    if (current === 'FAILED' || current === 'LIMIT_REACHED') {
      if (i < reachedIndex) status = 'done'
      else if (i === reachedIndex) status = 'done'
      else if (i === order.length - 1) status = 'error'
    } else if (i < reachedIndex) status = 'done'
    else if (i === reachedIndex) status = 'active'
    return { state, label: labels[state] ?? state, status }
  })
}

const STATE_BADGE_VARIANT: Record<FlowState, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  IDLE: 'outline',
  VALIDATING: 'secondary',
  ANALYZING_PROMPT: 'secondary',
  PREPARING_GENERATION: 'secondary',
  REQUIRES_USER_ACTION: 'default',
  GENERATING: 'secondary',
  COMPLETED: 'default',
  FAILED: 'destructive',
  LIMIT_REACHED: 'destructive'
}

export interface StatusConsoleProps {
  state: FlowState
  /** Extra line under the state message (e.g. validation issues, error JSON). */
  detail?: string
  onCopyAndOpen: () => void
  onStartedInFlow: () => void
  onConfirmResult: () => void
  onReportFailure: () => void
  onReportLimit: () => void
  onReset: () => void
  hasResult: boolean
}

export function StatusConsole({
  state,
  detail,
  onCopyAndOpen,
  onStartedInFlow,
  onConfirmResult,
  onReportFailure,
  onReportLimit,
  onReset,
  hasResult
}: StatusConsoleProps) {
  const [attested, setAttested] = useState(false)
  const timeline = buildTimeline(state)
  const busy = state === 'VALIDATING' || state === 'ANALYZING_PROMPT' || state === 'PREPARING_GENERATION'

  // Reset the attestation checkbox whenever a new request cycle begins.
  // (state returns to IDLE in between requests)
  const [lastState, setLastState] = useState<FlowState>(state)
  if (state !== lastState) {
    setLastState(state)
    if (state === 'IDLE' && attested) setAttested(false)
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-amber-400" />
            Generation Status
          </CardTitle>
          <Badge variant={STATE_BADGE_VARIANT[state]} className="font-mono text-[11px]">
            {state}
          </Badge>
        </div>
        <CardDescription className="sr-only">Live state of the current generation request</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Live status message ── */}
        <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
          {busy ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-400" />
          ) : state === 'COMPLETED' ? (
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          ) : state === 'FAILED' || state === 'LIMIT_REACHED' ? (
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          ) : state === 'GENERATING' ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-400" />
          ) : (
            <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-relaxed text-zinc-200">{STATE_MESSAGES[state]}</p>
            {detail && <p className="mt-1 text-xs leading-relaxed text-zinc-400">{detail}</p>}
          </div>
        </div>

        {/* ── Workflow timeline ── */}
        <ScrollArea className="pr-2">
          <ol className="space-y-0">
            {timeline.map((step, i) => (
              <li key={step.state} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                      step.status === 'done'
                        ? 'border-emerald-600 bg-emerald-950 text-emerald-400'
                        : step.status === 'active'
                          ? 'border-amber-500 bg-amber-950 text-amber-300'
                          : step.status === 'error'
                            ? 'border-red-600 bg-red-950 text-red-400'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                    }`}
                  >
                    {step.status === 'done' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : step.status === 'error' ? (
                      <X className="h-3.5 w-3.5" />
                    ) : step.status === 'active' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </div>
                  {i < timeline.length - 1 && (
                    <div
                      className={`w-px flex-1 ${i < timeline.findIndex((s) => s.status === 'active' || s.status === 'error') ? 'bg-emerald-800' : 'bg-zinc-800'}`}
                      style={{ minHeight: '12px' }}
                    />
                  )}
                </div>
                <div className={`pb-3 pl-1 text-sm ${step.status === 'pending' ? 'text-zinc-500' : 'text-zinc-300'}`}>
                  {step.label}
                </div>
              </li>
            ))}
          </ol>
        </ScrollArea>

        {/* ── Contextual action buttons ── */}
        <Separator className="bg-zinc-800" />

        {state === 'REQUIRES_USER_ACTION' && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">
              Your Flow-ready prompt is ready in the output panel. Copy it, paste it into Google Flow&apos;s prompt
              box and start the generation there.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={onCopyAndOpen} className="h-11 flex-1 bg-amber-500 text-zinc-950 hover:bg-amber-400">
                <ClipboardCopy className="mr-2 h-4 w-4" />
                Copy prompt &amp; open Google Flow
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </Button>
            </div>
            <Button
              onClick={onStartedInFlow}
              variant="outline"
              className="h-11 w-full border-zinc-700 bg-zinc-900 hover:border-amber-500 hover:text-amber-300"
            >
              <UserCheck className="mr-2 h-4 w-4" />
              I&apos;ve pasted it &amp; started the generation
            </Button>
          </div>
        )}

        {state === 'GENERATING' && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              The generation is now running in your Google Flow session. When Flow finishes, report the real outcome
              below — the tool never guesses.
            </p>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <label className="flex items-start gap-2 text-xs text-zinc-300">
                <Checkbox
                  checked={attested}
                  onCheckedChange={(v) => setAttested(v === true)}
                  className="mt-0.5"
                  aria-label="Confirm the generated image is visible in your Google Flow project"
                />
                <span>
                  I confirm the <strong>generated image is now visible</strong> in my Google Flow project (not a
                  placeholder or loading preview).
                </span>
              </label>
              <Button
                onClick={onConfirmResult}
                disabled={!attested}
                className="mt-2 h-10 w-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <Check className="mr-2 h-4 w-4" />
                Result received — mark completed
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                onClick={onReportFailure}
                variant="outline"
                className="h-10 flex-1 border-zinc-700 bg-zinc-900 text-red-300 hover:border-red-600"
              >
                <X className="mr-2 h-4 w-4" />
                Generation failed
              </Button>
              <Button
                onClick={onReportLimit}
                variant="outline"
                className="h-10 flex-1 border-zinc-700 bg-zinc-900 text-amber-300 hover:border-amber-600"
              >
                <AlertTriangle className="mr-2 h-4 w-4" />
                Flow blocked it (quota/limit)
              </Button>
            </div>
          </div>
        )}

        {(state === 'COMPLETED' || state === 'FAILED' || state === 'LIMIT_REACHED') && (
          <div className="space-y-2">
            {state === 'COMPLETED' && (
              <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/40 p-3 text-xs leading-relaxed text-emerald-200">
                The image is saved to your Google Flow project. Continue the creative workflow there — edit it, extend
                it into a video, or come back and generate more assets.
              </div>
            )}
            {state === 'FAILED' && (
              <div className="rounded-lg border border-red-800/60 bg-red-950/40 p-3 font-mono text-[11px] leading-relaxed text-red-200">
                {`{ "success": false, "status": "FAILED", "message": "The generation did not complete successfully.", "reason": "No valid output was returned.", "retry_possible": true }`}
              </div>
            )}
            {state === 'LIMIT_REACHED' && (
              <div className="rounded-lg border border-amber-800/60 bg-amber-950/40 p-3 text-xs leading-relaxed text-amber-200">
                Google Flow is currently unable to start/complete this generation because of the account&apos;s
                generation access, credits or quota. This is a platform limitation — your prompt is fine. Options:
                wait for the quota window to reset, check your Flow plan, or try a different generation mode.
              </div>
            )}
            <Button
              onClick={onReset}
              variant="outline"
              className="h-10 w-full border-zinc-700 bg-zinc-900 hover:border-amber-500 hover:text-amber-300"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              New request
            </Button>
          </div>
        )}

        {state === 'IDLE' && (
          <p className="flex items-center gap-2 text-xs text-zinc-500">
            <ArrowRight className="h-3.5 w-3.5" />
            Describe your image in the composer and press <strong>Generate</strong>.
          </p>
        )}

        {/* Result-association reminder on terminal states */}
        {hasResult && (state === 'COMPLETED' || state === 'FAILED' || state === 'LIMIT_REACHED') && (
          <p className="text-[11px] text-zinc-500">
            This entry has been recorded in the session history with its request ID.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

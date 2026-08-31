'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Flow Prompt Studio — main page
//
// A prompt-engineering + generation-orchestration console for Google Flow
// (labs.google/fx/tools/flow) image generation.
//
// WORKFLOW (the full spec pipeline):
//   USER INPUT → VALIDATION → PROMPT ANALYSIS (LLM) → PROMPT STRUCTURING →
//   PARAMETER VALIDATION → GOOGLE FLOW HAND-OFF (copy + paste, user's own
//   authenticated session) → GENERATION MONITORING (user-reported) →
//   RESULT VALIDATION (attested) → COMPLETED
//
// GENERATION happens inside the user's Google Flow account — this tool adds
// NO API key requirement, NO separate credit system, and NO browser/session
// automation. Duplicate submissions are blocked while a request is in flight.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  WandSparkles,
  Sparkles,
  Loader2,
  AlertCircle,
  ExternalLink,
  Layers,
  Camera,
  Sun,
  Gauge,
  Crop,
  Info,
  Ban,
  KeyRound,
  Coins,
  ShieldCheck,
  PlayCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { StatusConsole } from '@/components/flow-studio/status-console'
import { OutputPanel } from '@/components/flow-studio/output-panel'
import { HistoryLog } from '@/components/flow-studio/history-log'
import {
  ASPECT_RATIOS,
  BUSY_STATES,
  COMPOSITION_OPTIONS,
  GenerationRequest,
  HistoryEntry,
  HISTORY_MAX_ENTRIES,
  HISTORY_STORAGE_KEY,
  LIGHTING_OPTIONS,
  QUALITY_OPTIONS,
  STARTABLE_STATES,
  STYLE_OPTIONS,
  ValidationIssue,
  FlowPromptData,
  FlowState
} from '@/lib/flow-studio/types'
import { validateGenerationRequest } from '@/lib/flow-studio/validation'

const FLOW_URL = 'https://labs.google/fx/tools/flow'

const DEFAULT_REQUEST: GenerationRequest = {
  prompt: '',
  styleId: 'none',
  customStyle: '',
  aspectRatio: '16:9',
  compositionId: 'none',
  customComposition: '',
  lightingIds: [],
  qualityIds: []
}

export default function Home() {
  const { toast } = useToast()

  // ─── Form state ───
  const [request, setRequest] = useState<GenerationRequest>(DEFAULT_REQUEST)

  // ─── Generation state machine ───
  const [flowState, setFlowState] = useState<FlowState>('IDLE')
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [result, setResult] = useState<FlowPromptData | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined)

  // ─── Duplicate-submission protection (ref = synchronous guard) ───
  const inFlightRef = useRef(false)

  // ─── History (localStorage-persisted session log) ───
  const [history, setHistory] = useState<HistoryEntry[]>([])
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, HISTORY_MAX_ENTRIES))
      }
    } catch {
      // Corrupt storage — start fresh.
    }
  }, [])
  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, HISTORY_MAX_ENTRIES)
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Storage full/unavailable — in-memory log still works.
      }
      return next
    })
  }, [])
  const clearHistory = useCallback(() => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_STORAGE_KEY)
    } catch {
      // ignore
    }
  }, [])

  // ─── Derived ───
  const busy = BUSY_STATES.includes(flowState)
  const generateDisabled = busy || inFlightRef.current
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  // ─── Form setters ───
  const setPrompt = (prompt: string) => setRequest((r) => ({ ...r, prompt }))
  const setStyle = (styleId: string) => setRequest((r) => ({ ...r, styleId }))
  const setCustomStyle = (customStyle: string) => setRequest((r) => ({ ...r, customStyle }))
  const setAspect = (aspectRatio: string) => setRequest((r) => ({ ...r, aspectRatio }))
  const setComposition = (compositionId: string) => setRequest((r) => ({ ...r, compositionId }))
  const setCustomComposition = (customComposition: string) =>
    setRequest((r) => ({ ...r, customComposition }))
  const toggleLighting = (id: string) =>
    setRequest((r) => ({
      ...r,
      lightingIds: r.lightingIds.includes(id)
        ? r.lightingIds.filter((x) => x !== id)
        : [...r.lightingIds, id]
    }))
  const toggleQuality = (id: string) =>
    setRequest((r) => ({
      ...r,
      qualityIds: r.qualityIds.includes(id)
        ? r.qualityIds.filter((x) => x !== id)
        : [...r.qualityIds, id]
    }))

  // ─── Helpers ───
  const currentStyleLabel = (): string => {
    if (request.styleId === 'custom') return request.customStyle.trim() || 'Custom style'
    return STYLE_OPTIONS.find((s) => s.id === request.styleId)?.label ?? 'No preference'
  }

  const recordTerminal = useCallback(
    (state: FlowState) => {
      if (!result) return
      pushHistory({
        requestId: result.requestId,
        createdAt: Date.now(),
        promptExcerpt: request.prompt.trim().slice(0, 90) || '(no prompt)',
        styleLabel: currentStyleLabel(),
        aspectRatio: request.aspectRatio,
        finalState: state,
        resolvedAt: Date.now()
      })
    },
    [result, request.prompt, request.aspectRatio, request.styleId, request.customStyle, pushHistory]
  )

  // ─── MAIN ACTION: Generate (starts the pipeline) ───
  const handleGenerate = async () => {
    // DUPLICATE PROTECTION: state guard + synchronous ref guard.
    if (!STARTABLE_STATES.includes(flowState) || inFlightRef.current) {
      toast({
        title: 'A request is already in progress',
        description: 'Only one active generation request is allowed. Finish or reset the current one first.',
        variant: 'destructive'
      })
      return
    }
    inFlightRef.current = true

    try {
      // ── Stage 1: VALIDATING (client-side; server re-validates) ──
      setFlowState('VALIDATING')
      setIssues([])
      setErrorDetail(undefined)
      await new Promise((r) => setTimeout(r, 150)) // let the UI paint the state

      const validation = validateGenerationRequest(request)
      setIssues(validation.issues)

      if (!validation.ok) {
        // Hard validation failure → NO API call, NO generation attempt.
        const first = validation.issues.find((i) => i.severity === 'error')
        setFlowState('IDLE')
        toast({
          title: 'Validation failed',
          description: first?.message ?? 'Please check your input.',
          variant: 'destructive'
        })
        return
      }

      // ── Stage 2+3: ANALYZING_PROMPT → server Prompt Analyzer/Structurer ──
      setFlowState('ANALYZING_PROMPT')
      let response: Response
      try {
        response = await fetch('/api/flow-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        })
      } catch {
        setFlowState('IDLE')
        toast({
          title: 'Network error',
          description: 'Could not reach the analysis service. Check your connection and try again.',
          variant: 'destructive'
        })
        return
      }

      // ── Stage 4: PREPARING_GENERATION (parse + validate the response) ──
      setFlowState('PREPARING_GENERATION')
      let body: { success: boolean; data?: FlowPromptData; error?: string; issues?: ValidationIssue[] }
      try {
        body = await response.json()
      } catch {
        setFlowState('IDLE')
        toast({
          title: 'Analysis failed',
          description: 'The analysis service returned an unreadable response.',
          variant: 'destructive'
        })
        return
      }

      if (!response.ok || !body.success || !body.data) {
        // Tool-side failure (analysis) — NOT a generation failure; return to
        // IDLE with a clear message (spec: don't blame the prompt for tool errors).
        if (Array.isArray(body.issues)) setIssues(body.issues)
        setFlowState('IDLE')
        toast({
          title: 'Prompt analysis failed',
          description: body.error ?? 'The analysis service could not process this request.',
          variant: 'destructive'
        })
        return
      }

      // Result validated → hand-off point.
      setResult(body.data)
      setFlowState('REQUIRES_USER_ACTION')
      toast({
        title: 'Prompt ready for Google Flow',
        description: 'Copy it from the output panel and paste it into Google Flow to start the generation.'
      })
    } finally {
      inFlightRef.current = false
    }
  }

  // ─── Hand-off actions ───
  const handleCopyAndOpen = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.flowPrompt)
    } catch {
      // Fallback copy
      const el = document.createElement('textarea')
      el.value = result.flowPrompt
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    window.open(FLOW_URL, '_blank', 'noopener,noreferrer')
    toast({
      title: 'Prompt copied — Google Flow opening',
      description: 'Paste the prompt into Flow’s prompt box and start the generation.'
    })
  }

  const handleStartedInFlow = () => {
    setFlowState('GENERATING')
  }

  const handleConfirmResult = () => {
    // Result attested by the user — only NOW may we display COMPLETED.
    setFlowState('COMPLETED')
    recordTerminal('COMPLETED')
    toast({ title: 'Image generated successfully', description: 'Saved to your Google Flow project.' })
  }

  const handleReportFailure = () => {
    setFlowState('FAILED')
    setErrorDetail('Reason: no valid output was returned by Google Flow.')
    recordTerminal('FAILED')
  }

  const handleReportLimit = () => {
    setFlowState('LIMIT_REACHED')
    setErrorDetail(
      'The limitation comes from Google Flow (account access, credits or quota) — not from your prompt.'
    )
    recordTerminal('LIMIT_REACHED')
  }

  const handleReset = () => {
    setFlowState('IDLE')
    setResult(null)
    setIssues([])
    setErrorDetail(undefined)
  }

  const clearIssuesOnEdit = () => {
    if (errors.length > 0 || warnings.length > 0) setIssues([])
  }

  // ─── UI ───
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
        {/* ── Header ── */}
        <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 ring-1 ring-amber-500/40">
                <WandSparkles className="h-5 w-5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold leading-tight">Flow Prompt Studio</h1>
                <p className="truncate text-xs text-zinc-400">
                  Native-pipeline prompt console for Google Flow image generation
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="outline" className="hidden gap-1.5 border-amber-700/60 bg-amber-950/50 text-amber-300 sm:flex">
                <Sparkles className="h-3 w-3" />
                No API key required
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 border-zinc-700 bg-zinc-900 text-xs hover:border-amber-500 hover:text-amber-300"
                onClick={() => window.open(FLOW_URL, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Google Flow
              </Button>
            </div>
          </div>
        </header>

        {/* ── Main ── */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {/* Compliance summary strip */}
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <KeyRound className="h-5 w-5 shrink-0 text-amber-400" />
              <p className="text-xs leading-relaxed text-zinc-300">
                <span className="font-medium text-zinc-100">Zero API keys.</span> Tool logic runs on bundled AI —
                generation runs in your Flow account.
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <Coins className="h-5 w-5 shrink-0 text-amber-400" />
              <p className="text-xs leading-relaxed text-zinc-300">
                <span className="font-medium text-zinc-100">No separate credits.</span> Generation usage is governed
                by your Google Flow account&apos;s own quotas.
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <ShieldCheck className="h-5 w-5 shrink-0 text-amber-400" />
              <p className="text-xs leading-relaxed text-zinc-300">
                <span className="font-medium text-zinc-100">Compliant by design.</span> No credential storage, no
                quota circumvention, no browser automation.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* ── Left: Composer ── */}
            <section className="space-y-6 lg:col-span-7" aria-label="Prompt composer">
              <Card className="border-zinc-800 bg-zinc-900/60">
                <CardHeader className="pb-4">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles className="h-4 w-4 text-amber-400" />
                    Describe your image
                  </CardTitle>
                  <CardDescription>
                    The analyzer preserves your intent — it organizes, never invents. Detailed prompts pass through
                    nearly untouched.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Main prompt */}
                  <div className="space-y-2">
                    <Label htmlFor="main-prompt" className="text-sm font-medium">
                      Main prompt
                    </Label>
                    <Textarea
                      id="main-prompt"
                      value={request.prompt}
                      onChange={(e) => {
                        setPrompt(e.target.value)
                        clearIssuesOnEdit()
                      }}
                      placeholder="A cinematic luxury perfume bottle on black marble with dramatic studio lighting."
                      className="min-h-[120px] resize-y border-zinc-700 bg-zinc-950/70 text-sm placeholder:text-zinc-600 focus-visible:ring-amber-500/60"
                      aria-describedby="main-prompt-hint"
                      disabled={busy}
                    />
                    <p id="main-prompt-hint" className="text-[11px] text-zinc-500">
                      {request.prompt.trim().length.toLocaleString()} / 4,000 characters
                    </p>
                  </div>

                  {/* Style + Aspect row */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="flex items-center gap-1.5 text-sm font-medium">
                        <Layers className="h-3.5 w-3.5 text-zinc-500" />
                        Image style
                      </Label>
                      <Select
                        value={request.styleId}
                        onValueChange={setStyle}
                        disabled={busy}
                      >
                        <SelectTrigger className="h-11 border-zinc-700 bg-zinc-950/70">
                          <SelectValue placeholder="Choose a style" />
                        </SelectTrigger>
                        <SelectContent className="border-zinc-700 bg-zinc-900">
                          {STYLE_OPTIONS.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {request.styleId === 'custom' && (
                        <Input
                          value={request.customStyle}
                          onChange={(e) => setCustomStyle(e.target.value)}
                          placeholder='e.g. "retro 90s film grain, VHS warmth"'
                          className="h-11 border-zinc-700 bg-zinc-950/70 text-sm"
                          disabled={busy}
                          aria-label="Custom style description"
                        />
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label className="flex items-center gap-1.5 text-sm font-medium">
                        <Crop className="h-3.5 w-3.5 text-zinc-500" />
                        Aspect ratio
                      </Label>
                      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Aspect ratio">
                        {ASPECT_RATIOS.map((a) => (
                          <Tooltip key={a.id}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                role="radio"
                                aria-checked={request.aspectRatio === a.id}
                                aria-label={`${a.label} aspect ratio`}
                                disabled={!a.supported || busy}
                                onClick={() => setAspect(a.id)}
                                className={`h-11 min-w-[64px] rounded-lg border px-3 text-sm font-medium transition-colors ${
                                  request.aspectRatio === a.id
                                    ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                                    : a.supported
                                      ? 'border-zinc-700 bg-zinc-950/70 text-zinc-300 hover:border-zinc-500'
                                      : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600'
                                }`}
                              >
                                {a.label}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[220px] border-zinc-700 bg-zinc-900 text-xs">
                              {a.note}
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Composition */}
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-sm font-medium">
                      <Camera className="h-3.5 w-3.5 text-zinc-500" />
                      Composition <span className="text-xs font-normal text-zinc-500">(optional)</span>
                    </Label>
                    <Select
                      value={request.compositionId}
                      onValueChange={setComposition}
                      disabled={busy}
                    >
                      <SelectTrigger className="h-11 border-zinc-700 bg-zinc-950/70">
                        <SelectValue placeholder="No preference" />
                      </SelectTrigger>
                      <SelectContent className="border-zinc-700 bg-zinc-900">
                        {COMPOSITION_OPTIONS.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {request.compositionId === 'custom' && (
                      <Input
                        value={request.customComposition}
                        onChange={(e) => setCustomComposition(e.target.value)}
                        placeholder='e.g. "over-the-shoulder shot, subject on the left"'
                        className="h-11 border-zinc-700 bg-zinc-950/70 text-sm"
                        disabled={busy}
                        aria-label="Custom composition description"
                      />
                    )}
                  </div>

                  {/* Lighting */}
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-sm font-medium">
                      <Sun className="h-3.5 w-3.5 text-zinc-500" />
                      Lighting <span className="text-xs font-normal text-zinc-500">(optional, multi-select)</span>
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      {LIGHTING_OPTIONS.map((l) => {
                        const active = request.lightingIds.includes(l.id)
                        return (
                          <button
                            key={l.id}
                            type="button"
                            aria-pressed={active}
                            aria-label={`${l.label} lighting`}
                            disabled={busy}
                            onClick={() => toggleLighting(l.id)}
                            className={`h-10 rounded-full border px-3.5 text-xs font-medium transition-colors ${
                              active
                                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                                : 'border-zinc-700 bg-zinc-950/70 text-zinc-400 hover:border-zinc-500'
                            }`}
                          >
                            {l.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Quality */}
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-sm font-medium">
                      <Gauge className="h-3.5 w-3.5 text-zinc-500" />
                      Quality descriptors{' '}
                      <span className="text-xs font-normal text-zinc-500">(optional — prompt language only)</span>
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      {QUALITY_OPTIONS.map((q) => {
                        const active = request.qualityIds.includes(q.id)
                        return (
                          <button
                            key={q.id}
                            type="button"
                            aria-pressed={active}
                            aria-label={`${q.label} quality`}
                            disabled={busy}
                            onClick={() => toggleQuality(q.id)}
                            className={`h-10 rounded-full border px-3.5 text-xs font-medium transition-colors ${
                              active
                                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                                : 'border-zinc-700 bg-zinc-950/70 text-zinc-400 hover:border-zinc-500'
                            }`}
                          >
                            {q.label}
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[11px] text-zinc-500">
                      Google Flow has no numeric resolution control — these are applied as prompt language, exactly
                      as Flow supports.
                    </p>
                  </div>

                  {/* Validation issues */}
                  {errors.length > 0 && (
                    <Alert variant="destructive" className="border-red-800/60 bg-red-950/40">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>Input needs attention</AlertTitle>
                      <AlertDescription>
                        <ul className="list-inside list-disc space-y-1">
                          {errors.map((e, i) => (
                            <li key={i}>{e.message}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}
                  {warnings.length > 0 && errors.length === 0 && (
                    <Alert className="border-amber-800/60 bg-amber-950/30 text-amber-200">
                      <AlertTriangleMini />
                      <AlertTitle>Noted — you can continue</AlertTitle>
                      <AlertDescription>
                        <ul className="list-inside list-disc space-y-1">
                          {warnings.map((w, i) => (
                            <li key={i}>{w.message}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}

                  <Separator className="bg-zinc-800" />

                  {/* Generate */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <Button
                      onClick={handleGenerate}
                      disabled={generateDisabled}
                      className="h-12 flex-1 bg-amber-500 text-base font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
                      size="lg"
                    >
                      {busy ? (
                        <>
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                          {flowState === 'VALIDATING'
                            ? 'Validating…'
                            : flowState === 'ANALYZING_PROMPT'
                              ? 'Analyzing your prompt…'
                              : 'Preparing…'}
                        </>
                      ) : (
                        <>
                          <WandSparkles className="mr-2 h-5 w-5" />
                          Generate
                        </>
                      )}
                    </Button>
                    <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 sm:max-w-[200px]">
                      <Info className="h-3.5 w-3.5 shrink-0" />
                      Duplicate clicks are blocked while a request is in flight.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* How the Flow hand-off works */}
              <Card className="border-zinc-800 bg-zinc-900/40">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <PlayCircle className="h-4 w-4 text-amber-400" />
                    How the Google Flow hand-off works
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="grid gap-2 text-xs leading-relaxed text-zinc-300 sm:grid-cols-2">
                    <li className="flex gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-300">1</span>
                      Write your prompt here — the analyzer structures it with strict fidelity (no invented details).
                    </li>
                    <li className="flex gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-300">2</span>
                      Press Generate → validation → analysis → your Flow-ready prompt appears.
                    </li>
                    <li className="flex gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-300">3</span>
                      Copy &amp; open Google Flow — paste into the prompt box and start the generation in your own
                      authenticated session.
                    </li>
                    <li className="flex gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-300">4</span>
                      Report the real outcome (received / failed / platform-limited) — the status reflects only what
                      actually happened.
                    </li>
                  </ol>
                  <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                    Google Flow has no official public API or extension system — this guided hand-off (copy →
                    paste → generate in your own Flow session) is the fully compliant native workflow. The tool never
                    stores your Google credentials and never touches your Flow credits.
                  </p>
                </CardContent>
              </Card>
            </section>

            {/* ── Right: Status console + output ── */}
            <section className="space-y-6 lg:col-span-5" aria-label="Generation status and output">
              <StatusConsole
                state={flowState}
                detail={errorDetail}
                onCopyAndOpen={handleCopyAndOpen}
                onStartedInFlow={handleStartedInFlow}
                onConfirmResult={handleConfirmResult}
                onReportFailure={handleReportFailure}
                onReportLimit={handleReportLimit}
                onReset={handleReset}
                hasResult={!!result}
              />
              <OutputPanel data={result} />
            </section>
          </div>

          {/* ── History ── */}
          <motion.section
            className="mt-6"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            aria-label="Session history"
          >
            <HistoryLog entries={history} onClear={clearHistory} />
          </motion.section>
        </main>

        {/* ── Footer (sticky) ── */}
        <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950/90">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-4 text-[11px] leading-relaxed text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="flex items-center gap-1.5">
              <Ban className="h-3.5 w-3.5 shrink-0 text-amber-500/70" />
              Generation access, credits, quotas and rate limits are governed by your Google Flow account and its
              subscription — this tool adds no separate credit system and never bypasses platform limits.
            </p>
            <p className="shrink-0 text-zinc-600">Flow Prompt Studio · tool logic only, no credential storage</p>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  )
}

/** Small inline triangle icon (keeps imports tidy for the warning alert). */
function AlertTriangleMini() {
  return <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
}

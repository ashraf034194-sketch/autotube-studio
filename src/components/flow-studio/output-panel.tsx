'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Output Panel — the Result Controller's display surface
//
// Three tabs:
//   1. Flow-ready prompt — the paste-ready text (copy button).
//   2. Structured JSON   — the internal 11-field structure (transparent).
//   3. Fidelity report   — what the analyzer did / did NOT change, conflicts,
//                          warnings (trust: the user can audit every word).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { Copy, Check, FileJson, ScrollText, ShieldCheck, AlertTriangle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  FlowPromptData,
  PromptFidelity,
  STRUCTURE_FIELDS,
  STRUCTURE_LABELS
} from '@/lib/flow-studio/types'

const FIDELITY_BADGE: Record<PromptFidelity, { label: string; className: string }> = {
  preserved: { label: 'Intent preserved', className: 'border-emerald-700 bg-emerald-950 text-emerald-300' },
  structured: { label: 'Structured', className: 'border-amber-700 bg-amber-950 text-amber-300' },
  enhanced: { label: 'Structured + generic framing', className: 'border-amber-700 bg-amber-950 text-amber-300' }
}

export interface OutputPanelProps {
  data: FlowPromptData | null
}

export function OutputPanel({ data }: OutputPanelProps) {
  const [copied, setCopied] = useState(false)

  const copyPrompt = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.flowPrompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can fail in insecure contexts — textarea fallback.
      const el = document.createElement('textarea')
      el.value = data.flowPrompt
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (!data) {
    return (
      <Card className="border-dashed border-zinc-800 bg-zinc-900/30">
        <CardContent className="flex min-h-[220px] flex-col items-center justify-center gap-2 p-6 text-center">
          <ScrollText className="h-8 w-8 text-zinc-700" />
          <p className="text-sm text-zinc-500">
            Your structured, Flow-ready prompt will appear here after analysis.
          </p>
        </CardContent>
      </Card>
    )
  }

  const fidelity = FIDELITY_BADGE[data.analysis.fidelity]
  const filledFields = STRUCTURE_FIELDS.filter((f) => (data.structure[f] ?? '').trim()).length

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Flow-Ready Output</CardTitle>
          <Badge variant="outline" className={`font-mono text-[11px] ${fidelity.className}`}>
            <ShieldCheck className="mr-1 h-3 w-3" />
            {fidelity.label}
          </Badge>
        </div>
        <CardDescription>
          {filledFields}/{STRUCTURE_FIELDS.length} structure fields filled · request{' '}
          <span className="font-mono text-[11px]">{data.requestId.slice(0, 8)}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="prompt">
          <TabsList className="mb-3 bg-zinc-950">
            <TabsTrigger value="prompt" className="gap-1.5 text-xs">
              <ScrollText className="h-3.5 w-3.5" />
              Flow prompt
            </TabsTrigger>
            <TabsTrigger value="json" className="gap-1.5 text-xs">
              <FileJson className="h-3.5 w-3.5" />
              Structured JSON
            </TabsTrigger>
            <TabsTrigger value="fidelity" className="gap-1.5 text-xs">
              <ShieldCheck className="h-3.5 w-3.5" />
              Fidelity report
            </TabsTrigger>
          </TabsList>

          {/* ── Tab 1: Flow-ready prompt ── */}
          <TabsContent value="prompt" className="space-y-3">
            <ScrollArea className="max-h-72 rounded-lg border border-zinc-800 bg-zinc-950/80 p-4">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-200">
                {data.flowPrompt}
              </pre>
            </ScrollArea>
            <Button
              onClick={copyPrompt}
              className="h-10 w-full bg-amber-500 text-zinc-950 hover:bg-amber-400"
              variant="default"
            >
              {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              {copied ? 'Copied to clipboard' : 'Copy Flow prompt'}
            </Button>
          </TabsContent>

          {/* ── Tab 2: Structured JSON ── */}
          <TabsContent value="json">
            <ScrollArea className="max-h-72 rounded-lg border border-zinc-800 bg-zinc-950/80 p-4">
              <div className="space-y-2">
                {STRUCTURE_FIELDS.map((field) => {
                  const value = data.structure[field]
                  return (
                    <div key={field} className="grid grid-cols-[140px_1fr] gap-2 text-xs">
                      <span className="text-zinc-500">{STRUCTURE_LABELS[field]}</span>
                      <span className={`font-mono break-words ${value ? 'text-zinc-200' : 'text-zinc-600 italic'}`}>
                        {value || '— not specified —'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
            <p className="mt-2 text-[11px] text-zinc-500">
              Internal structure — only fields with information from your request are filled. Empty fields are
              correct: the analyzer never guesses.
            </p>
          </TabsContent>

          {/* ── Tab 3: Fidelity report ── */}
          <TabsContent value="fidelity" className="space-y-3">
            {data.analysis.notes && (
              <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-xs leading-relaxed text-zinc-300">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <p>{data.analysis.notes}</p>
              </div>
            )}
            {data.analysis.conflicts.length > 0 && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-red-300">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Detected conflicts ({data.analysis.conflicts.length})
                </p>
                <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed text-red-200/90">
                  {data.analysis.conflicts.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Warnings ({data.warnings.length})
                </p>
                <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed text-amber-200/90">
                  {data.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {!data.analysis.notes && data.analysis.conflicts.length === 0 && data.warnings.length === 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-xs leading-relaxed text-emerald-200">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Clean analysis — your request was organized without rewording, with no conflicts or warnings. Your
                  original intent is fully preserved in the Flow prompt.
                </p>
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Fidelity rule: the analyzer only uses words from your request and your selections. It never invents
              people, objects, brands, text or locations.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

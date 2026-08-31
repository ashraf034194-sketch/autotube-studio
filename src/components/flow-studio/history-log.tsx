'use client'

// ─────────────────────────────────────────────────────────────────────────────
// History Log — session record of every request's real outcome
//
// Entries are only recorded when a request reaches a terminal state
// (COMPLETED / FAILED / LIMIT_REACHED) — the log reflects real outcomes,
// never in-flight guesses. Persisted to localStorage (capped, last 25).
// ─────────────────────────────────────────────────────────────────────────────

import { Clock, CheckCircle2, XCircle, Ban, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { HistoryEntry } from '@/lib/flow-studio/types'

const TERMINAL_ICON = {
  COMPLETED: CheckCircle2,
  FAILED: XCircle,
  LIMIT_REACHED: Ban
} as const

const TERMINAL_BADGE = {
  COMPLETED: 'border-emerald-700 bg-emerald-950 text-emerald-300',
  FAILED: 'border-red-700 bg-red-950 text-red-300',
  LIMIT_REACHED: 'border-amber-700 bg-amber-950 text-amber-300'
} as const

export interface HistoryLogProps {
  entries: HistoryEntry[]
  onClear: () => void
}

function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

export function HistoryLog({ entries, onClear }: HistoryLogProps) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-amber-400" />
            Session History
          </CardTitle>
          {entries.length > 0 && (
            <Button
              onClick={onClear}
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs text-zinc-400 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>
        <CardDescription>
          Only requests that reached a real terminal state are recorded — no fake successes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No completed requests yet this session.
          </p>
        ) : (
          <ScrollArea className="max-h-96 overflow-y-auto pr-2">
            <ul className="space-y-2">
              {entries.map((e) => {
                const Icon = TERMINAL_ICON[e.finalState] ?? XCircle
                const badge = TERMINAL_BADGE[e.finalState]
                return (
                  <li
                    key={e.requestId}
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        e.finalState === 'COMPLETED'
                          ? 'text-emerald-400'
                          : e.finalState === 'FAILED'
                            ? 'text-red-400'
                            : 'text-amber-400'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-zinc-200">{e.promptExcerpt}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {formatTime(e.createdAt)} · {e.styleLabel} · {e.aspectRatio} ·{' '}
                        <span className="font-mono">{e.requestId.slice(0, 8)}</span>
                      </p>
                    </div>
                    <Badge variant="outline" className={`shrink-0 font-mono text-[10px] ${badge}`}>
                      {e.finalState}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

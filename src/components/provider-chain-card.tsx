'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Layers, AlertCircle, RefreshCw } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// ─── Types ─────────────────────────────────────────────────────────────────

interface ProviderStatus {
  name: string
  label: string
  configured: boolean
  reason: string
}

interface ProvidersResponse {
  total: number
  configured: number
  providers: ProviderStatus[]
}

// ─── Tier → dot color (NO indigo/blue) ────────────────────────────────────
//   T1 Manus  → purple
//   T2 Google → emerald
//   T3 Z.ai   → amber
//   T4 Cloud  → orange
//   T5 Poll   → teal
const TIER_DOT: string[] = [
  'bg-purple-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-orange-500',
  'bg-teal-500'
]
const TIER_GLOW: string[] = [
  'shadow-purple-500/30',
  'shadow-emerald-500/30',
  'shadow-amber-500/30',
  'shadow-orange-500/30',
  'shadow-teal-500/30'
]

// ─── fetchJson (same pattern as page.tsx) ───────────────────────────────────

async function fetchJson(
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error('Could not reach the server.')
  }
  const raw = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw)
  } catch {
    console.error(
      `[${url}] Non-JSON response (status ${res.status}):`,
      raw.slice(0, 300)
    )
    throw new Error(
      res.status >= 500
        ? 'The server hit an internal error while loading the provider chain.'
        : `The server returned an unexpected response (status ${res.status}).`
    )
  }
  return { ok: res.ok, status: res.status, json }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ProviderChainCard() {
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { ok, status, json } = await fetchJson('/api/images/providers', {
        method: 'GET'
      })
      if (!ok) {
        throw new Error(
          (json.error as string) || `Request failed with status ${status}`
        )
      }
      setData({
        total: json.total as number,
        configured: json.configured as number,
        providers: json.providers as ProviderStatus[]
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load provider chain.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Refresh every 30s so the live / skip badges stay current.
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const tierCount = data?.configured ?? 0
  const totalTiers = data?.total ?? 5
  const badgeClass =
    tierCount === totalTiers
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
      : tierCount >= 3
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
        : 'border-red-500/40 bg-red-500/10 text-red-400'

  return (
    <Card className="border-zinc-800/80 bg-zinc-900/50">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-zinc-400" aria-hidden="true" />
            Image Generation — 5-Tier Fallback Chain
          </CardTitle>
          {!loading && !error && data && (
            <Badge
              variant="outline"
              className={`px-2.5 py-1 ${badgeClass}`}
            >
              {tierCount}/{totalTiers} tiers live
            </Badge>
          )}
        </div>
        <CardDescription>
          Each image is tried through up to 5 providers in order. If a tier is
          unavailable, throttled, or fails, the next one takes over — so
          generation always completes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <div className="space-y-3 py-1" aria-live="polite">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 pb-3 last:pb-0">
                <div className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-zinc-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-zinc-800" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-800" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={load}
              className="h-9 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : data ? (
          <motion.ol
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="relative"
          >
            {data.providers.map((p, i) => {
              const dotClass = p.configured ? TIER_DOT[i] : 'bg-zinc-600'
              const glowClass = p.configured ? TIER_GLOW[i] : ''
              const isLast = i === data.providers.length - 1
              return (
                <li
                  key={p.name}
                  className="relative flex gap-3 pb-4 last:pb-0"
                >
                  {/* Dot column — fixed width, line drawn from below dot to bottom of li */}
                  <div className="relative w-3 shrink-0">
                    {/* Vertical connector — extends through pb-4 to reach next dot */}
                    {!isLast && (
                      <span
                        aria-hidden="true"
                        className="absolute left-1/2 top-3 -bottom-4 w-px -translate-x-1/2 bg-zinc-800"
                      />
                    )}
                    <span
                      className={`absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-full ${dotClass} shadow ${glowClass}`}
                      aria-hidden="true"
                    />
                  </div>
                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        Tier {i + 1}
                      </span>
                      <span
                        className={`text-sm font-medium ${
                          p.configured ? 'text-zinc-100' : 'text-zinc-500'
                        }`}
                      >
                        {p.label}
                      </span>
                      {p.configured ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/5 px-1.5 py-0 text-[10px] text-emerald-400"
                        >
                          live
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-zinc-700 bg-zinc-800/50 px-1.5 py-0 text-[10px] text-zinc-500"
                        >
                          skip
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                      {p.reason}
                    </p>
                  </div>
                </li>
              )
            })}
          </motion.ol>
        ) : null}
      </CardContent>
    </Card>
  )
}

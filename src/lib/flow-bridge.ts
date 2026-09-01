// ── Flow Bridge client (server-side only) ────────────────────────────────────
//
// Typed HTTP client for the AutoTube Flow Bridge mini-service
// (mini-services/flow-bridge, port 3031). Google Flow has NO public API, so
// the bridge drives the REAL Flow web app in a logged-in Chromium. This
// client is used exclusively by Next.js API routes / server code — never from
// the browser (the browser talks to /api/flow-bridge/* proxies instead).

const BASE = process.env.FLOW_BRIDGE_URL || 'http://127.0.0.1:3031'

export interface BridgeQueueState {
  pending: number
  activeId: string | null
  done: number
  failed: number
}

export interface BridgeStatus {
  ok: boolean
  /** true when the bridge process is unreachable on :3031. */
  offline?: boolean
  mode?: 'real' | 'simulation'
  browserRunning?: boolean
  chromiumFound?: boolean
  pageUrl?: string | null
  loginState?: 'unknown' | 'needs-login' | 'ready'
  queue?: BridgeQueueState
  lastError?: string | null
  service?: string
}

export interface BridgeTaskState {
  ok: boolean
  id?: string
  status?: 'queued' | 'running' | 'done' | 'error'
  error?: string | null
  mode?: string
  hasImage?: boolean
}

async function bridgeFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 5000
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/** Bridge health + login + queue snapshot (never throws — returns offline). */
export async function getBridgeStatus(): Promise<BridgeStatus> {
  try {
    const res = await bridgeFetch('/api/status')
    if (!res.ok) {
      return { ok: false, offline: true, lastError: `bridge returned HTTP ${res.status}` }
    }
    return (await res.json()) as BridgeStatus
  } catch {
    return { ok: false, offline: true, lastError: 'bridge offline — is it running on :3031?' }
  }
}

/** Current live-view screenshot of the real Flow page (JPEG bytes) or null. */
export async function getBridgeFrame(): Promise<ArrayBuffer | null> {
  try {
    const res = await bridgeFetch('/api/frame', undefined, 8000)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

/** Relay a control action to the bridge (login / click / type / key / mode). */
export async function bridgeControl(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await bridgeFetch(
      '/api/control',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
      },
      25_000
    )
    const json = (await res.json()) as Record<string, unknown>
    return { ...json, ok: res.ok && json.ok === true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'bridge request failed' }
  }
}

/** Enqueue one generation task on the bridge. */
export async function bridgeEnqueue(
  id: string,
  prompt: string
): Promise<{ ok: boolean; error?: string; queued?: number; mode?: string; alreadyDone?: boolean }> {
  try {
    const res = await bridgeFetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, prompt })
    })
    const json = (await res.json()) as Record<string, unknown>
    return { ...(json as object), ok: res.ok && json.ok === true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'bridge unreachable' }
  }
}

/** Poll one task's state on the bridge. */
export async function bridgeTask(id: string): Promise<BridgeTaskState> {
  try {
    const res = await bridgeFetch(`/api/generate/${encodeURIComponent(id)}`)
    if (!res.ok) {
      let msg = `bridge returned HTTP ${res.status}`
      try {
        const j = (await res.json()) as { error?: string }
        if (j.error) msg = j.error
      } catch {
        /* keep default */
      }
      return { ok: false, error: msg }
    }
    // The bridge's task payload has no "ok" field — HTTP 200 means ok.
    const json = (await res.json()) as Record<string, unknown>
    return { ...(json as unknown as BridgeTaskState), ok: true }
  } catch {
    return { ok: false, error: 'bridge unreachable' }
  }
}

/** Fetch the generated image bytes for a finished task. */
export async function bridgeImage(id: string): Promise<Buffer | null> {
  try {
    const res = await bridgeFetch(`/api/image/${encodeURIComponent(id)}`, undefined, 30_000)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

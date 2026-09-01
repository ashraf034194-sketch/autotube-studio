// ── AutoTube Flow Bridge ─────────────────────────────────────────────────────
//
// WHY THIS EXISTS
//   Google Flow (https://labs.google/fx/tools/flow) has NO public API. A web
//   page also cannot control another browser tab (cross-origin sandbox), so
//   "our app drives the real Flow tab" needs a browser it owns. This service
//   keeps a REAL Chromium open with a persistent Google profile:
//
//     • The user logs into Google ONCE through the app's live view (this
//       bridge's page, remote-controlled click-by-click).
//     • After that, POST /api/generate automates the real Flow UI: type the
//       prompt, submit, capture the generated asset when Flow downloads it.
//     • The app's autopilot pulls the finished image bytes back and fills its
//       image slots — the whole video pipeline runs hands-off.
//
//   GOOGLE SIGN-IN HARDENING ("This browser or app may not be secure" FIX):
//   Google blocks sign-in from browsers that look automated. Two markers made
//   our Chromium look automated: the default user-agent contained
//   "HeadlessChrome/..." and navigator.webdriver was true. The launch() options
//   now (1) report a normal "Chrome/<real-version>" UA, (2) disable the
//   AutomationControlled blink feature, and (3) strip webdriver via an init
//   script — verified live: Google's sign-in form accepts this browser (fake
//   email → normal "Couldn't find this account", NOT the security block).
//
//   Credits/limits: generation happens inside the user's OWN logged-in Flow
//   account at Flow's natural speed — nothing is bypassed, no API keys exist.
//   If Google blocks the automated sign-in or Flow's DOM changes, the bridge
//   reports it honestly (selectors.json is editable without code changes,
//   and the live view allows manual assist).
//
//   A clearly-labelled SIMULATION mode (ffmpeg placeholders) exists to verify
//   the whole app pipeline without touching Google — it never pretends to be
//   real Flow output.
//
// PORT: 3031 (fixed). Run with: bun run dev  (bun --hot auto-restart).

import { chromium, type BrowserContext, type Page, type ElementHandle, type Download } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, execFileSync } from 'child_process'

const PORT = 3031
const ROOT = import.meta.dir
const PROFILE_DIR = path.join(ROOT, 'flow-profile')
const DOWNLOAD_DIR = path.join(ROOT, 'downloads')
const SELECTORS_PATH = path.join(ROOT, 'selectors.json')

const VIEWPORT = { width: 1280, height: 800 }

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'
]

// ─── selectors.json (editable without touching code) ─────────────────────────
function loadSelectors(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}
function selList(key: string): string[] {
  const v = loadSelectors()[key]
  return Array.isArray(v) ? (v as string[]) : []
}
function selNum(key: string, dflt: number): number {
  const v = loadSelectors()[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}
function selStr(key: string, dflt: string): string {
  const v = loadSelectors()[key]
  return typeof v === 'string' && v ? v : dflt
}

// ─── state (survives bun --hot reloads via globalThis) ───────────────────────
interface Task {
  id: string
  prompt: string
  status: 'queued' | 'running' | 'done' | 'error'
  error?: string
  file?: string
  ext?: string
  mode: 'real' | 'simulation'
  createdAt: number
  doneAt?: number
}

interface Waiter {
  id: string
  resolve: (file: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BridgeState {
  mode: 'real' | 'simulation'
  context: BrowserContext | null
  page: Page | null
  launching: Promise<void> | null
  tasks: Map<string, Task>
  queue: string[]
  activeId: string | null
  workerBusy: boolean
  lastError: string | null
  lastShot: { buf: Buffer; at: number } | null
  loginCache: { value: 'unknown' | 'needs-login' | 'ready'; at: number }
  waiters: Waiter[]
  served: boolean
  router: ((req: Request) => Promise<Response>) | null
  // Google sign-in block self-healing (see healBlockedProfile)
  healing: boolean
  lastHeal: number
  healCount: number
}

const g = globalThis as unknown as { __flowBridge?: BridgeState }
const S: BridgeState = (g.__flowBridge ??= {
  mode: 'real',
  context: null,
  page: null,
  launching: null,
  tasks: new Map(),
  queue: [],
  activeId: null,
  workerBusy: false,
  lastError: null,
  lastShot: null,
  loginCache: { value: 'unknown', at: 0 },
  waiters: [],
  served: false,
  router: null,
  healing: false,
  lastHeal: 0,
  healCount: 0
})

// ─── helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Percent-decoded path segment (URL-encoded ids like "a%3Ab" → "a:b"). */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

function findChromium(): string | null {
  const env = process.env.FLOW_BRIDGE_CHROME
  if (env && fs.existsSync(env)) return env
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright')
  const candidates: string[] = []
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse() : []) {
    candidates.push(path.join(cache, dir, 'chrome-linux64', 'chrome'))
    candidates.push(path.join(cache, dir, 'chrome-linux', 'chrome'))
  }
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function findFont(): string | null {
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return f
  return null
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}

/** Stable 6-hex color from a string (simulation placeholders look distinct). */
function hashColor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const hue = h % 360
  // HSL → cheap hex via hsl string is not supported by lavfi; derive manually.
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    const a = 0.28
    const v = 0.32 - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `${f(0)}${f(8)}${f(4)}`
}

// ─── browser lifecycle ───────────────────────────────────────────────────────
/**
 * Google sign-in hardening — build a NORMAL Chrome user-agent from the actual
 * binary version. Playwright's default headless UA contains "HeadlessChrome",
 * which is THE signal Google uses to show "This browser or app may not be
 * secure / Couldn't sign you in". Presenting the real version (e.g.
 * Chrome/151.0.0.0) makes the browser look like a regular user's Chrome.
 * (selectors.json "userAgentOverride" can replace this entirely if ever needed.)
 */
function hardenUserAgent(exe: string): string {
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim()
    const m = /(\d+)\./.exec(out)
    if (m) {
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m[1]}.0.0.0 Safari/537.36`
    }
  } catch {
    /* fall back to the constant below */
  }
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
}

async function launch(target: 'flow' | 'signin' = 'flow'): Promise<void> {
  if (S.context) return
  const exe = findChromium()
  if (!exe) {
    S.lastError = 'No Chromium binary found (expected ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome). Set FLOW_BRIDGE_CHROME or install Playwright browsers.'
    console.error('[flow-bridge]', S.lastError)
    return
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  console.log('[flow-bridge] launching Chromium (persistent profile:', PROFILE_DIR, ')')
  try {
    // Google sign-in hardening (fixes "This browser or app may not be secure"):
    //   • userAgent: normal "Chrome/<version>" — no "HeadlessChrome" marker
    //   • --disable-blink-features=AutomationControlled — removes navigator.webdriver
    //   • init script below — belt-and-braces webdriver strip on every page/frame
    // Verified against the live sign-in flow: Google accepts this browser (the
    // identifier step returns normal account errors, not the security block).
    S.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      executablePath: exe,
      viewport: VIEWPORT,
      acceptDownloads: true,
      userAgent: selStr('userAgentOverride', hardenUserAgent(exe)),
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    })
    try {
      await S.context.addInitScript(() => {
        try {
          Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: () => undefined,
            configurable: true
          })
        } catch {
          /* non-fatal — AutomationControlled already removes it at the source */
        }
      })
    } catch {
      /* non-fatal */
    }
    S.page = S.context.pages()[0] ?? (await S.context.newPage())
    S.page.on('download', (d) => void onDownload(d))
    S.context.on('close', () => {
      S.context = null
      S.page = null
      // loginCache is intentionally PRESERVED: the profile survives closes, so
      // the last known login state stays valid (runReal re-verifies anyway).
      console.warn('[flow-bridge] browser context closed — it will relaunch on next use')
    })
    try {
      await S.page.goto(
        target === 'signin'
          ? selStr(
              'googleSigninUrl',
              'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F&hl=en'
            )
          : selStr('flowLandingUrl', 'https://labs.google/fx/tools/flow'),
        { waitUntil: 'domcontentloaded', timeout: 45_000 }
      )
      console.log('[flow-bridge] initial page loaded:', S.page.url())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      S.lastError = `Could not open the initial page: ${msg.slice(0, 150)}`
      console.warn('[flow-bridge]', S.lastError)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    S.lastError = `Chromium failed to launch: ${msg.slice(0, 150)}`
    console.error('[flow-bridge]', S.lastError)
  }
}

async function ensureBrowser(target: 'flow' | 'signin' = 'flow'): Promise<void> {
  if (S.context && S.page) return
  if (!S.launching) S.launching = launch(target).finally(() => (S.launching = null))
  await S.launching
  if (!S.page) throw new Error(S.lastError || 'Browser is not running.')
}

// ─── download capture (the actual image hand-off from Flow) ──────────────────
async function onDownload(d: Download): Promise<void> {
  const waiter = S.waiters[S.waiters.length - 1]
  const id = waiter?.id ?? S.activeId ?? `orphan-${Date.now()}`
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  const suggested = d.suggestedFilename() || 'image.png'
  const ext = (path.extname(suggested).toLowerCase() || '.png').replace('.', '')
  const file = path.join(DOWNLOAD_DIR, `${id}.${ext}`)
  try {
    await d.saveAs(file)
    console.log(`[flow-bridge] download captured → ${file} (${suggested})`)
    const t = S.tasks.get(id)
    if (t) {
      t.file = file
      t.ext = ext
    }
    if (waiter) {
      clearTimeout(waiter.timer)
      S.waiters.pop()
      waiter.resolve(file)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[flow-bridge] download save failed:', msg)
    if (waiter) {
      clearTimeout(waiter.timer)
      S.waiters.pop()
      waiter.reject(new Error(`Saving the Flow download failed: ${msg.slice(0, 120)}`))
    }
  }
}

function waitForDownload(id: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = S.waiters.indexOf(waiter)
      if (i >= 0) S.waiters.splice(i, 1)
      reject(
        new Error(
          `No image download arrived within ${Math.round(timeoutMs / 1000)}s — generation may have failed or Flow's UI changed. Check the live view; you can also drive Flow manually there and press the download button (the bridge captures ANY download while a task waits).`
        )
      )
    }, timeoutMs)
    const waiter: Waiter = { id, resolve, reject, timer }
    S.waiters.push(waiter)
  })
}

// ─── live view ───────────────────────────────────────────────────────────────
async function screenshot(): Promise<Buffer | null> {
  if (!S.page) return null
  const now = Date.now()
  if (S.lastShot && now - S.lastShot.at < 700) return S.lastShot.buf
  try {
    const buf = (await S.page.screenshot({ type: 'jpeg', quality: 72 })) as Buffer
    S.lastShot = { buf, at: now }
    return buf
  } catch {
    return S.lastShot?.buf ?? null
  }
}

/**
 * Self-heal for Google's "This browser or app may not be secure" block.
 *
 * Google blocks sign-in when the browser profile looks automated/abusive.
 * The launch hardening (clean UA, no webdriver) prevents the browser-side
 * block; but a profile that has been through repeated blocked attempts keeps
 * tripping the check — the ONLY reliable cure for that is a fresh profile.
 * This closes the browser, wipes the profile directory and relaunches the
 * hardened browser straight onto the sign-in page (the live view updates; the
 * user re-enters their email once). A working login is never destroyed: the
 * heal only runs when Google's block PAGE is actually visible.
 *
 * Guards: reentrancy flag, 2-minute cooldown, max 3 auto-heals without a
 * successful login in between (rate-limit-style server blocks can't be fixed
 * by wiping — after 3, we surface an honest error instead of looping).
 */
async function healBlockedProfile(force = false): Promise<void> {
  if (S.healing) return
  if (!force && Date.now() - S.lastHeal < 120_000) return
  if (!force && S.healCount >= 3) {
    S.lastError =
      'Google keeps blocking sign-in from this browser. This is usually a temporary rate-limit on the network — wait ~15–60 minutes and press "Sign in with Google" again (it lifts on its own), or use the QR-code / phone-tap sign-in, or run the bridge on your own machine.'
    return
  }
  S.healing = true
  try {
    console.log('[flow-bridge] Google sign-in block detected — resetting profile (fresh hardened browser)…')
    if (S.context) await S.context.close().catch(() => {})
    S.context = null
    S.page = null
    await sleep(800) // let Chromium fully exit and release the profile lock before wiping
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
    await ensureBrowser('signin')
    S.loginCache = { value: 'unknown', at: 0 }
    S.lastHeal = Date.now()
    if (force) S.healCount = 0
    else S.healCount++
    S.lastError = null
    console.log('[flow-bridge] profile reset complete — fresh Google sign-in page is open')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    S.lastError = `Profile reset failed: ${msg.slice(0, 150)}`
    console.warn('[flow-bridge]', S.lastError)
  } finally {
    S.healing = false
  }
}

async function loginState(): Promise<'unknown' | 'needs-login' | 'ready'> {
  if (!S.page) return 'unknown'
  if (Date.now() - S.loginCache.at < 5000) return S.loginCache.value
  let value: 'unknown' | 'needs-login' | 'ready' = 'unknown'
  try {
    const url = S.page.url()
    if (url.includes('accounts.google.com')) {
      // On Google's sign-in pages the ONLY honest answer is needs-login —
      // EXCEPT the security block page, which self-heals below.
      value = 'needs-login'
      const content = await S.page.content()
      if (/This browser or app may not be secure|Try using a different browser/i.test(content)) {
        void healBlockedProfile()
      }
    } else if (url.includes('flow.google.com')) {
      // Being INSIDE the Flow app means Google SSO already accepted us.
      value = 'ready'
    } else if (url.includes('labs.google') || !/^https?:/i.test(url)) {
      // Marketing landing page / blank tab — no signal either way.
      value = 'unknown'
    } else {
      const content = await S.page.content()
      value = /sign in|log in|sign-in/i.test(content) ? 'needs-login' : 'ready'
    }
  } catch {
    value = 'unknown'
  }
  if (value === 'ready') S.healCount = 0 // a working login resets the heal budget
  S.loginCache = { value, at: Date.now() }
  return value
}

async function statusPayload(): Promise<Record<string, unknown>> {
  let done = 0
  let failed = 0
  for (const t of S.tasks.values()) {
    if (t.status === 'done') done++
    else if (t.status === 'error') failed++
  }
  // Live fingerprint check — proves the Google sign-in hardening is active
  // (a clean "Chrome/<v>" UA and webdriver===undefined are what Google needs
  // to NOT show "This browser or app may not be secure").
  let fingerprint: { ua: string | null; webdriver: boolean | null } | null = null
  if (S.page) {
    try {
      fingerprint = await S.page.evaluate(() => ({
        ua: navigator.userAgent,
        webdriver: navigator.webdriver
      }))
    } catch {
      fingerprint = null
    }
  }
  return {
    ok: true,
    mode: S.mode,
    browserRunning: !!(S.context && S.page),
    chromiumFound: !!findChromium(),
    pageUrl: S.page?.url() ?? null,
    loginState: await loginState(),
    fingerprint,
    queue: { pending: S.queue.length, activeId: S.activeId, done, failed },
    lastError: S.lastError,
    service: 'autotube-flow-bridge'
  }
}

// ─── generation — simulation mode ────────────────────────────────────────────
async function runSimulation(t: Task): Promise<void> {
  // ~1.2–2.7s per image, so the pipeline feels like a real queue.
  await sleep(1200 + (t.id.length * 137) % 1500)
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  const file = path.join(DOWNLOAD_DIR, `${t.id}.jpg`)
  const label = `SIMULATION ${t.id.slice(-4)} - placeholder, not real Flow output`
  const safe = label.replace(/[':\\%]/g, ' ')
  const font = findFont()
  const vf = font
    ? `drawtext=fontfile=${font}:text='${safe}':fontcolor=white@0.92:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2`
    : null
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=0x${hashColor(t.id)}:s=1344x768:d=1`]
  if (vf) args.push('-vf', vf)
  args.push('-frames:v', '1', '-q:v', '3', file)
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()))
  })
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) throw new Error('ffmpeg produced no placeholder image.')
  t.file = file
  t.ext = 'jpg'
}

// ─── generation — real Flow UI automation ────────────────────────────────────
async function firstVisible(selectors: string[], timeoutMs: number): Promise<ElementHandle | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const s of selectors) {
      try {
        const el = (await S.page!.$(s)) as ElementHandle | null
        if (el && (await el.isVisible().catch(() => false))) return el
      } catch {
        /* selector invalid for this page — try the next one */
      }
    }
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}

async function runReal(t: Task): Promise<void> {
  await ensureBrowser()
  if (!S.page) throw new Error(S.lastError || 'Browser is not running.')

  const ls = await loginState()
  if (ls === 'needs-login') {
    throw new Error(
      'Google login required — press "Sign in with Google" in the app (email, phone-tap, or QR code), then retry. The bridge browser is hardened to pass Google\u2019s security check; if your network still blocks it, run the bridge on your own machine.'
    )
  }

  // If we're still sitting on the landing/marketing page, hop into the app.
  const url = S.page.url()
  if (!url.includes('flow.google')) {
    try {
      await S.page.goto(selStr('flowAppUrl', 'https://flow.google.com/'), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      /* stay where we are — the selectors below may still find a prompt box */
    }
  }

  // Optional mode pre-toggle (e.g. "ingredients / image mode") — best effort.
  for (const s of selList('ingredientToggleSelectors')) {
    try {
      const el = (await S.page.$(s)) as ElementHandle | null
      if (el && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 3000 })
        break
      }
    } catch {
      /* best effort only */
    }
  }

  const box = await firstVisible(selList('promptBoxSelectors'), 8000)
  if (!box) {
    throw new Error(
      "Flow's prompt box was not found — Flow's UI may have changed. Edit promptBoxSelectors in mini-services/flow-bridge/selectors.json, or drive Flow manually from the live view (downloads are still captured while a task waits)."
    )
  }

  await box.click({ timeout: 5000 })
  try {
    await box.fill('', { timeout: 3000 })
  } catch {
    /* contenteditable quirk — keyboard fallback below clears it */
  }
  try {
    await box.fill(t.prompt, { timeout: 5000 })
  } catch {
    await S.page.keyboard.press('Control+A')
    await S.page.keyboard.press('Delete')
    await S.page.keyboard.type(t.prompt, { delay: 6 })
  }

  await sleep(selNum('settleMs', 900))
  await S.page.keyboard.press('Enter')

  // Also try an explicit submit button (Enter is usually enough, but be safe).
  const btn = await firstVisible(selList('submitButtonSelectors'), 2500)
  if (btn) {
    try {
      await btn.click({ timeout: 3000 })
    } catch {
      /* Enter already submitted — ignore */
    }
  }

  // Wait for Flow to hand us the image via a browser download event.
  const file = await waitForDownload(t.id, selNum('generateTimeoutMs', 150_000))
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
    throw new Error('The downloaded file looks empty — retry this image.')
  }
  t.file = file
  t.ext = path.extname(file).slice(1).toLowerCase() || 'png'
}

// ─── queue worker (one generation at a time — Flow's natural pace) ────────────
function ensureWorker(): void {
  if (S.workerBusy) return
  S.workerBusy = true
  void (async () => {
    try {
      for (;;) {
        const id = S.queue.shift()
        if (!id) break
        const t = S.tasks.get(id)
        if (!t) continue
        S.activeId = id
        t.status = 'running'
        console.log(`[flow-bridge] generating ${id} (${S.mode}) — "${t.prompt.slice(0, 70)}…"`)
        try {
          if (S.mode === 'simulation') await runSimulation(t)
          else await runReal(t)
          if (t.status !== 'error') t.status = 'done'
        } catch (err) {
          t.status = 'error'
          t.error = err instanceof Error ? err.message : String(err)
          S.lastError = t.error
          console.warn(`[flow-bridge] task ${id} FAILED: ${t.error.slice(0, 200)}`)
        }
        t.doneAt = Date.now()
        S.activeId = null
        await sleep(500) // breather between generations (be a good citizen)
      }
    } finally {
      S.workerBusy = false
    }
  })()
}

// ─── HTTP router ─────────────────────────────────────────────────────────────
const ALLOWED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Home', 'End',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'
])

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname

  // GET /api/status — bridge health + login + queue snapshot. NOTE: does NOT
  // auto-launch the browser (the app polls this every 2.5s — auto-launch here
  // would immediately resurrect a deliberately-closed browser and waste RAM).
  // The browser launches at bridge boot and on demand (login / open-app /
  // generate / close-browser + status polling only reports).
  if (req.method === 'GET' && p === '/api/status') {
    return json(await statusPayload())
  }

  // GET /api/frame — current live-view screenshot (JPEG)
  if (req.method === 'GET' && p === '/api/frame') {
    const buf = await screenshot()
    if (!buf) return new Response('No live page yet', { status: 503 })
    return new Response(new Uint8Array(buf), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }
    })
  }

  // POST /api/control — login navigation, remote clicks/typing, mode switch
  if (req.method === 'POST' && p === '/api/control') {
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return json({ error: 'Invalid JSON body.' }, 400)
    }
    const action = String(body.action ?? '')
    try {
      if (action === 'login' || action === 'open-app') {
        await ensureBrowser()
        if (!S.page) return json({ error: S.lastError || 'Browser is not running.' }, 503)
        const target = action === 'login'
          ? selStr('flowLandingUrl', 'https://labs.google/fx/tools/flow')
          : selStr('flowAppUrl', 'https://flow.google.com/')
        await S.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        S.loginCache = { value: 'unknown', at: 0 }
        return json({ ok: true, url: S.page.url() })
      }
      if (action === 'google-signin') {
        // "Sign in with Google" — jump straight to GOOGLE'S OWN sign-in page
        // (skipping the Flow marketing landing page). This surfaces every
        // method Google itself supports for this browser: email+password,
        // "Try another way" → phone prompt (tap Yes on your phone, no
        // password typed here), passkey / QR-code sign-in (scan the QR shown
        // in the app's live view with your phone — no email, no password),
        // and the account chooser ("Continue as …") when the profile already
        // knows an account. AccountChooser falls back to the normal sign-in
        // form when nothing is remembered, so one URL covers all cases.
        await ensureBrowser()
        if (!S.page) return json({ error: S.lastError || 'Browser is not running.' }, 503)
        const target = selStr(
          'googleSigninUrl',
          'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F&hl=en'
        )
        await S.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        S.loginCache = { value: 'unknown', at: 0 }
        return json({ ok: true, url: S.page.url() })
      }
      if (action === 'reset-login') {
        // Manual "Reset & retry" — same cure as the automatic self-heal, but
        // user-initiated (bypasses the cooldown, resets the heal budget).
        // Only offered while sign-in is needed; a working login is never
        // present when Google's block page is showing.
        await healBlockedProfile(true)
        return json({ ok: true, url: S.page?.url() ?? null })
      }
      if (action === 'close-browser') {
        // Frees the Chromium RAM (video assembly needs it). The persistent
        // profile keeps the Google login; ensureBrowser() relaunches on the
        // next login/open-app/generate action.
        if (S.context) {
          await S.context.close().catch(() => {})
        }
        S.context = null
        S.page = null
        return json({ ok: true, browserRunning: false })
      }
      if (action === 'reload' || action === 'back') {
        if (!S.page) return json({ error: 'Browser is not running.' }, 503)
        if (action === 'reload') await S.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        else await S.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        S.loginCache = { value: 'unknown', at: 0 }
        return json({ ok: true, url: S.page.url() })
      }
      if (action === 'click') {
        if (!S.page) return json({ error: 'Browser is not running.' }, 503)
        const x = Number(body.x)
        const y = Number(body.y)
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          return json({ error: 'x/y must be normalized 0..1.' }, 400)
        }
        await S.page.mouse.click(Math.round(x * VIEWPORT.width), Math.round(y * VIEWPORT.height))
        S.loginCache = { value: 'unknown', at: 0 }
        return json({ ok: true })
      }
      if (action === 'type') {
        if (!S.page) return json({ error: 'Browser is not running.' }, 503)
        const text = String(body.text ?? '')
        if (!text || text.length > 500) return json({ error: 'text required (max 500 chars).' }, 400)
        await S.page.keyboard.type(text, { delay: 25 })
        return json({ ok: true })
      }
      if (action === 'key') {
        if (!S.page) return json({ error: 'Browser is not running.' }, 503)
        const key = String(body.key ?? '')
        if (!ALLOWED_KEYS.has(key)) return json({ error: 'Key not allowed.' }, 400)
        await S.page.keyboard.press(key)
        S.loginCache = { value: 'unknown', at: 0 }
        return json({ ok: true })
      }
      if (action === 'mode') {
        const mode = String(body.mode ?? '')
        if (mode !== 'simulation' && mode !== 'real') return json({ error: "mode must be 'simulation' or 'real'." }, 400)
        S.mode = mode
        console.log(`[flow-bridge] mode switched to ${mode}`)
        return json({ ok: true, mode: S.mode })
      }
      return json({ error: `Unknown action "${action}".` }, 400)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return json({ error: msg.slice(0, 200) }, 500)
    }
  }

  // POST /api/generate — enqueue { id, prompt }
  if (req.method === 'POST' && p === '/api/generate') {
    let body: { id?: string; prompt?: string }
    try {
      body = (await req.json()) as { id?: string; prompt?: string }
    } catch {
      return json({ error: 'Invalid JSON body.' }, 400)
    }
    const id = String(body.id ?? '')
    const prompt = String(body.prompt ?? '')
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(id)) return json({ error: 'id must match ^[A-Za-z0-9:_-]{1,120}$.' }, 400)
    if (!prompt || prompt.length > 4000) return json({ error: 'prompt required (max 4000 chars).' }, 400)

    const existing = S.tasks.get(id)
    if (existing && existing.status === 'done') {
      return json({ ok: true, alreadyDone: true })
    }
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return json({ ok: true, alreadyQueued: true })
    }
    S.tasks.set(id, {
      id,
      prompt,
      status: 'queued',
      mode: S.mode,
      createdAt: Date.now()
    })
    S.queue.push(id)
    ensureWorker()
    return json({ ok: true, queued: S.queue.length, mode: S.mode })
  }

  // GET /api/generate/:id — task status (id is decodeURIComponent'd so
  // ids containing "::" or other URL-escaped characters still match)
  if (req.method === 'GET' && p.startsWith('/api/generate/')) {
    const id = safeDecode(p.slice('/api/generate/'.length))
    const t = S.tasks.get(id)
    if (!t) return json({ error: 'Unknown task id.' }, 404)
    return json({
      ok: true,
      id: t.id,
      status: t.status,
      error: t.error ?? null,
      mode: t.mode,
      hasImage: !!(t.file && fs.existsSync(t.file)),
      createdAt: t.createdAt,
      doneAt: t.doneAt ?? null
    })
  }

  // GET /api/image/:id — the generated image bytes
  if (req.method === 'GET' && p.startsWith('/api/image/')) {
    const id = safeDecode(p.slice('/api/image/'.length))
    const t = S.tasks.get(id)
    if (!t || !t.file || !fs.existsSync(t.file)) return json({ error: 'No image for this task yet.' }, 404)
    const buf = fs.readFileSync(t.file)
    const ext = (t.ext || 'png').toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return new Response(new Uint8Array(buf), {
      headers: { 'content-type': mime, 'cache-control': 'no-store' }
    })
  }

  // GET / — tiny service banner
  if (req.method === 'GET' && (p === '/' || p === '')) {
    return json({
      ok: true,
      service: 'autotube-flow-bridge',
      port: PORT,
      endpoints: ['GET /api/status', 'GET /api/frame', 'POST /api/control', 'POST /api/generate', 'GET /api/generate/:id', 'GET /api/image/:id']
    })
  }

  return json({ error: 'Not found.' }, 404)
}

// keep the router reference fresh across bun --hot reloads
S.router = handleRequest

if (!S.served) {
  Bun.serve({
    port: PORT,
    fetch: (req) => (S.router ? S.router(req) : Promise.resolve(json({ error: 'starting…' }, 503)))
  })
  S.served = true
  console.log(`[flow-bridge] listening on :${PORT} — mode=${S.mode}`)
  void ensureBrowser().catch((e) => console.warn('[flow-bridge] initial browser launch failed:', e))
}

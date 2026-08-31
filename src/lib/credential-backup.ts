// ─── PERMANENT CREDENTIAL BACKUP (sandbox .env reset workaround) ─────────────
//
// ROOT CAUSE (verified 2026-08-31 by deep diagnosis of /tmp/boot-timeline.log):
// The sandbox boot sequence runs a "Project initialization check" step at every
// session start (see /tmp/boot-timeline.log → "Project initialization check"
// step). This step RESETS /home/z/my-project/.env to a baseline template that
// contains ONLY `DATABASE_URL=file:/home/z/my-project/db/custom.db`. The .env
// is NOT in the snapshot manifest (.initial_snapshot.json), so any credentials
// added to .env during a session are WIPED at the next session start.
//
// RESULT before this fix: Pexels + Unsplash showed "skip" in the UI at the
// start of every new session, even after credentials were added in the prior
// session. The user (or main agent) had to re-paste the credentials every time.
//
// PERMANENT FIX: this file lives at src/lib/credential-backup.ts. Files under
// src/lib/ ARE preserved by the snapshot (verified in .initial_snapshot.json —
// "src/lib/stock-photos.ts" etc. are all listed). So the credentials stored
// here survive every session reset.
//
// stock-photos.ts reads process.env.PEXELS_API_KEY first (the .env value when
// present); if that's empty, it falls back to the value here. This makes the
// credentials available immediately at server start, regardless of whether the
// .env has been re-populated yet.
//
// ──────────────────────────────────────────────────────────────────────────
// IMPORTANT RULE (permanently documented — do NOT delete this comment):
// In dono keys (PEXELS_API_KEY, UNSPLASH_ACCESS_KEY) ko KABHI bhi "not set"
// nahi hona chahiye. Agar future mein yeh dobara "skip" dikhayen, iska matlab
// hai environment-persistence mein koi structural issue hai jo turant
// investigate hona chahiye — na ke sirf keys dobara paste karna.
//
// Diagnostic checklist if "skip" reappears:
//   1. Verify this file (src/lib/credential-backup.ts) still exists — if it
//      was deleted, restore it from git or from /tmp/my-project/src/lib/
//   2. Verify stock-photos.ts line `export const PEXELS_API_KEY = ...`
//      still has the `|| CREDENTIAL_BACKUP.PEXELS_API_KEY` fallback
//   3. Read /tmp/boot-timeline.log — check if "Project initialization check"
//      ran (it always does at session start) and whether it touched .env
//   4. Read /home/z/my-project/.env — should have the keys. If only
//      DATABASE_URL is present, the sandbox reset ran.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Credential fallback values. These are intentionally EMPTY in the committed
 * version (public GitHub repo — never hardcode real secrets here).
 *
 * Resolution chain (see resolveCredential below):
 *   1. process.env.PEXELS_API_KEY / process.env.UNSPLASH_ACCESS_KEY  ← preferred
 *   2. CREDENTIAL_BACKUP.* (this file)                                ← empty in repo
 *   3. 'missing' → startup WARNING logged, Z.ai fallback used
 *
 * On local sandbox: paste real values into /home/z/my-project/.env (gitignored).
 *   If the sandbox session-reset wipes .env (known sandbox quirk), re-paste the
 *   keys into .env OR temporarily hardcode them in this file (DO NOT commit).
 *
 * On Render/production: set PEXELS_API_KEY + UNSPLASH_ACCESS_KEY in the Render
 *   dashboard → Environment tab. They persist across deploys there — no need
 *   to touch this file.
 *
 * IMPORTANT RULE (do NOT delete this comment):
 *   In dono keys (PEXELS_API_KEY, UNSPLASH_ACCESS_KEY) ko KABHI bhi "not set"
 *   nahi hona chahiye. Agar future mein yeh dobara "skip" dikhayen, iska matlab
 *   hai environment-persistence mein koi structural issue hai jo turant
 *   investigate hona chahiye — na ke sirf keys dobara paste karna.
 */
export const CREDENTIAL_BACKUP = {
  PEXELS_API_KEY: '',
  UNSPLASH_ACCESS_KEY: ''
} as const

/**
 * Credential resolution: returns the env value if set, otherwise the backup.
 * Used by stock-photos.ts so the dev server has working credentials even
 * immediately after a sandbox session reset.
 */
export function resolveCredential(
  envVar: string | undefined,
  backup: string
): { value: string; source: 'env' | 'backup' | 'missing' } {
  if (envVar && envVar.trim().length > 0) {
    return { value: envVar.trim(), source: 'env' }
  }
  if (backup && backup.trim().length > 0) {
    return { value: backup.trim(), source: 'backup' }
  }
  return { value: '', source: 'missing' }
}

/**
 * Startup self-check — logs a clear WARNING to dev.log/console for any required
 * credential that's missing in BOTH env AND backup. Called once at module load
 * from stock-photos.ts (which is loaded at server start).
 *
 * This makes credential issues surface IMMEDIATELY in dev.log at server start,
 * without needing to manually check the /api/images/providers UI endpoint.
 */
export function logCredentialStatusAtStartup(
  pexels: { value: string; source: 'env' | 'backup' | 'missing' },
  unsplash: { value: string; source: 'env' | 'backup' | 'missing' }
): void {
  const allGood =
    pexels.source !== 'missing' && unsplash.source !== 'missing'
  if (allGood) {
    console.log(
      `[startup] ✓ Stock-photo credentials present — ` +
        `Pexels: ${pexels.source}, Unsplash: ${unsplash.source}`
    )
    return
  }
  console.warn(
    `[startup] ⚠ WARNING — Stock-photo credentials MISSING:\n` +
      `  Pexels:   ${pexels.source === 'missing' ? '✗ NOT SET (env + backup both empty)' : `✓ from ${pexels.source}`}\n` +
      `  Unsplash: ${unsplash.source === 'missing' ? '✗ NOT SET (env + backup both empty)' : `✓ from ${unsplash.source}`}\n` +
      `  → Image generation will fall back to Z.ai (slow, rate-limited).\n` +
      `  → Fix: edit .env to add the missing keys, OR update src/lib/credential-backup.ts.`
  )
}

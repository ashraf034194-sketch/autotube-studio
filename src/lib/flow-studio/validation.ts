// ─────────────────────────────────────────────────────────────────────────────
// Flow Prompt Studio — Validation Engine (module 3 of the tool spec)
//
// Pure, isomorphic (client + server) validation of a generation request.
// The SAME rules run in the browser before submit (instant feedback, no API
// call for invalid input) and again in /api/flow-prompt (server-side truth —
// the client can never be trusted).
//
// Rule categories from the spec:
//   • Empty prompts                      → error
//   • Extremely short requests           → warning (soft — allowed with notice)
//   • Unsupported parameters             → error (aspect ratios Flow can't do)
//   • Invalid user inputs                → error (custom fields left blank)
//   • Conflicting requirements           → warning (listed for the user)
// ─────────────────────────────────────────────────────────────────────────────

import {
  ASPECT_RATIOS,
  GenerationRequest,
  LIGHTING_OPTIONS,
  STYLE_OPTIONS,
  ValidationIssue,
  ValidationResult
} from './types'

const MIN_PROMPT_CHARS = 15
const MAX_PROMPT_CHARS = 4000
const SHORT_PROMPT_WARNING_CHARS = 40

// Known conflicting option pairs (style × lighting, lighting × lighting).
// These are SOFT conflicts: generation will still run, but the result may
// lean toward one option. Surfaced as warnings so the user can decide.
const STYLE_LIGHTING_CONFLICTS: Array<{ styleId: string; lightingId: string; message: string }> = [
  {
    styleId: 'minimal',
    lightingId: 'neon',
    message:
      'Minimal style + Neon lighting pull in different directions — the result may lean toward one. Remove one of them for stricter control.'
  },
  {
    styleId: 'minimal',
    lightingId: 'high-contrast',
    message:
      'Minimal style + High-contrast lighting can conflict — minimal usually reads best with soft, even light.'
  },
  {
    styleId: 'luxury',
    lightingId: 'neon',
    message:
      'Luxury style + Neon lighting mix two strong aesthetics — fine if intentional (e.g. luxury-tech), otherwise pick one.'
  }
]

const LIGHTING_LIGHTING_CONFLICTS: Array<{ a: string; b: string; message: string }> = [
  {
    a: 'natural',
    b: 'studio',
    message: 'Natural light + Studio lighting are different setups — the generator will blend them. Pick the dominant one if it matters.'
  },
  {
    a: 'natural',
    b: 'neon',
    message: 'Natural light + Neon are different setups — the generator will blend them. Pick the dominant one if it matters.'
  },
  {
    a: 'golden-hour',
    b: 'studio',
    message: 'Golden hour + Studio lighting describe different sources — remove one for a cleaner instruction.'
  },
  {
    a: 'soft',
    b: 'high-contrast',
    message: 'Soft light + High contrast are opposing — remove one for a cleaner instruction.'
  }
]

export function validateGenerationRequest(input: GenerationRequest): ValidationResult {
  const issues: ValidationIssue[] = []
  const prompt = (input.prompt ?? '').trim()

  // ── Empty prompt → hard error, exactly the spec's message ──
  if (!prompt) {
    issues.push({
      field: 'prompt',
      severity: 'error',
      message: 'Please describe the main subject you want to generate.'
    })
  }

  // ── Too long → hard error ──
  if (prompt.length > MAX_PROMPT_CHARS) {
    issues.push({
      field: 'prompt',
      severity: 'error',
      message: `Prompt is too long (${prompt.length} characters). Maximum is ${MAX_PROMPT_CHARS.toLocaleString()} — split complex scenes into separate generations.`
    })
  }

  // ── Extremely short → warning (spec: "extremely short requests") ──
  if (prompt.length > 0 && prompt.length < SHORT_PROMPT_WARNING_CHARS) {
    issues.push({
      field: 'prompt',
      severity: 'warning',
      message:
        'This request is extremely short. The more detail you give (subject, setting, light, mood), the more accurate the result — you can also continue without adding more.'
    })
  }

  if (prompt.length > 0 && prompt.length < MIN_PROMPT_CHARS && prompt.length < SHORT_PROMPT_WARNING_CHARS) {
    // Redundant with the warning above at this length; kept for future tuning.
    // (No additional issue pushed — one clear message beats two.)
  }

  // ── Unsupported aspect ratio → hard error with honest reason ──
  const aspect = ASPECT_RATIOS.find((a) => a.id === input.aspectRatio)
  if (!aspect) {
    issues.push({
      field: 'aspectRatio',
      severity: 'error',
      message: `Unknown aspect ratio "${input.aspectRatio}". Choose one of the listed options.`
    })
  } else if (!aspect.supported) {
    issues.push({
      field: 'aspectRatio',
      severity: 'error',
      message: `${aspect.label} aspect ratio is not supported by Google Flow's native image generation. Please choose 1:1, 16:9 or 9:16.`
    })
  }

  // ── Custom style selected but left blank → hard error ──
  if (input.styleId === 'custom' && !(input.customStyle ?? '').trim()) {
    issues.push({
      field: 'customStyle',
      severity: 'error',
      message: 'Custom style is selected — describe the style you want (e.g. "retro 90s film grain").'
    })
  }

  // ── Unknown style id → hard error (defensive) ──
  if (!STYLE_OPTIONS.some((s) => s.id === input.styleId)) {
    issues.push({
      field: 'style',
      severity: 'error',
      message: `Unknown style "${input.styleId}".`
    })
  }

  // ── Custom composition selected but left blank → hard error ──
  if (input.compositionId === 'custom' && !(input.customComposition ?? '').trim()) {
    issues.push({
      field: 'customComposition',
      severity: 'error',
      message: 'Custom composition is selected — describe the framing you want (e.g. "over-the-shoulder shot").'
    })
  }

  // ── Unknown lighting/quality ids → hard error (defensive) ──
  const knownLighting = new Set(LIGHTING_OPTIONS.map((l) => l.id))
  for (const id of input.lightingIds ?? []) {
    if (!knownLighting.has(id)) {
      issues.push({ field: 'lighting', severity: 'error', message: `Unknown lighting option "${id}".` })
    }
  }

  // ── Conflicting requirements → warnings ──
  const lightingIds = new Set(input.lightingIds ?? [])
  for (const conflict of STYLE_LIGHTING_CONFLICTS) {
    if (input.styleId === conflict.styleId && lightingIds.has(conflict.lightingId)) {
      issues.push({ field: 'options', severity: 'warning', message: conflict.message })
    }
  }
  for (const conflict of LIGHTING_LIGHTING_CONFLICTS) {
    if (lightingIds.has(conflict.a) && lightingIds.has(conflict.b)) {
      issues.push({ field: 'options', severity: 'warning', message: conflict.message })
    }
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues
  }
}

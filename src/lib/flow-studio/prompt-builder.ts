// ─────────────────────────────────────────────────────────────────────────────
// Flow Prompt Studio — deterministic Flow-ready prompt assembly
//
// Converts the LLM's structured 11-field JSON + the user's parameters into a
// single paste-ready prompt for Google Flow. This assembly is DETERMINISTIC
// (same structure → same prompt), so the LLM never has the last word on the
// final text — it only organizes; the builder composes.
//
// The assembled prompt ends with the FIDELITY GUARD — an explicit negative
// instruction that enforces the spec's strict prompt-accuracy rule: no extra
// people, objects, text or logos beyond what the user described.
// ─────────────────────────────────────────────────────────────────────────────

import { GenerationRequest, PromptStructure, ASPECT_RATIOS } from './types'

/** Join non-empty fragments with the given separator. */
function join(parts: string[], sep: string): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(sep)
}

/**
 * Build the final Flow-ready prompt.
 *
 * Layout (deliberately simple — Flow prompts work best as clear prose):
 *
 *   Line 1:  Subject (+ details) — what the image is OF.
 *   Line 2:  Environment + background — where it lives.
 *   Line 3:  Composition + camera — how it is framed.
 *   Line 4:  Lighting + mood.
 *   Line 5:  Style + quality.
 *   Line 6:  Aspect ratio.
 *   Line 7:  User constraints (if any).
 *   Line 8:  Fidelity guard (negative instruction).
 */
export function buildFlowPrompt(
  structure: PromptStructure,
  params: { aspectRatio: string; request: GenerationRequest }
): string {
  const s = structure

  const subjectLine = join([s.subject, s.subject_details], ', ')
  const sceneLine = join([s.environment, s.background], ', ')
  const framingLine = join([s.composition, s.camera], ', ')
  const lightLine = join([s.lighting, s.mood], ', ')
  const styleLine = join([s.style, s.quality], ', ')

  const aspect = ASPECT_RATIOS.find((a) => a.id === params.aspectRatio)
  const aspectLine = aspect?.supported && aspect.promptText ? `Aspect ratio: ${aspect.promptText}.` : ''

  const paragraphs = [
    subjectLine ? `${subjectLine}.` : '',
    sceneLine ? `${sceneLine}.` : '',
    framingLine ? `${framingLine}.` : '',
    lightLine ? `${lightLine}.` : '',
    styleLine ? `${styleLine}.` : '',
    aspectLine,
    s.constraints ? `${s.constraints}.` : ''
  ].filter(Boolean)

  // ── Fidelity guard ──
  // Enforces the spec's strict accuracy rule at generation time. Worded so it
  // never contradicts a scene that legitimately includes people/objects the
  // user DID describe (the guard only forbids ADDITIONS, not the described).
  const guard =
    'Keep the described subject as the main focus. Do not add extra people, objects, text, logos or watermarks beyond what is described above.'

  return [...paragraphs, guard].join('\n\n')
}

/**
 * Quick heuristic for fidelity, used as a server-side sanity check on the
 * LLM's self-reported fidelity value. If the LLM claims "preserved" but the
 * structure is mostly empty (nothing to preserve), downgrade to "structured".
 */
export function saneFidelity(claimed: string, structure: PromptStructure): 'preserved' | 'structured' | 'enhanced' {
  const filled = Object.values(structure).filter((v) => (v ?? '').trim().length > 0).length
  if (claimed === 'preserved' && filled < 3) return 'structured'
  if (claimed === 'enhanced' || claimed === 'structured' || claimed === 'preserved') {
    return claimed
  }
  return 'structured'
}

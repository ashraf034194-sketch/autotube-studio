import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { callLLM, friendlyLLMError } from '@/lib/llm-wrapper'
import {
  GenerationRequest,
  PromptAnalysis,
  PromptStructure,
  STRUCTURE_FIELDS,
  STYLE_OPTIONS,
  COMPOSITION_OPTIONS,
  LIGHTING_OPTIONS,
  QUALITY_OPTIONS
} from '@/lib/flow-studio/types'
import { validateGenerationRequest } from '@/lib/flow-studio/validation'
import { buildFlowPrompt, saneFidelity } from '@/lib/flow-studio/prompt-builder'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/flow-prompt — Prompt Analyzer + Prompt Structurer (server modules)
//
// This endpoint implements the INTELLIGENT PROMPT PROCESSING stage of the
// Google Flow automation:
//
//   1. Validation Engine  — server-side re-validation (never trust the client)
//   2. Prompt Analyzer    — LLM understands the request: subject, style,
//                           composition, lighting, constraints, conflicts
//   3. Prompt Structurer  — converts the raw request into the 11-field schema
//   4. Prompt Builder     — deterministic assembly of the Flow-ready prompt
//
// The LLM call uses the project's bundled AI provider (z-ai-web-dev-sdk via
// the shared 3-tier wrapper). NO user-configured API key is involved — and
// critically, NO Gemini/Google key: the actual IMAGE GENERATION happens in
// the user's own Google Flow session, not here.
//
// ABSOLUTE FIDELITY: the system prompt below hard-forbids inventing details.
// The user's own words are preserved; the LLM only ORGANIZES them.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Prompt Analyzer & Structurer module of Flow Prompt Studio — a prompt-engineering console that prepares image-generation instructions for Google Flow (Google Labs' AI filmmaking tool).

Your ONLY job: convert the user's raw request into a structured JSON object. You do NOT generate images. You do NOT converse.

OUTPUT CONTRACT — respond with STRICT JSON only (no markdown fences, no commentary, no text before or after the JSON):
{
  "structure": {
    "subject": "",
    "subject_details": "",
    "environment": "",
    "background": "",
    "composition": "",
    "camera": "",
    "lighting": "",
    "mood": "",
    "style": "",
    "quality": "",
    "constraints": ""
  },
  "fidelity": "preserved | structured | enhanced",
  "conflicts": [],
  "warnings": [],
  "notes": ""
}

FIELD MEANINGS:
- subject: the single main thing the image is of (in the user's words).
- subject_details: attributes of the subject the user stated (color, material, action, condition).
- environment: where the scene takes place (the user's setting).
- background: what is behind the subject, if the user said.
- composition: how the frame is arranged (shot type, subject placement).
- camera: camera angle/perspective the user described.
- lighting: light sources/qualities the user described.
- mood: emotional tone the user conveyed.
- style: visual style the user requested.
- quality: quality descriptors the user requested.
- constraints: things the user explicitly required or forbade.

ABSOLUTE FIDELITY RULES — violating these is a FAILURE:
1. PRESERVE INTENT. If the user's request is already detailed and clear, DO NOT rewrite it — ORGANIZE it. Reuse the user's own words inside the fields wherever they fit. Do not paraphrase for style; paraphrase only to place text into the right field.
2. NEVER INVENT. Do not add people, animals, objects, products, brands, logos, text, watermarks, clothing, celebrities, materials, colors, locations, weather, or time of day that the user did not mention. If the user wrote "luxury watch", you must NOT assume gold, Rolex, a celebrity wrist, or a city skyline — only what was stated.
3. NEVER DROP. Every meaningful word the user wrote must survive into some field. Descriptive adjectives that don't clearly belong to one field (e.g. "cinematic", "vintage", "surreal", "gritty") go in subject_details, mood or style — NEVER discarded. Dropping a user word is as bad as inventing one.
4. ONLY USE GIVEN INFORMATION. Fill each field exclusively from (a) the RAW REQUEST text, and (b) the SELECTED PARAMETERS block (the user chose those, so they ARE requested). If a field has no information, leave it as "" (empty string). Empty is CORRECT; guessing is WRONG.
5. CONFLICTS. If the raw request contradicts itself or contradicts a selected parameter, keep the user's WORDS in the fields (do not silently resolve), and describe the contradiction briefly in "conflicts".
6. VAGUE REQUESTS. Only when the request is too vague to fill subject + at least one other field, you may add GENERIC framing language (nothing specific): e.g. subject becomes the user's noun, composition may get "subject as the clear main focus" — and you set fidelity to "enhanced". Never add concrete nouns, brands, or named places this way. Detail-rich or moderately detailed requests use "preserved" or "structured".
7. notes: ONE short sentence (max ~25 words) describing what you did — e.g. "Detailed prompt — organized into fields without rewording." Leave "" if nothing notable.
8. warnings: short strings for anything the user should know (e.g. request mentions text-in-image, which image models render unreliably). Not for conflicts.

Return the JSON now.`

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the user's selections into readable text for the LLM prompt. */
function describeSelections(req: GenerationRequest): string {
  const style =
    req.styleId === 'custom'
      ? `Custom style (user's own words): ${req.customStyle.trim()}`
      : STYLE_OPTIONS.find((s) => s.id === req.styleId)?.label ?? 'none'
  const composition =
    req.compositionId === 'custom'
      ? `Custom composition (user's own words): ${req.customComposition.trim()}`
      : COMPOSITION_OPTIONS.find((c) => c.id === req.compositionId)?.label ?? 'none'
  const lighting = req.lightingIds
    .map((id) => LIGHTING_OPTIONS.find((l) => l.id === id)?.label ?? id)
    .join(', ')
  const quality = req.qualityIds
    .map((id) => QUALITY_OPTIONS.find((q) => q.id === id)?.label ?? id)
    .join(', ')

  return [
    `- Style: ${style || 'none'}`,
    `- Aspect ratio: ${req.aspectRatio}`,
    `- Composition: ${composition || 'none'}`,
    `- Lighting: ${lighting || 'none'}`,
    `- Quality: ${quality || 'none'}`
  ].join('\n')
}

/**
 * Extract + parse the JSON object from an LLM response.
 * Tolerates code fences and stray prose around the object, then validates
 * every field of the 11-field schema (unknown fields dropped, non-strings
 * coerced, lengths clamped).
 */
function parseStructureResponse(raw: string): {
  structure: PromptStructure
  fidelity: string
  conflicts: string[]
  warnings: string[]
  notes: string
} {
  let text = raw.trim()

  // Strip a whole-response code fence first.
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  if (fence) text = fence[1].trim()

  // Grab the outermost { … } block.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('The AI response did not contain a JSON object.')
  }
  const jsonText = text.slice(start, end + 1)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('The AI response contained malformed JSON.')
  }

  // ── Normalize structure (all 11 fields, string-typed, clamped) ──
  const rawStructure = (parsed.structure ?? {}) as Record<string, unknown>
  const structure = {} as PromptStructure
  for (const field of STRUCTURE_FIELDS) {
    const value = rawStructure[field]
    if (typeof value === 'string') {
      structure[field] = value.trim().slice(0, 600)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      structure[field] = String(value)
    } else {
      structure[field] = ''
    }
  }

  const toList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 300)).filter(Boolean).slice(0, 6)
      : []

  const fidelityRaw = typeof parsed.fidelity === 'string' ? parsed.fidelity : ''

  return {
    structure,
    fidelity: fidelityRaw,
    conflicts: toList(parsed.conflicts),
    warnings: toList(parsed.warnings),
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim().slice(0, 200) : ''
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── 1. Parse body ──
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request: the request body must be valid JSON.' },
        { status: 400 }
      )
    }

    const b = (body ?? {}) as Partial<GenerationRequest>
    const request: GenerationRequest = {
      prompt: typeof b.prompt === 'string' ? b.prompt : '',
      styleId: typeof b.styleId === 'string' ? b.styleId : 'none',
      customStyle: typeof b.customStyle === 'string' ? b.customStyle : '',
      aspectRatio: typeof b.aspectRatio === 'string' ? b.aspectRatio : '16:9',
      compositionId: typeof b.compositionId === 'string' ? b.compositionId : 'none',
      customComposition: typeof b.customComposition === 'string' ? b.customComposition : '',
      lightingIds: Array.isArray(b.lightingIds) ? b.lightingIds.filter((x): x is string => typeof x === 'string') : [],
      qualityIds: Array.isArray(b.qualityIds) ? b.qualityIds.filter((x): x is string => typeof x === 'string') : []
    }

    // ── 2. Validation Engine (server-side truth) ──
    const validation = validateGenerationRequest(request)
    if (!validation.ok) {
      const first = validation.issues.find((i) => i.severity === 'error')
      return NextResponse.json(
        {
          success: false,
          error: first?.message ?? 'The request did not pass validation.',
          issues: validation.issues
        },
        { status: 400 }
      )
    }

    const warningsFromValidation = validation.issues
      .filter((i) => i.severity === 'warning')
      .map((i) => i.message)

    // ── 3. Prompt Analyzer + Structurer (single LLM call) ──
    const userContent = `RAW REQUEST:\n${request.prompt.trim()}\n\nSELECTED PARAMETERS (the user chose these — treat them as requested):\n${describeSelections(request)}\n\nAnalyze and structure this request into the JSON now.`

    const result = await callLLM(
      { systemPrompt: SYSTEM_PROMPT, userContent },
      {
        tag: 'flow-prompt',
        zaiMaxAttempts: 3,
        cloudflareMaxAttempts: 3,
        groqMaxAttempts: 2,
        maxTokens: 1200,
        temperature: 0.3 // Low temperature: structuring must be deterministic, not creative.
      }
    )

    // ── 4. Parse + sanity-check the structured response ──
    const parsed = parseStructureResponse(result.text)

    // The subject is the one field that must exist — everything else may be "".
    if (!parsed.structure.subject.trim()) {
      return NextResponse.json(
        {
          success: false,
          error:
            'The prompt analysis could not identify a main subject. Please describe the main subject you want to generate.'
        },
        { status: 422 }
      )
    }

    const analysis: PromptAnalysis = {
      structure: parsed.structure,
      fidelity: saneFidelity(parsed.fidelity, parsed.structure),
      conflicts: parsed.conflicts,
      warnings: [...parsed.warnings, ...warningsFromValidation],
      notes: parsed.notes
    }

    // ── 5. Deterministic Flow-ready prompt assembly ──
    const flowPrompt = buildFlowPrompt(parsed.structure, {
      aspectRatio: request.aspectRatio,
      request
    })

    if (!flowPrompt.trim()) {
      return NextResponse.json(
        { success: false, error: 'Prompt assembly produced an empty instruction — please rephrase your request.' },
        { status: 422 }
      )
    }

    const requestId = randomUUID()
    console.log(
      `[flow-prompt] ${requestId}: analyzed "${request.prompt.trim().slice(0, 60)}…" → fidelity=${analysis.fidelity}, provider=${result.provider}, flowPrompt ${flowPrompt.length} chars`
    )

    return NextResponse.json({
      success: true,
      data: {
        requestId,
        structure: parsed.structure,
        analysis,
        flowPrompt,
        warnings: analysis.warnings
      }
    })
  } catch (error) {
    console.error('[flow-prompt] Unexpected error:', error)
    return NextResponse.json(
      { success: false, error: friendlyLLMError(error) },
      { status: 502 }
    )
  }
}

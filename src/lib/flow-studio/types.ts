// ─────────────────────────────────────────────────────────────────────────────
// Flow Prompt Studio — shared types + option catalogs
//
// This is the "tool logic" layer of the Google Flow image-generation
// automation. It is shared between the client (validation before submit,
// duplicate-protection state machine) and the server (/api/flow-prompt —
// Prompt Analyzer + Prompt Structurer modules).
//
// ARCHITECTURE NOTE (honest capability boundary):
//   Google Flow (labs.google/fx/tools/flow) has NO official public API and NO
//   extension/plugin system. The only compliant way to drive generation is
//   through the authenticated Flow web UI itself. Therefore this tool
//   implements everything around the generation:
//     • intelligent prompt analysis + structuring  (LLM, bundled — no user key)
//     • validation engine                          (this file + validation.ts)
//     • Flow-ready prompt assembly                 (prompt-builder.ts)
//     • generation state machine + result attestation (client page)
//   ...and hands the final prompt to the user's own Google Flow session via
//   copy + open. The tool NEVER stores Google credentials, never automates
//   the browser, and never touches Flow's credits/quotas — generation usage
//   is governed by the user's authenticated Flow account.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Generation state machine ────────────────────────────────────────────────

/**
 * The 9 generation states from the tool spec. The UI must accurately reflect
 * the REAL state — COMPLETED is only ever set after the user attests that a
 * valid result exists in their Google Flow project.
 */
export type FlowState =
  | 'IDLE'
  | 'VALIDATING'
  | 'ANALYZING_PROMPT'
  | 'PREPARING_GENERATION'
  | 'REQUIRES_USER_ACTION'
  | 'GENERATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'LIMIT_REACHED'

/** States in which a NEW generation request may be started (duplicate-protection). */
export const STARTABLE_STATES: FlowState[] = [
  'IDLE',
  'COMPLETED',
  'FAILED',
  'LIMIT_REACHED'
]

/** States that mean a request is in-flight (Generate button must be disabled). */
export const BUSY_STATES: FlowState[] = [
  'VALIDATING',
  'ANALYZING_PROMPT',
  'PREPARING_GENERATION',
  'REQUIRES_USER_ACTION',
  'GENERATING'
]

/** User-facing status message for each state (exact wording from the spec). */
export const STATE_MESSAGES: Record<FlowState, string> = {
  IDLE: 'Ready. Describe your image and press Generate.',
  VALIDATING: 'Validating your input…',
  ANALYZING_PROMPT: 'Analyzing your prompt…',
  PREPARING_GENERATION: 'Preparing your image instructions…',
  REQUIRES_USER_ACTION:
    'Your structured prompt is ready. Copy it into Google Flow and start the generation.',
  GENERATING: 'Starting image generation… your image is being generated in Google Flow…',
  COMPLETED: 'Image generated successfully.',
  FAILED: 'The generation did not complete successfully.',
  LIMIT_REACHED:
    'Generation is limited by your current Google Flow account access/quota. This is a platform limitation, not a problem with your prompt.'
}

// ─── Option catalogs (only natively-supported capabilities are enabled) ───────

export interface OptionDef {
  id: string
  label: string
  /** Prompt language injected for this option (only when selected by the user). */
  promptText: string
}

export interface AspectOption extends OptionDef {
  /**
   * Whether Google Flow's native image modes actually support this ratio.
   * Imagen (Flow's image model) supports 1:1, 16:9, 9:16. 4:5 and 3:2 are NOT
   * natively supported → shown but disabled with an honest explanation, per
   * the spec: "Only show or apply options actually supported by the native
   * generation capability."
   */
  supported: boolean
  note: string
}

export const ASPECT_RATIOS: AspectOption[] = [
  {
    id: '1:1',
    label: '1:1',
    promptText: 'square 1:1 aspect ratio',
    supported: true,
    note: 'Supported by Google Flow image generation.'
  },
  {
    id: '16:9',
    label: '16:9',
    promptText: 'widescreen 16:9 aspect ratio',
    supported: true,
    note: 'Supported by Google Flow (default landscape).'
  },
  {
    id: '9:16',
    label: '9:16',
    promptText: 'vertical 9:16 aspect ratio',
    supported: true,
    note: 'Supported by Google Flow (portrait / Shorts-style).'
  },
  {
    id: '4:5',
    label: '4:5',
    promptText: '',
    supported: false,
    note: 'Not natively supported by Google Flow image modes — choose 1:1, 16:9 or 9:16.'
  },
  {
    id: '3:2',
    label: '3:2',
    promptText: '',
    supported: false,
    note: 'Not natively supported by Google Flow image modes — choose 1:1, 16:9 or 9:16.'
  }
]

export const STYLE_OPTIONS: OptionDef[] = [
  { id: 'none', label: 'No preference', promptText: '' },
  { id: 'photorealistic', label: 'Photorealistic', promptText: 'photorealistic style' },
  { id: 'cinematic', label: 'Cinematic', promptText: 'cinematic style' },
  { id: 'commercial', label: 'Commercial advertisement', promptText: 'premium commercial-advertisement style' },
  { id: 'product', label: 'Product photography', promptText: 'professional product-photography style' },
  { id: 'editorial', label: 'Editorial', promptText: 'editorial style' },
  { id: '3d-render', label: '3D render', promptText: 'polished 3D-render style' },
  { id: 'illustration', label: 'Illustration', promptText: 'illustration style' },
  { id: 'minimal', label: 'Minimal', promptText: 'minimal, clean style' },
  { id: 'luxury', label: 'Luxury', promptText: 'luxury style' },
  { id: 'custom', label: 'Custom style…', promptText: '' }
]

export const COMPOSITION_OPTIONS: OptionDef[] = [
  { id: 'none', label: 'No preference', promptText: '' },
  { id: 'close-up', label: 'Close-up', promptText: 'close-up shot' },
  { id: 'medium-shot', label: 'Medium shot', promptText: 'medium shot' },
  { id: 'wide-shot', label: 'Wide shot', promptText: 'wide shot' },
  { id: 'top-down', label: 'Top-down', promptText: 'top-down flat-lay angle' },
  { id: 'eye-level', label: 'Eye level', promptText: 'eye-level angle' },
  { id: 'low-angle', label: 'Low angle', promptText: 'low angle' },
  { id: 'product-centered', label: 'Product centered', promptText: 'subject centered in frame' },
  { id: 'rule-of-thirds', label: 'Rule of thirds', promptText: 'rule-of-thirds composition' },
  { id: 'custom', label: 'Custom composition…', promptText: '' }
]

export const LIGHTING_OPTIONS: OptionDef[] = [
  { id: 'natural', label: 'Natural light', promptText: 'natural light' },
  { id: 'studio', label: 'Studio lighting', promptText: 'clean studio lighting' },
  { id: 'soft', label: 'Soft light', promptText: 'soft diffused light' },
  { id: 'dramatic', label: 'Dramatic lighting', promptText: 'dramatic lighting' },
  { id: 'cinematic-light', label: 'Cinematic lighting', promptText: 'cinematic lighting' },
  { id: 'golden-hour', label: 'Golden hour', promptText: 'golden-hour light' },
  { id: 'neon', label: 'Neon', promptText: 'neon light' },
  { id: 'high-contrast', label: 'High contrast', promptText: 'high-contrast lighting' }
]

export const QUALITY_OPTIONS: OptionDef[] = [
  { id: 'high-detail', label: 'High detail', promptText: 'high detail' },
  { id: 'commercial-quality', label: 'Commercial quality', promptText: 'commercial quality' },
  { id: 'cinematic-quality', label: 'Cinematic', promptText: 'cinematic look' },
  { id: 'realistic-textures', label: 'Realistic textures', promptText: 'realistic textures' },
  { id: 'sharp-focus', label: 'Sharp focus', promptText: 'sharp focus' }
]

// ─── Prompt structure (the 11-field internal schema from the spec) ────────────

export interface PromptStructure {
  subject: string
  subject_details: string
  environment: string
  background: string
  composition: string
  camera: string
  lighting: string
  mood: string
  style: string
  quality: string
  constraints: string
}

/** All fields of the structure, in canonical order. */
export const STRUCTURE_FIELDS: (keyof PromptStructure)[] = [
  'subject',
  'subject_details',
  'environment',
  'background',
  'composition',
  'camera',
  'lighting',
  'mood',
  'style',
  'quality',
  'constraints'
]

/** Human label for each structure field (shown in the JSON viewer). */
export const STRUCTURE_LABELS: Record<keyof PromptStructure, string> = {
  subject: 'Main subject',
  subject_details: 'Subject details',
  environment: 'Environment',
  background: 'Background',
  composition: 'Composition',
  camera: 'Camera perspective',
  lighting: 'Lighting',
  mood: 'Mood',
  style: 'Style',
  quality: 'Quality requirements',
  constraints: 'Constraints'
}

export function emptyPromptStructure(): PromptStructure {
  return {
    subject: '',
    subject_details: '',
    environment: '',
    background: '',
    composition: '',
    camera: '',
    lighting: '',
    mood: '',
    style: '',
    quality: '',
    constraints: ''
  }
}

// ─── Analysis metadata ────────────────────────────────────────────────────────

/**
 * How faithfully the structured prompt tracks the user's original words.
 *   • preserved  — the prompt was already detailed; we organized, not rewrote.
 *   • structured — moderate detail; organized + clarified wording.
 *   • enhanced   — vague prompt; generic structure added (never invented
 *                  subjects/objects/brands — only framing language).
 */
export type PromptFidelity = 'preserved' | 'structured' | 'enhanced'

export interface PromptAnalysis {
  structure: PromptStructure
  fidelity: PromptFidelity
  conflicts: string[]
  warnings: string[]
  notes: string
}

// ─── Request / response contracts ─────────────────────────────────────────────

export interface GenerationRequest {
  prompt: string
  styleId: string
  customStyle: string
  aspectRatio: string
  compositionId: string
  customComposition: string
  lightingIds: string[]
  qualityIds: string[]
}

export interface ValidationIssue {
  field: string
  severity: 'error' | 'warning'
  message: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

export interface FlowPromptData {
  requestId: string
  structure: PromptStructure
  analysis: PromptAnalysis
  /** The final, paste-ready prompt for Google Flow. */
  flowPrompt: string
  /** Warnings from client-side validation, echoed for transparency. */
  warnings: string[]
}

// ─── History (session log, persisted to localStorage) ─────────────────────────

export interface HistoryEntry {
  requestId: string
  createdAt: number
  promptExcerpt: string
  styleLabel: string
  aspectRatio: string
  finalState: FlowState
  /** Epoch-ms when the terminal state was reached. */
  resolvedAt?: number
}

export const HISTORY_STORAGE_KEY = 'flow-prompt-studio:history'
export const HISTORY_MAX_ENTRIES = 25

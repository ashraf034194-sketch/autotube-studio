// ── AutoTube Autopilot — shared types ─────────────────────────────────────────
//
// The Autopilot pipeline (Flow-only image mode):
//   user script → rewrite → voiceover → Flow-Studio image prompts →
//   [PAUSE: user generates images in Google Flow and uploads them] →
//   video assembly → finished MP4
//
// Google Flow (https://labs.google/fx/tools/flow) has NO public API, so the
// image stage is a compliant handoff: the autopilot writes every prompt,
// the user generates the images in Flow with their own account, then
// batch-uploads them here. Video assembly then resumes automatically.
// The previous automatic image providers (Pexels / Unsplash / Z.ai) were
// REMOVED at the user's request — Flow is now the only image source.

/** The five pipeline stages, in execution order. */
export type AutopilotStageKey = 'rewrite' | 'voiceover' | 'prompts' | 'images' | 'video'

export interface AutopilotStage {
  key: AutopilotStageKey
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  /** One-line live status for the UI (e.g. "Synthesizing chunk 12/34"). */
  detail: string | null
  /** 0-100 where meaningful (null = indeterminate). */
  progress: number | null
  startedAt?: number
  doneAt?: number
}

export type MusicChoice = 'none' | 'calm' | 'ambient' | 'upbeat'
export type ResolutionChoice = '1080p' | '4k'

/** User-facing production settings for one autopilot run. */
export interface AutopilotSettings {
  /** Edge-TTS neural voice id (validated by /api/voiceover). */
  voice: string
  /** Narration speed multiplier. */
  speed: number
  /** Visual direction — Flow Prompt Studio style catalog id. */
  visualStyle: string
  /** Free-text style when visualStyle === 'custom'. */
  customStyle: string
  /** Lighting catalog id (Flow Prompt Studio LIGHTING_OPTIONS). */
  lighting: string
  /** Composition catalog id (Flow Prompt Studio COMPOSITION_OPTIONS). */
  composition: string
  /** Free-text composition when composition === 'custom'. */
  customComposition: string
  /** Background music track. */
  music: MusicChoice
  /** Output resolution. */
  resolution: ResolutionChoice
  /** Burn-in captions. */
  captions: boolean
  /** Smart cross-fade transitions. */
  transitions: boolean
  /** LLM title card at the start. */
  titleCard: boolean
  /** Key-moment text highlights. */
  highlights: boolean
  /** Outro end card. */
  outro: boolean
}

// ── Live sub-states surfaced from the underlying jobs ────────────────────────

export interface VoiceoverLive {
  status: 'processing' | 'done' | 'error'
  completedChunks: number
  totalChunks: number
  currentLabel: string | null
  error?: string
  // present when done:
  durationSeconds?: number
  chunkCount?: number
  sizeBytes?: number
}

export interface ImageSlotLive {
  index: number
  status: 'pending' | 'done' | 'error'
  /** The narration chunk this slot's image visualizes (Flow handoff proof). */
  chunkText?: string
  error?: string
}

export interface ImagesLive {
  jobId: string | null
  /** 'awaiting' = prompts written, waiting for the user's Google Flow uploads. */
  status: 'idle' | 'styling' | 'prompting' | 'awaiting' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  progress: number
  currentLabel: string | null
  promptBatchesTotal: number | null
  promptBatchesDone: number | null
  /** The Flow-Prompt-Studio-derived Style DNA steering every image. */
  styleDna: string | null
  slots: ImageSlotLive[]
  /** Full prompt list — present once prompts are ready (Flow handoff UI). */
  prompts?: string[]
  error?: string
}

export interface VideoLive {
  jobId: string | null
  status: 'idle' | 'processing' | 'done' | 'error'
  stage: string | null
  progress: number
  etaSeconds?: number
  error?: string
  // present when done:
  videoDuration?: number
  fileSize?: number
  videoWidth?: number
  videoHeight?: number
  titleCardText?: string
  outroCtaText?: string
}

// ── Artifacts kept on the job for the final report ───────────────────────────

export interface AutopilotArtifacts {
  originalWordCount?: number
  rewrittenScript?: string
  rewrittenWordCount?: number
  vocabularyOverlap?: number
  voiceover?: {
    voice: string
    speed: number
    durationSeconds: number
    chunkCount: number
    sizeBytes: number
  }
  imageJobId?: string
  imageCount?: number
  imageFailed?: number
  styleDna?: string
  promptsSample?: string[]
  video?: {
    jobId: string
    fileUrl: string
    downloadUrl: string
    videoDuration?: number
    fileSize?: number
    videoWidth?: number
    videoHeight?: number
    titleCardText?: string
    outroCtaText?: string
    featuresApplied: string[]
  }
}

export interface AutopilotJob {
  id: string
  /** 'awaiting_images' = paused at the Flow handoff (uploads pending). */
  status: 'running' | 'awaiting_images' | 'completed' | 'failed'
  createdAt: number
  doneAt?: number
  settings: AutopilotSettings
  stages: AutopilotStage[]
  live: {
    voiceover: VoiceoverLive
    images: ImagesLive
    video: VideoLive
  }
  artifacts: AutopilotArtifacts
  failedStage?: AutopilotStageKey
  error?: string
}

/** What GET /api/autopilot?id= returns (JSON-safe, lean). */
export interface AutopilotSnapshot {
  id: string
  status: AutopilotJob['status']
  createdAt: number
  doneAt?: number
  settings: AutopilotSettings
  stages: AutopilotStage[]
  live: AutopilotJob['live']
  artifacts: AutopilotArtifacts
  failedStage?: AutopilotStageKey
  error?: string
}

export const STAGE_LABELS: Record<AutopilotStageKey, string> = {
  rewrite: 'Rewriting script',
  voiceover: 'Generating voiceover',
  prompts: 'Flow Studio · writing image prompts',
  images: 'Google Flow · image handoff',
  video: 'Assembling final video'
}

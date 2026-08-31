import { callLLM as callLLMWrapper } from '@/lib/llm-wrapper'

// ─── Phase 6 PART 2 — LLM helpers for Title Card + Text Highlights ────────────
//
// These are called from the /api/video POST handler BEFORE the FFmpeg assembly
// kicks off. They use the shared LLM wrapper (src/lib/llm-wrapper.ts):
//   - TIER 1: Z.ai primary path (direct fetch + rate-limit header parsing)
//   - TIER 2: Cloudflare Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
//   - TIER 3: Groq (OpenAI-compatible, llama-3.3-70b-versatile default)
//   - SMART RETRY-QUEUE: when all 3 tiers fail, exponential backoff (15s →
//     30s → 60s → 2min × 3, max 6 rounds ≈ 8min) re-runs the whole chain
//     so transient simultaneous overloads of all 3 providers are absorbed
//     without surfacing an error to the user.
//
// All helpers FAIL SOFT: if all 3 tiers + the retry-queue are exhausted
// (genuinely catastrophic failure), they return null and the caller falls
// back to "no title card" / "no highlights" / fallback CTA — the video
// still builds successfully without the optional feature.

const TITLE_MAX_WORDS = 9
const TITLE_MIN_WORDS = 3
const HIGHLIGHT_MAX_PER_VIDEO = 5
const HIGHLIGHT_MAX_CHARS = 32

type ZaiClient = never // legacy alias kept for type-compat; wrapper has no client.

/**
 * One LLM call via the shared wrapper. Returns the raw completion string.
 * Z.ai is tried first; on quota-exhaustion OR persistent 429, falls back to
 * Cloudflare → Groq transparently. If all 3 tiers fail, the wrapper's smart
 * retry-queue kicks in (exponential backoff 15s → 30s → 60s → 2min × 3,
 * max 6 rounds ≈ 8min) so transient simultaneous overloads are absorbed
 * without surfacing an error to the user. Only after the retry-queue is
 * fully exhausted does this helper throw — and the caller's fail-soft
 * catch converts that to a `null` return.
 */
async function callLLM(
  systemPrompt: string,
  userContent: string,
  tag: string,
  maxAttempts = 3
): Promise<string> {
  const result = await callLLMWrapper(
    { systemPrompt, userContent },
    {
      tag,
      zaiMaxAttempts: maxAttempts,
      cloudflareMaxAttempts: 3,
      groqMaxAttempts: 2,
      maxTokens: 600,
      temperature: 0.7
      // No onWait callback here — these are fail-soft video-build helpers
      // called from /api/video's POST handler. The video job's existing
      // polling UI surfaces "video still building" status, and the helpers
      // tolerate the retry-queue's wait time (8min worst-case) without
      // needing a per-helper countdown in the UI. The Script Rewrite flow
      // (the user-facing text LLM feature) DOES wire onWait through to the
      // job's waiting state — see /api/rewrite/route.ts.
    }
  )
  if (result.fellBackToCloudflare) {
    console.log(
      `[video-llm:${tag}] used Cloudflare fallback (zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}).`
    )
  } else if (result.fellBackToGroq) {
    console.log(
      `[video-llm:${tag}] used Groq fallback (zaiAttempts=${result.zaiAttempts}, cfAttempts=${result.cloudflareAttempts}, groqAttempts=${result.groqAttempts}).`
    )
  }
  if (result.usedRetryQueue) {
    console.log(
      `[video-llm:${tag}] succeeded after retry-queue (rounds=${result.retryQueueRounds}, provider=${result.provider}).`
    )
  }
  return result.text
}

// ─── Title card generation ────────────────────────────────────────────────────

const TITLE_SYSTEM_PROMPT = `You are a YouTube title writer. Read the narration script and produce ONE short, catchy video title that captures the central idea.

ABSOLUTE RULES:
1. LENGTH: 3-9 words. Not a sentence — a punchy title (Title Case, no trailing period).
2. STYLE: Evocative + specific. Concrete nouns + power verbs. No clickbait ALL-CAPS, no exclamation marks.
3. CONTENT: Mirror the script's actual theme. Do NOT invent facts, names, or numbers that aren't in the script.
4. FORMAT: Output ONLY the title text. No quotes, no prefix like "Title:", no markdown, no commentary.

GOOD EXAMPLES:
  The Power of Small Habits
  Why Your Brain Sabotages Good Decisions
  The One Percent Rule
  How Focus Rewires Your Mind

A lazy generic title like "Motivation Video" or "Interesting Ideas" is a FAILURE.`

/**
 * Read the rewritten narration script and produce a short, punchy video title
 * for the title card. Returns null on failure (fail-soft — caller skips the
 * title card rather than failing the whole video build).
 */
export async function generateTitleCard(script: string): Promise<string | null> {
  const trimmed = (script || '').trim()
  if (trimmed.length < 20) return null

  try {
    const userContent = `Read the following narration script and write ONE short, catchy title (3-9 words, Title Case, no trailing period) that captures the central idea.\n\n---SCRIPT START---\n${trimmed}\n---SCRIPT END---`
    const raw = await callLLM(TITLE_SYSTEM_PROMPT, userContent, 'title-card')

    // Clean the response: strip quotes, code fences, preamble.
    let title = raw.trim()
    const fenceMatch = title.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
    if (fenceMatch) title = fenceMatch[1].trim()
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1).trim()
    }
    // If multi-line, keep only the first non-empty line.
    const firstLine = title.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
    title = firstLine
    // Strip any "Title:" prefix the model might add.
    title = title.replace(/^(title|heading|video title)\s*[:\-]\s*/i, '')

    const words = title.split(/\s+/).filter(Boolean)
    if (words.length < TITLE_MIN_WORDS || words.length > TITLE_MAX_WORDS) {
      // Too short/long — try once more with an explicit length reminder.
      const retry = await callLLM(
        TITLE_SYSTEM_PROMPT,
        `${userContent}\n\nIMPORTANT: Your previous answer was ${words.length} words. The title MUST be between ${TITLE_MIN_WORDS} and ${TITLE_MAX_WORDS} words. Try again.`,
        'title-card-retry'
      )
      let t2 = retry.trim()
      if (
        (t2.startsWith('"') && t2.endsWith('"')) ||
        (t2.startsWith("'") && t2.endsWith("'"))
      ) {
        t2 = t2.slice(1, -1).trim()
      }
      t2 = t2.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
      t2 = t2.replace(/^(title|heading|video title)\s*[:\-]\s*/i, '')
      const w2 = t2.split(/\s+/).filter(Boolean)
      if (w2.length >= TITLE_MIN_WORDS && w2.length <= TITLE_MAX_WORDS) {
        title = t2
      } else {
        // Last resort: truncate to TITLE_MAX_WORDS or pad with the first words.
        if (w2.length > TITLE_MAX_WORDS) {
          title = w2.slice(0, TITLE_MAX_WORDS).join(' ')
        } else {
          title = t2
        }
      }
    }
    return title
  } catch (err) {
    console.error(
      '[video-llm] generateTitleCard failed (fail-soft — skipping title card):',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

// ─── Key-moment highlight extraction ──────────────────────────────────────────

export interface TextHighlight {
  /** 0-based index of the segment (clip) this highlight should overlay. */
  segmentIndex: number
  /** Short punchy text (max ~32 chars, no full sentence). */
  text: string
}

const HIGHLIGHT_SYSTEM_PROMPT = `You are a video editor scanning a narration script to find the 3-5 MOST IMPACTFUL moments worth highlighting as bold on-screen text (CapCut "QUICK" bold-text style).

WHAT TO HIGHLIGHT:
  - Statistics or numbers ("37 times better", "one percent daily", "20 hours")
  - Power statements / punchy conclusions ("focus beats motivation")
  - Memorable quotes or aphorisms
  - Counter-intuitive claims ("failure is practice")

WHAT NOT TO HIGHLIGHT:
  - Routine narration ("first let's look at...", "as we discussed")
  - Anything longer than 4-5 words
  - The same idea twice
  - The very first segment (that's where the title card lives — no overlap)
  - The very last segment (don't compete with the outro)

OUTPUT FORMAT (STRICT JSON):
  Return a JSON array of objects, each with two string fields:
    "segmentIndex" — the 0-based index of the segment the highlight overlays
    "text"         — the short bold text (≤ ${HIGHLIGHT_MAX_CHARS} chars, no quotes, no trailing period)

  Limit: 3-5 entries. Pick the genuinely impactful moments only — fewer is better than more.

  Example output:
  [
    {"segmentIndex":2,"text":"37x better"},
    {"segmentIndex":4,"text":"focus beats motivation"}
  ]

  Output ONLY the JSON array. No prose, no markdown fences, no commentary.`

/**
 * Parse the LLM's response into a list of highlights. Tolerates code fences,
 * surrounding prose, and minor JSON formatting issues. Returns [] on failure.
 */
function parseHighlights(
  raw: string,
  segmentCount: number
): TextHighlight[] {
  let text = raw.trim()
  // Strip code fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  // Find the first '[' and the matching ']' — handles surrounding prose.
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  const jsonText = text.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: TextHighlight[] = []
  const usedTexts = new Set<string>()
  const usedIndices = new Set<number>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const segRaw = (item as { segmentIndex?: unknown }).segmentIndex
    const txt = (item as { text?: unknown }).text
    if (typeof segRaw !== 'number' || !Number.isInteger(segRaw)) continue
    if (typeof txt !== 'string' || !txt.trim()) continue
    const segIdx = segRaw
    // Skip out-of-range segments.
    if (segIdx < 0 || segIdx >= segmentCount) continue
    // Skip the very first + very last segment (avoid title/outro overlap).
    if (segIdx === 0 || segIdx === segmentCount - 1) continue
    // Skip duplicates (same text or same segment).
    const cleanText = txt.trim().slice(0, HIGHLIGHT_MAX_CHARS)
    if (usedTexts.has(cleanText.toLowerCase())) continue
    if (usedIndices.has(segIdx)) continue
    usedTexts.add(cleanText.toLowerCase())
    usedIndices.add(segIdx)
    out.push({ segmentIndex: segIdx, text: cleanText })
    if (out.length >= HIGHLIGHT_MAX_PER_VIDEO) break
  }
  return out
}

/**
 * Scan the rewritten script + the per-clip segments and return at most 5
 * highlights, each anchored to a specific clip index. Returns [] on failure
 * (fail-soft — caller skips highlights rather than failing the video build).
 *
 * The `segmentCount` parameter is the number of per-clip segments the script
 * was split into (typically equal to imageCount). Highlights are clamped to
 * valid indices [1, segmentCount-2] (excludes first + last).
 */
export async function extractKeyHighlights(
  script: string,
  segments: string[],
  segmentCount: number
): Promise<TextHighlight[]> {
  const trimmed = (script || '').trim()
  if (trimmed.length < 20 || !Array.isArray(segments) || segments.length === 0) {
    return []
  }

  try {
    const segList = segments
      .map((s, i) => `[${i}] ${s}`)
      .join('\n')
    const userContent = `Below is a video narration script, pre-split into ${segmentCount} per-clip segments (one per image). Identify the 3-5 MOST IMPACTFUL moments — statistics, power statements, memorable quotes — and return each as a JSON object with the segmentIndex it overlays + a short bold text (≤ ${HIGHLIGHT_MAX_CHARS} chars).

---SCRIPT START---
${trimmed}
---SCRIPT END---

---SEGMENTS (0-based index → text)---
${segList}
---SEGMENTS END---

Return ONLY the JSON array (3-5 entries, never highlight segment 0 or the last segment).`

    const raw = await callLLM(HIGHLIGHT_SYSTEM_PROMPT, userContent, 'highlights')
    const parsed = parseHighlights(raw, segmentCount)

    if (parsed.length === 0) {
      // One retry — sometimes the model wraps the JSON in prose despite the
      // instruction, and a second attempt with a sharper prompt helps.
      const retry = await callLLM(
        HIGHLIGHT_SYSTEM_PROMPT,
        `${userContent}\n\nIMPORTANT: Your previous response could not be parsed as a JSON array. This time, output ONLY a JSON array — no prose, no markdown fences. Example:\n[{"segmentIndex":2,"text":"37x better"}]`,
        'highlights-retry'
      )
      return parseHighlights(retry, segmentCount)
    }
    return parsed
  } catch (err) {
    console.error(
      '[video-llm] extractKeyHighlights failed (fail-soft — skipping highlights):',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}

// ─── Outro CTA generation (Phase 6 P3 — Outro End Card) ──────────────────────
//
// The outro end card is a 3.5s clip appended to the END of the video. It shows
// "Thanks for watching" (line 1, fixed) + a short LLM-generated call-to-action
// (line 2) that ties to the script's topic — e.g. "Subscribe for more 1% habits"
// for a script about the one-percent rule.
//
// This helper FAILS SOFT to a fixed fallback: if the LLM call errors out, the
// caller uses "Subscribe for more" as the CTA line. The outro is still applied
// (the user explicitly enabled it) — only the personalised CTA is lost.

const OUTRO_MAX_WORDS = 8
const OUTRO_MIN_WORDS = 4

const OUTRO_SYSTEM_PROMPT = `You are a YouTube video editor writing the call-to-action text for the END CARD of a video. Read the narration script and produce ONE short, sincere call-to-action line that ties to the video's topic.

ABSOLUTE RULES:
1. LENGTH: 4-8 words. A single line, no trailing period.
2. STYLE: Sincere + inviting. Plain speech, no clickbait, no ALL-CAPS, no exclamation marks.
3. CONTENT: Tie to the script's theme (e.g. "Subscribe for more one-percent habits"). Do NOT invent facts/numbers. Default to a subscribe ask when no clear tie.
4. FORMAT: Output ONLY the CTA text. No quotes, no prefix like "CTA:", no markdown.

GOOD EXAMPLES:
  Subscribe for more one-percent habits
  Start your one-percent habit today
  Follow for more focus tips
  Build the habit, one percent daily

A lazy generic CTA like "Subscribe" or "Like and subscribe" is a FAILURE — it must tie to the script.`

/**
 * Read the rewritten narration script and produce a short, topic-relevant
 * call-to-action line for the outro end card (e.g. "Subscribe for more 1%
 * habits"). Returns null on failure (fail-soft — caller falls back to
 * "Subscribe for more" so the outro is still applied).
 */
export async function generateOutroCta(script: string): Promise<string | null> {
  const trimmed = (script || '').trim()
  if (trimmed.length < 20) return null

  try {
    const userContent = `Read the following narration script and write ONE short, sincere call-to-action line (4-8 words, no trailing period) for the end card that ties to the video's theme.\n\n---SCRIPT START---\n${trimmed}\n---SCRIPT END---`
    const raw = await callLLM(OUTRO_SYSTEM_PROMPT, userContent, 'outro-cta')

    let cta = raw.trim()
    const fenceMatch = cta.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
    if (fenceMatch) cta = fenceMatch[1].trim()
    if (
      (cta.startsWith('"') && cta.endsWith('"')) ||
      (cta.startsWith("'") && cta.endsWith("'"))
    ) {
      cta = cta.slice(1, -1).trim()
    }
    const firstLine = cta.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
    cta = firstLine
    cta = cta.replace(/^(cta|call to action|end card)\s*[:\-]\s*/i, '')

    const words = cta.split(/\s+/).filter(Boolean)
    if (words.length < OUTRO_MIN_WORDS || words.length > OUTRO_MAX_WORDS) {
      const retry = await callLLM(
        OUTRO_SYSTEM_PROMPT,
        `${userContent}\n\nIMPORTANT: Your previous answer was ${words.length} words. The CTA MUST be between ${OUTRO_MIN_WORDS} and ${OUTRO_MAX_WORDS} words. Try again.`,
        'outro-cta-retry'
      )
      let t2 = retry.trim()
      if (
        (t2.startsWith('"') && t2.endsWith('"')) ||
        (t2.startsWith("'") && t2.endsWith("'"))
      ) {
        t2 = t2.slice(1, -1).trim()
      }
      t2 = t2.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
      t2 = t2.replace(/^(cta|call to action|end card)\s*[:\-]\s*/i, '')
      const w2 = t2.split(/\s+/).filter(Boolean)
      if (w2.length >= OUTRO_MIN_WORDS && w2.length <= OUTRO_MAX_WORDS) {
        cta = t2
      } else if (w2.length > OUTRO_MAX_WORDS) {
        cta = w2.slice(0, OUTRO_MAX_WORDS).join(' ')
      } else {
        cta = t2
      }
    }
    return cta
  } catch (err) {
    console.error(
      '[video-llm] generateOutroCta failed (fail-soft — caller uses fallback CTA):',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

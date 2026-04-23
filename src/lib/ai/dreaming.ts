import { invoke } from '@tauri-apps/api/core';
import { generateText } from 'ai';
import { useSettingsStore } from '@/store/settingsStore';
import { useBrandStore } from '@/store/brandStore';
import { modelForConfig } from './providers';
import { formatTaxonomy } from './brand-taxonomy';

/**
 * Phase 6 · Dreaming.
 *
 * Reads yesterday's conversation log + the current MEMORY.md, asks the
 * active model to distill candidate memories worth preserving, and
 * appends each one to the right Brand file. Post-hoc review: the user
 * spots anything they don't like in Settings → Personalization and
 * deletes it there — same shape as ChatGPT / Claude / Gemini memory.
 *
 * The heuristic is intentionally conservative — false positives are
 * worse than false negatives, but since everything is auditable + one
 * click to remove, we no longer gate writes behind a manual accept step.
 */

export type DreamTarget = 'USER' | 'TOOLS' | 'SOUL' | 'MEMORY';

export interface DreamCandidate {
  target: DreamTarget;
  content: string;
  /** Verbatim snippet from the conversation log that justifies this
   *  candidate. Used by the grounded-rehydration check before write:
   *  if the quote isn't present in the log, the candidate is dropped. */
  sourceQuote: string;
  justification?: string;
}

export interface DreamRunResult {
  date: string;
  applied: number;
  skipped: number;
  candidates: DreamCandidate[];
}

/** Trigger a Dreaming run.
 *
 *  - No `date` → distill everything since the last Dreaming run (or the
 *    last 24h, if it's never run). Used by the idle trigger.
 *  - `date` given (YYYY-MM-DD) → distill just that day's log. Used by
 *    the `run_dreaming` tool when a model/user asks to reprocess a
 *    specific day.
 *
 *  Returns a summary of what landed, or null when there's nothing to
 *  distill. */
export async function runDreaming(
  date?: string,
): Promise<DreamRunResult | null> {
  const settings = useSettingsStore.getState();
  const modelConfig = settings.modelConfigs.find(
    (m) => m.id === settings.activeModelId,
  );
  if (!modelConfig) {
    throw new Error(
      'No active model configured; configure one in Settings → Models first.',
    );
  }
  if (!settings.globalSettings.apiKey.trim()) {
    throw new Error('No API key set; add one in Settings → Providers first.');
  }

  const logResp = date
    ? await invoke<{ date: string; content: string }>('read_daily_log', {
        date,
      })
    : await invoke<{ date: string; content: string }>(
        'read_daily_logs_since_last_dreaming',
      );
  const target = date ?? logResp.date;
  if (!logResp.content.trim()) {
    return null;
  }

  const brand = useBrandStore.getState().payload;
  const memoryMd = brand.memory.content;

  const resolved = settings.resolveModelConfig(modelConfig);
  const promptParts = [
    "You are Agora's Dreaming pass. Read the previous day's conversation log and the user's current MEMORY.md. Identify items worth long-term storage, return them as STRICT JSON.",
    '',
    'Three rules:',
    '1. Candidates must be durable — preferences, stable facts, project state that outlives the day. NOT one-off answers, code, or conversational filler.',
    '2. Route each candidate to a target file:',
    formatTaxonomy({ indent: '   ' }),
    '3. Every candidate MUST include a `sourceQuote` — a VERBATIM substring (8-200 chars) copied directly from the Conversation log below. No paraphrasing, no translation, no cross-turn stitching. If you cannot point to a single continuous quote that justifies the candidate, DROP it.',
    '',
    'Return JSON ONLY, matching this shape:',
    '{"candidates": [{"target":"USER|TOOLS|SOUL|MEMORY","content":"...","sourceQuote":"...","justification":"..."}]}',
    '',
    'Current MEMORY.md:',
    memoryMd || '(empty)',
    '',
    'Conversation log:',
    logResp.content,
  ];
  const prompt = promptParts.join('\n');

  const result = await generateText({
    model: modelForConfig(resolved),
    prompt,
    maxOutputTokens: 2000,
  });

  const candidates = parseDream(result.text);
  if (!candidates) {
    throw new Error('Dreaming output was not valid JSON');
  }

  const normalizedLog = normalizeForGround(logResp.content);

  let applied = 0;
  let skipped = 0;
  for (const cand of candidates) {
    if (!isGrounded(cand.sourceQuote, normalizedLog)) {
      skipped += 1;
      console.info('dreaming: skipped candidate (ungrounded)', cand);
      continue;
    }
    try {
      const res = await invoke<{ written: boolean; reason: string | null }>(
        'append_to_memory',
        { file: `${cand.target}.md`, content: cand.content },
      );
      if (res.written) {
        applied += 1;
      } else {
        skipped += 1;
        console.info('dreaming: skipped candidate', cand, res.reason);
      }
    } catch (err) {
      skipped += 1;
      console.warn('dreaming: append_to_memory failed', err);
    }
  }

  await useBrandStore.getState().refresh();
  await invoke('mark_dreaming_ran');

  return { date: target, applied, skipped, candidates };
}

/** Check whether the scheduler thinks Dreaming should auto-run right now. */
export async function shouldRun(): Promise<boolean> {
  try {
    return await invoke<boolean>('dreaming_should_run');
  } catch (err) {
    console.warn('dreaming_should_run failed', err);
    return false;
  }
}

function parseDream(raw: string): DreamCandidate[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates.flatMap((c): DreamCandidate[] => {
      if (!c || typeof c !== 'object') return [];
      const r = c as Record<string, unknown>;
      const target = typeof r.target === 'string' ? r.target.toUpperCase() : '';
      const content = typeof r.content === 'string' ? r.content.trim() : '';
      const sourceQuote =
        typeof r.sourceQuote === 'string' ? r.sourceQuote.trim() : '';
      const just =
        typeof r.justification === 'string' ? r.justification.trim() : '';
      if (!['USER', 'TOOLS', 'SOUL', 'MEMORY'].includes(target)) return [];
      if (!content) return [];
      if (!sourceQuote) return [];
      return [
        {
          target: target as DreamTarget,
          content,
          sourceQuote,
          justification: just || undefined,
        },
      ];
    });
  } catch {
    return null;
  }
}

/** Collapse whitespace + lowercase so small formatting differences
 *  (newlines, double spaces, capitalization) don't break grounding. */
function normalizeForGround(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the normalized quote appears as a substring of the
 *  normalized log. Quotes shorter than 8 chars are rejected — they're
 *  too likely to match incidentally and defeat the check. */
function isGrounded(quote: string, normalizedLog: string): boolean {
  const normalized = normalizeForGround(quote);
  if (normalized.length < 8) return false;
  return normalizedLog.includes(normalized);
}

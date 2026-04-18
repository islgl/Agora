import type { ModelConfig, ThinkingEffort } from '@/types';

/**
 * TS port of `src-tauri/src/providers/thinking.rs`. The AI SDK path lives
 * in the webview, so we need the same effort → per-provider parameter
 * mapping + "does this model support thinking?" whitelist on this side.
 */

export function effortIsActive(e: ThinkingEffort): boolean {
  return e !== 'off';
}

export function supportsThinking(config: ModelConfig): boolean {
  const m = config.model.toLowerCase();
  switch (config.provider) {
    case 'anthropic':
      return (
        m.includes('claude-opus-4') ||
        m.includes('claude-sonnet-4') ||
        m.includes('claude-haiku-4') ||
        m.includes('-thinking')
      );
    case 'openai':
      return (
        m.startsWith('o1') ||
        m.startsWith('o3') ||
        m.startsWith('o4') ||
        m.startsWith('gpt-5') ||
        m.includes('reasoning')
      );
    case 'gemini':
      return m.includes('gemini-2.5') || m.includes('gemini-3') || m.includes('-thinking');
  }
}

/** Anthropic `thinking.budget_tokens` when `type: "enabled"`. */
function anthropicBudget(e: ThinkingEffort): number | null {
  switch (e) {
    case 'off': return null;
    case 'low': return 2_048;
    case 'medium': return 8_192;
    case 'high': return 16_384;
    case 'max': return 48_000;
  }
}

/** OpenAI `reasoning_effort`; max collapses to high. */
function openaiEffort(e: ThinkingEffort): string | null {
  switch (e) {
    case 'off': return null;
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high':
    case 'max': return 'high';
  }
}

/** Gemini `thinkingConfig.thinkingBudget`. `-1` = dynamic (model picks). */
function geminiBudget(e: ThinkingEffort): number | null {
  switch (e) {
    case 'off': return null;
    case 'low': return 2_048;
    case 'medium': return 8_192;
    case 'high': return 16_384;
    case 'max': return -1;
  }
}

export interface ThinkingPlan {
  /** Per-provider `providerOptions` to merge into `streamText`. Typed as
   *  `any`-values because the SDK's `SharedV3ProviderOptions` is a
   *  JSON-shape mapping that TS's structural checks can't narrow to
   *  without shoehorning literal types everywhere. */
  providerOptions: Record<string, Record<string, any>>;
  /** True when effort was requested but the model's not on the whitelist —
   *  caller should mark `thinkingSkipped` on the assistant message. */
  skipped: boolean;
}

/**
 * Build provider options for the given model + effort. If the model
 * doesn't support thinking but the user requested it, return empty
 * options and flag `skipped` so the UI can show the coral "Extended
 * thinking unavailable" hint.
 */
export function planThinking(
  config: ModelConfig,
  effort: ThinkingEffort,
): ThinkingPlan {
  if (!effortIsActive(effort)) {
    return { providerOptions: {}, skipped: false };
  }
  if (!supportsThinking(config)) {
    return { providerOptions: {}, skipped: true };
  }

  switch (config.provider) {
    case 'anthropic': {
      const budget = anthropicBudget(effort);
      if (budget == null) return { providerOptions: {}, skipped: false };
      return {
        providerOptions: {
          anthropic: {
            // Rust proxy rewrites to `{ type: 'adaptive' }` +
            // `output_config.effort` on a Bedrock 4xx, so we always send
            // the direct-Anthropic shape here.
            thinking: { type: 'enabled', budgetTokens: budget },
          },
        },
        skipped: false,
      };
    }
    case 'openai': {
      const eff = openaiEffort(effort);
      if (!eff) return { providerOptions: {}, skipped: false };
      return {
        providerOptions: { openai: { reasoningEffort: eff } },
        skipped: false,
      };
    }
    case 'gemini': {
      const budget = geminiBudget(effort);
      if (budget == null) return { providerOptions: {}, skipped: false };
      return {
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: budget,
              includeThoughts: true,
            },
          },
        },
        skipped: false,
      };
    }
  }
}

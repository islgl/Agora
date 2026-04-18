import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import type { ToolSet } from 'ai';
import type { ModelConfig } from '@/types';

/**
 * Per-provider native web-search tool. The model decides whether to call
 * it — we just attach the descriptor so the option is there. Provider
 * tools are static factories, so we borrow them from the default
 * singletons: the actual HTTP call still routes through our custom-fetch
 * provider instance in `providers.ts`.
 *
 * Tool names matter — each provider expects a specific key:
 *   Anthropic → `web_search`
 *   OpenAI    → `web_search_preview` (Responses API)
 *   Google    → `google_search`
 */
export function webSearchToolsFor(config: ModelConfig): ToolSet {
  switch (config.provider) {
    case 'anthropic':
      return {
        // `maxUses` caps how many searches Claude runs per turn; 5 is a
        // reasonable ceiling for a chat UI without runaway billing.
        web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
      };
    case 'openai':
      return {
        web_search_preview: openai.tools.webSearchPreview({}),
      };
    case 'gemini':
      return {
        google_search: google.tools.googleSearch({}),
      };
  }
}

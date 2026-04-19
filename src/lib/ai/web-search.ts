import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import type { ToolSet } from 'ai';
import type { ModelConfig } from '@/types';
import { tavilySearchTool } from './tavily-search';

/**
 * Attach web-search tools for a turn. The model always sees two candidates
 * when a Tavily key is configured:
 *
 *   - The provider's native server-tool (Anthropic `web_search`, OpenAI
 *     `web_search_preview`, Gemini `google_search`) — preferred when the
 *     endpoint actually supports it.
 *   - `tavily_search` — a provider-agnostic fallback registered as a normal
 *     user tool so it survives gateways that strip provider-native tools.
 *
 * When the gateway strips the native tool, the model only sees
 * `tavily_search` and picks it automatically; no runtime detection needed.
 * Leave the Tavily key blank to disable the fallback.
 *
 * Adding a new provider later means adding one `case` here; the Tavily
 * companion is provider-agnostic and stays untouched.
 */
export function webSearchToolsFor(
  config: ModelConfig,
  tavilyApiKey: string
): ToolSet {
  return {
    ...nativeWebSearchToolsFor(config),
    ...tavilySearchTool(tavilyApiKey),
  };
}

function nativeWebSearchToolsFor(config: ModelConfig): ToolSet {
  switch (config.provider) {
    case 'anthropic':
      // `maxUses` caps how many searches Claude runs per turn; 5 is a
      // reasonable ceiling for a chat UI without runaway billing.
      return {
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

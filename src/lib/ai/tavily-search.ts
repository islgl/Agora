import { jsonSchema, tool, type ToolSet } from 'ai';

/**
 * Provider-agnostic web-search fallback backed by Tavily.
 *
 * Registered alongside each provider's native tool. When the gateway strips
 * the native tool (a common case with Anthropic gateways and `web_search_
 * 20250305`), the model still sees `tavily_search` in the tool set and
 * uses it instead — no routing logic or runtime retry needed.
 *
 * The key is read from the renderer-side settings store. Leave it blank to
 * skip registration (`webSearchToolsFor` handles the empty case).
 */
export function tavilySearchTool(
  apiKey: string,
  maxResults: number = 5
): ToolSet {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return {};

  return {
    tavily_search: tool({
      description:
        'Search the web for fresh or real-time information via Tavily. ' +
        'Returns up to ' +
        maxResults +
        ' results, each with title, URL, and a content snippet. ' +
        "Use this when you need facts newer than the model's training data " +
        "or when the provider's native web search is unavailable.",
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
        },
        required: ['query'],
      }),
      execute: async (input: unknown) => {
        const raw = (input as { query?: unknown })?.query;
        const query = typeof raw === 'string' ? raw.trim() : '';
        if (!query) {
          return { error: 'tavily_search: missing `query`' };
        }

        try {
          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              api_key: trimmedKey,
              query,
              max_results: maxResults,
              search_depth: 'basic',
              include_answer: true,
            }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return {
              error: `tavily_search HTTP ${res.status}: ${text || res.statusText}`,
            };
          }
          const data = (await res.json()) as TavilyResponse;
          return formatResults(data);
        } catch (err) {
          return {
            error:
              'tavily_search failed: ' +
              (err instanceof Error ? err.message : String(err)),
          };
        }
      },
    }),
  };
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

function formatResults(data: TavilyResponse): {
  answer?: string;
  results: Array<{ title: string; url: string; content: string }>;
} {
  const results = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.content ?? '',
  }));
  return data.answer ? { answer: data.answer, results } : { results };
}

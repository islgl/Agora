import { invoke } from '@tauri-apps/api/core';
import { jsonSchema, tool, type ToolSet } from 'ai';

/**
 * Bridge between the Vercel AI SDK and the Rust-owned tool runtimes
 * (MCP servers + Skill built-ins).
 *
 * The SDK sees a normal `ToolSet`; `execute()` forwards to Rust via
 * `invoke('invoke_tool', ...)`. Tool *definitions* (name, description,
 * JSON schema) come straight from `list_frontend_tools`, so we never have
 * to mirror each MCP tool on the TS side.
 */

interface ToolSpecDto {
  name: string;
  description: string;
  inputSchema: unknown;
  // `source` is included by the Rust command but not used on the JS side —
  // routing by name prefix (`mcp__` vs skill built-ins) happens Rust-side
  // inside `invoke_tool`.
  source?: unknown;
}

interface ToolInvocationResult {
  content: string;
  isError: boolean;
}

/**
 * Pull the live set of MCP + Skill tools from Rust and wrap them as
 * AI SDK tools. Returns an empty object if nothing is available so
 * `streamText` happily skips tool handling.
 */
export async function loadFrontendTools(): Promise<ToolSet> {
  let specs: ToolSpecDto[] = [];
  try {
    specs = await invoke<ToolSpecDto[]>('list_frontend_tools');
  } catch (err) {
    console.warn('list_frontend_tools failed; running without tools', err);
    return {};
  }

  const set: ToolSet = {};
  for (const spec of specs) {
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(sanitizeSchema(spec.inputSchema)),
      execute: async (input: unknown) => {
        const result = await invoke<ToolInvocationResult>('invoke_tool', {
          name: spec.name,
          input,
        });
        if (result.isError) {
          // Surface tool errors to the model so it can recover — AI SDK
          // converts thrown errors into `tool-error` stream parts which
          // terminate the step; a shaped error payload keeps the loop going.
          return { error: result.content };
        }
        return result.content;
      },
    });
  }
  return set;
}

/**
 * Some MCP servers emit minimal schemas (`{}` or schemas without a `type`).
 * AI SDK / zod-style validators tolerate most shapes, but Gemini's tool
 * adapter is picky — it wants a plain object schema. Force `type: "object"`
 * when the schema looks object-y but lacks the declaration.
 */
function sanitizeSchema(schema: unknown): any {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const s: any = { ...(schema as Record<string, unknown>) };
  if (!('type' in s) && !('anyOf' in s) && !('oneOf' in s) && !('$ref' in s)) {
    s.type = 'object';
  }
  if (s.type === 'object' && !s.properties) {
    s.properties = {};
  }
  return s;
}

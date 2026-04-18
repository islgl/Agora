export type Role = 'user' | 'assistant' | 'system';

export type Provider = 'openai' | 'anthropic' | 'gemini';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; dataUrl: string; mimeType: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      /** Raw JSON accumulating while the model streams `input_json_delta`s. */
      inputPartial?: string;
    }
  | { type: 'tool_result'; call_id: string; content: string; is_error?: boolean };

export interface Message {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: Role;
  content: string;
  createdAt: number;
  parts?: MessagePart[];
  /** Display name of the model that produced this assistant reply. */
  modelName?: string | null;
  /** Prompt tokens consumed by this turn (assistant messages only). */
  inputTokens?: number | null;
  /** Completion tokens produced by this turn. */
  outputTokens?: number | null;
  /** True if extended thinking was requested but the model/gateway didn't
   *  accept it — UI shows a small hint instead of silent nothingness. */
  thinkingSkipped?: boolean;
  /** 0-based position among siblings (same parent + same role). */
  siblingIndex: number;
  /** Total siblings including this one. `1` means no branches. */
  siblingCount: number;
  /** ID of the immediate previous sibling, or null at the left edge. */
  prevSiblingId?: string | null;
  /** ID of the immediate next sibling, or null at the right edge. */
  nextSiblingId?: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  modelId: string;
  pinned: boolean;
  /** True when user has manually renamed — auto-title won't overwrite. */
  titleLocked: boolean;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type AutoTitleMode = 'off' | 'first' | 'every';
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface GlobalSettings {
  apiKey: string;
  baseUrlOpenai: string;
  baseUrlAnthropic: string;
  baseUrlGemini: string;
  tavilyApiKey: string;
  webSearchEnabled: boolean;
  autoTitleMode: AutoTitleMode;
  thinkingEffort: ThinkingEffort;
}

export interface SkillsMeta {
  directory: string;
  scriptsEnabled: boolean;
}

export interface ScriptUpload {
  filename: string;
  contentBase64: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  scripts: ScriptUpload[];
}

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  loginShell: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  allowedTools: string[];
  body: string;
}

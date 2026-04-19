import { streamText, stepCountIs, type ToolSet } from 'ai';
import { v4 as uuidv4 } from 'uuid';
import type { ModelConfig } from '@/types';
import { modelForConfig } from './providers';
import { useSubagentsStore, type SubagentStatus } from '@/store/subagentsStore';

/**
 * Phase D · subagent runtime.
 *
 * A subagent is an isolated `streamText` session: its own context, its own
 * tool set, its own abort controller. The parent model asks for one via the
 * synthesized `task` tool; this module is what actually spawns it.
 *
 * Scope choices (MVP):
 *  - Runs in the webview, same stack as the main chat. "Background" here
 *    means "doesn't block the main conversation" — *not* "survives window
 *    close." The latter is Phase E work (Rust-side orchestration).
 *  - No persistence. Records live in the module until the app reloads.
 *  - Step cap 10 (vs. parent's 20). Enough for a "grep + summarize" pass,
 *    tight enough that runaway loops bail fast.
 *  - Recursion is blocked by the caller: the subagent's toolset never
 *    contains `task` — see `tools.ts`.
 */

const STEP_CAP = 10;
/** Keep the outputPreview we mirror to zustand small so switching tabs stays
 *  snappy. The full text is returned to the parent via the `task` tool. */
const PREVIEW_LIMIT = 400;

export interface SpawnOptions {
  /** Short label the UI shows next to the running chip. */
  description: string;
  /** The actual instruction the subagent runs against. */
  prompt: string;
  /** When true, spawn returns immediately; caller reads output later. */
  background?: boolean;
  /** Pre-assembled toolset — readonly only. Built by `tools.ts` so this
   *  module doesn't need to know about mode/approval. */
  tools: ToolSet;
  modelConfig: ModelConfig;
  /** System prompt injected for the subagent turn. */
  system: string;
}

/**
 * Audit-trail events emitted while a subagent runs. Captured from the AI
 * SDK full-stream so the user's UI panel and the optional `include_trace`
 * path in `read_subagent_output` can replay what the subagent did. Kept
 * on the Entry in insertion order — consumers render the list as a
 * chronological timeline.
 */
export type SubagentEvent =
  | { kind: 'reasoning'; t: number; text: string }
  | { kind: 'text'; t: number; text: string }
  | {
      kind: 'tool-call';
      t: number;
      callId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: 'tool-result';
      t: number;
      callId: string;
      toolName: string;
      output: string;
      isError: boolean;
    };

interface Entry {
  id: string;
  description: string;
  status: SubagentStatus;
  output: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  abort: AbortController;
  /** Resolves with the final output text (or null on failure/cancel). */
  done: Promise<string | null>;
  /** Audit log. Appended as the subagent streams; never mutated after append. */
  events: SubagentEvent[];
}

const records = new Map<string, Entry>();

export function spawnSubagent(opts: SpawnOptions): {
  id: string;
  done: Promise<string | null>;
} {
  const id = uuidv4();
  const abort = new AbortController();
  const startedAt = Date.now();

  let resolveDone!: (value: string | null) => void;
  const done = new Promise<string | null>((resolve) => {
    resolveDone = resolve;
  });

  const rec: Entry = {
    id,
    description: opts.description,
    status: 'running',
    output: '',
    startedAt,
    abort,
    done,
    events: [],
  };
  records.set(id, rec);

  publish(rec);

  void run(rec, opts).then(
    (finalText) => {
      rec.status = rec.status === 'cancelled' ? 'cancelled' : 'completed';
      rec.output = finalText ?? rec.output;
      rec.endedAt = Date.now();
      publish(rec);
      resolveDone(rec.status === 'completed' ? rec.output : null);
    },
    (err) => {
      // Abort-induced rejections surface here — keep `cancelled` if we
      // already marked it, otherwise record as failed.
      if (rec.status !== 'cancelled') {
        rec.status = 'failed';
        rec.error = toErrorString(err);
      }
      rec.endedAt = Date.now();
      publish(rec);
      resolveDone(null);
    },
  );

  return { id, done };
}

export function getSubagent(id: string): Entry | undefined {
  return records.get(id);
}

/**
 * Snapshot shape returned to the model by `read_subagent_output`. The model
 * needs to see whether it's still running + whatever's been produced so far.
 */
export interface SubagentSnapshot {
  id: string;
  description: string;
  status: SubagentStatus;
  output: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Full audit trail (tool calls, results, reasoning, text). Sent to the
   *  UI timeline and to the parent agent when it explicitly asks for a
   *  trace via `read_subagent_output({ include_trace: true })`. */
  events: SubagentEvent[];
}

export function snapshotSubagent(id: string): SubagentSnapshot | null {
  const r = records.get(id);
  if (!r) return null;
  return toSnapshot(r);
}

/**
 * All subagent records ever registered this session, ordered oldest-first
 * by `startedAt`. Used by the `list_subagents` tool so the model can
 * recover task_ids it forgot (long conversations, etc.).
 */
export function listSubagents(): SubagentSnapshot[] {
  return Array.from(records.values())
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(toSnapshot);
}

function toSnapshot(r: Entry): SubagentSnapshot {
  return {
    id: r.id,
    description: r.description,
    status: r.status,
    output: r.output,
    error: r.error,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    events: r.events.slice(),
  };
}

/** Returns true if we found the task and asked it to stop. */
export function stopSubagent(id: string): boolean {
  const r = records.get(id);
  if (!r) return false;
  if (r.status !== 'running') return false;
  r.status = 'cancelled';
  r.endedAt = Date.now();
  publish(r);
  try {
    r.abort.abort();
  } catch {
    // Already aborted or tied to a dead controller — `r.status` is authoritative.
  }
  return true;
}

async function run(rec: Entry, opts: SpawnOptions): Promise<string> {
  // Mirror the parent's gateway compatibility flag. Non-official
  // Anthropic endpoints (PPIO-style gateways, Bedrock proxies) reject
  // the `eager_input_streaming` field the SDK otherwise adds to every
  // custom tool; without this opt-out the subagent's first tool call
  // errors, the model falls back to plain text, and the run completes
  // in seconds with no actual investigation — aka "秒退".
  const providerOptions: Record<string, Record<string, any>> = {};
  if (
    opts.modelConfig.provider === 'anthropic' &&
    !isOfficialAnthropicBase(opts.modelConfig.baseUrl)
  ) {
    providerOptions.anthropic = { toolStreaming: false };
  }

  const result = streamText({
    model: modelForConfig(opts.modelConfig),
    messages: [{ role: 'user', content: opts.prompt }],
    system: opts.system,
    tools: opts.tools,
    stopWhen: stepCountIs(STEP_CAP),
    abortSignal: rec.abort.signal,
    providerOptions,
  });

  // Coalesce reasoning / text deltas into a single event per run (per
  // role) so the audit log isn't thousands of one-char rows. A tool call
  // boundary flushes the current text/reasoning buffers so the timeline
  // reads in the right order: think → call → result → think → call → …
  let buffered = '';
  let reasoningBuffer = '';
  let textBuffer = '';
  const toolNameById = new Map<string, string>();

  const flushReasoning = () => {
    if (!reasoningBuffer) return;
    rec.events.push({ kind: 'reasoning', t: Date.now(), text: reasoningBuffer });
    reasoningBuffer = '';
  };
  const flushText = () => {
    if (!textBuffer) return;
    rec.events.push({ kind: 'text', t: Date.now(), text: textBuffer });
    textBuffer = '';
  };
  const flushAllText = () => {
    flushReasoning();
    flushText();
  };

  for await (const chunk of result.fullStream) {
    if (rec.status === 'cancelled') break;
    switch (chunk.type) {
      case 'text-delta': {
        // The SDK evolved the delta field name over versions; prefer `text`
        // but fall back to legacy `textDelta` if a host SDK emits it.
        const d =
          (chunk as unknown as { text?: string; textDelta?: string }).text ??
          (chunk as unknown as { textDelta?: string }).textDelta ??
          '';
        if (d) {
          buffered += d;
          textBuffer += d;
          rec.output = buffered;
          publish(rec);
        }
        break;
      }
      case 'reasoning-delta': {
        const d =
          (chunk as unknown as { text?: string; textDelta?: string }).text ??
          (chunk as unknown as { textDelta?: string }).textDelta ??
          '';
        if (d) reasoningBuffer += d;
        break;
      }
      case 'tool-call': {
        flushAllText();
        const c = chunk as unknown as {
          toolCallId: string;
          toolName: string;
          input: unknown;
        };
        toolNameById.set(c.toolCallId, c.toolName);
        rec.events.push({
          kind: 'tool-call',
          t: Date.now(),
          callId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        });
        publish(rec);
        break;
      }
      case 'tool-result': {
        flushAllText();
        const c = chunk as unknown as {
          toolCallId: string;
          toolName?: string;
          output: unknown;
        };
        rec.events.push({
          kind: 'tool-result',
          t: Date.now(),
          callId: c.toolCallId,
          toolName: c.toolName ?? toolNameById.get(c.toolCallId) ?? 'unknown',
          output: toolOutputToString(c.output),
          isError: false,
        });
        publish(rec);
        break;
      }
      case 'tool-error': {
        flushAllText();
        const c = chunk as unknown as {
          toolCallId: string;
          toolName?: string;
          error: unknown;
        };
        rec.events.push({
          kind: 'tool-result',
          t: Date.now(),
          callId: c.toolCallId,
          toolName: c.toolName ?? toolNameById.get(c.toolCallId) ?? 'unknown',
          output: formatSubagentError(c.error),
          isError: true,
        });
        publish(rec);
        break;
      }
      default:
        // start-step / finish-step / text-start / reasoning-start / finish /
        // error / abort / raw — we don't need any of these for the audit
        // view today. If a failure bubbles up here it'll surface via the
        // run-level catch below.
        break;
    }
  }

  flushAllText();

  // Prefer the SDK's resolved .text() if present — it's the model's final
  // answer stripped of reasoning/tool blocks. Fall back to our buffered.
  try {
    const finalText = await result.text;
    if (typeof finalText === 'string' && finalText.length > 0) {
      rec.output = finalText;
      publish(rec);
      return finalText;
    }
  } catch {
    // .text resolves after the stream ends — on a mid-stream abort it may
    // reject. In that case buffered is authoritative.
  }
  return buffered;
}

function isOfficialAnthropicBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return host === 'api.anthropic.com';
  } catch {
    return false;
  }
}

function toolOutputToString(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as { type?: string; value?: unknown };
    if (o.type === 'text' && typeof o.value === 'string') return o.value;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function formatSubagentError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function publish(r: Entry): void {
  useSubagentsStore.getState().upsert({
    id: r.id,
    description: r.description,
    status: r.status,
    outputPreview: truncate(r.output, PREVIEW_LIMIT),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    error: r.error,
    eventCount: r.events.length,
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function toErrorString(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

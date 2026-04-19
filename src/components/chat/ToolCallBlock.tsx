import { useState } from 'react';
import {
  Wrench,
  ChevronDown,
  Check,
  CircleDashed,
  XCircle,
} from 'lucide-react';
import type { MessagePart } from '@/types';
import { DiffView } from './DiffView';

type ToolCall = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResult = Extract<MessagePart, { type: 'tool_result' }>;

interface ToolCallBlockProps {
  call: ToolCall;
  result?: ToolResult;
  /** True while the tool is still resolving (no result yet on the active stream). */
  streaming?: boolean;
}

type State = 'streaming' | 'running' | 'done' | 'error';

function resolveState(
  call: ToolCall,
  result: ToolResult | undefined,
  streaming: boolean,
): State {
  if (result?.is_error) return 'error';
  if (result) return 'done';
  // No result yet: if the model is still emitting input deltas, stay in
  // "streaming"; if the final input has landed and we're executing, flip to
  // "running".
  if (streaming && call.inputPartial !== undefined) return 'streaming';
  return 'running';
}

export function ToolCallBlock({
  call,
  result,
  streaming = false,
}: ToolCallBlockProps) {
  const [open, setOpen] = useState(false);
  const state = resolveState(call, result, streaming);
  const isMcp = call.name.startsWith('mcp__');
  const displayName = isMcp
    ? call.name.slice('mcp__'.length).replace(/__/, ' › ')
    : call.name;
  const source = isMcp ? 'MCP' : 'Skill';

  const statusIcon = {
    streaming: <CircleDashed className="size-3.5 animate-pulse text-muted-foreground" />,
    running: <CircleDashed className="size-3.5 animate-pulse text-muted-foreground" />,
    done: <Check className="size-3.5 text-primary" />,
    error: <XCircle className="size-3.5 text-destructive" />,
  }[state];

  const statusLabel = {
    streaming: 'pending',
    running: 'running',
    done: 'done',
    error: 'error',
  }[state];

  // If the model hasn't finalised input yet, show the raw streaming partial
  // so users see JSON arguments being composed in real time.
  const inputDisplay = (() => {
    const finalText = tryStringify(call.input);
    const hasFinal =
      finalText !== '{}' && finalText !== 'null' && finalText.length > 0;
    if (!hasFinal && call.inputPartial) return call.inputPartial;
    return finalText;
  })();

  return (
    <div
      className="my-2 rounded-xl bg-card"
      style={{
        boxShadow:
          state === 'error'
            ? '0 0 0 1px var(--destructive)'
            : '0 0 0 1px var(--border)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs"
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="text-[10px] px-1.5 py-0 rounded-full bg-secondary text-secondary-foreground shrink-0"
          title={`${source} tool`}
        >
          {source}
        </span>
        <span className="flex-1 truncate text-left font-mono text-foreground">
          {displayName}
        </span>
        {statusIcon}
        <span className="text-muted-foreground">{statusLabel}</span>
        <ChevronDown
          className={`size-3.5 text-muted-foreground transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-xs">
          <EditFileDiffPanel call={call} />
          {!isEditFileWithDiff(call) && (
            <Panel
              label="Input"
              streaming={state === 'streaming'}
              body={inputDisplay}
            />
          )}
          {result && (
            <Panel
              label={state === 'error' ? 'Error' : 'Result'}
              body={result.content}
              destructive={state === 'error'}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface PanelProps {
  label: string;
  body: string;
  streaming?: boolean;
  destructive?: boolean;
}

function Panel({ label, body, streaming, destructive }: PanelProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>{label}</span>
        {streaming && (
          <span className="inline-block size-1 rounded-full bg-primary animate-pulse" />
        )}
      </div>
      <pre
        className="p-2 rounded-md whitespace-pre-wrap break-all"
        style={{
          background: destructive
            ? 'color-mix(in oklab, var(--destructive) 10%, transparent)'
            : 'color-mix(in oklab, var(--muted) 60%, transparent)',
          color: destructive ? 'var(--destructive)' : undefined,
          boxShadow: destructive
            ? '0 0 0 1px var(--destructive)'
            : '0 0 0 1px var(--border)',
        }}
      >
        {body}
      </pre>
    </div>
  );
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function isEditFileWithDiff(call: ToolCall): boolean {
  if (call.name !== 'edit_file') return false;
  const input = call.input as Record<string, unknown> | null;
  if (!input) return false;
  return (
    typeof input.old_string === 'string' && typeof input.new_string === 'string'
  );
}

/**
 * Render an `edit_file` call as a mini unified diff of old_string → new_string.
 * Falls back to nothing when the model hasn't finished streaming the input
 * (the generic Input panel covers that case).
 */
function EditFileDiffPanel({ call }: { call: ToolCall }) {
  if (!isEditFileWithDiff(call)) return null;
  const input = call.input as {
    path?: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>Diff</span>
        {input.path && (
          <span className="font-mono text-foreground/80 truncate">
            {input.path}
          </span>
        )}
        {input.replace_all && (
          <span className="text-[10px] px-1 py-0 rounded bg-secondary text-secondary-foreground">
            replace_all
          </span>
        )}
      </div>
      <DiffView oldText={input.old_string} newText={input.new_string} />
    </div>
  );
}

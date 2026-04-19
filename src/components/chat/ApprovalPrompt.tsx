import { useMemo, useState } from 'react';
import { ShieldAlert, MessageSquarePlus, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ApprovalAnswer, ApprovalRequest } from '@/types';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  queueSize: number;
  onAnswer: (answer: ApprovalAnswer) => void;
}

/**
 * Inline card shown above the chat input whenever a built-in tool needs the
 * user's approval. Four choices:
 * - Once: run this call, remember nothing.
 * - This session: allow matching calls until reload.
 * - Always: persist an allow rule to SQLite.
 * - Deny: cancel the call, report error to model.
 */
export function ApprovalPrompt({
  request,
  queueSize,
  onAnswer,
}: ApprovalPromptProps) {
  const summary = useMemo(() => summarizeInput(request.tool, request.input), [
    request.tool,
    request.input,
  ]);
  const [instructMode, setInstructMode] = useState(false);
  const [instruction, setInstruction] = useState('');

  const submitInstruction = () => {
    const text = instruction.trim();
    if (!text) return;
    onAnswer({ kind: 'instruct', instruction: text });
  };

  return (
    <div
      className="mx-3 mb-2 rounded-xl bg-card"
      style={{ boxShadow: '0 0 0 1px var(--border)' }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-xs">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-500" />
        <span className="font-medium text-foreground">
          Approve tool call
        </span>
        <span
          className="text-[10px] px-1.5 py-0 rounded-full bg-secondary text-secondary-foreground font-mono"
          title="Tool name"
        >
          {request.tool}
        </span>
        {queueSize > 0 && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            +{queueSize} queued
          </span>
        )}
      </div>

      <div className="px-3 pb-2 space-y-1.5 text-xs">
        <pre
          className="p-2 rounded-md whitespace-pre-wrap break-all max-h-40 overflow-y-auto font-mono"
          style={{
            background: 'color-mix(in oklab, var(--muted) 60%, transparent)',
            boxShadow: '0 0 0 1px var(--border)',
          }}
        >
          {summary}
        </pre>
        {request.reason && (
          <div className="text-muted-foreground">{request.reason}</div>
        )}
        <div className="text-[11px] text-muted-foreground">
          "Always" saves the rule{' '}
          <span className="font-mono text-foreground">
            {request.tool}
            {request.saveAsPattern ? ` ${request.saveAsPattern}` : ''}
          </span>
          .
        </div>
      </div>

      {instructMode ? (
        <div className="px-3 pb-3 flex items-start gap-1.5">
          <button
            type="button"
            onClick={() => {
              setInstructMode(false);
              setInstruction('');
            }}
            className="shrink-0 mt-1 text-muted-foreground hover:text-foreground"
            aria-label="Cancel instruction"
            title="Cancel"
          >
            <X className="size-3.5" />
          </button>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                submitInstruction();
              }
            }}
            placeholder="Tell the AI what to do instead (Enter to send, Shift+Enter for newline)…"
            rows={2}
            className="flex-1 rounded-md bg-background px-2 py-1 text-xs outline-none resize-none"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
            autoFocus
          />
          <Button
            size="sm"
            variant="default"
            onClick={submitInstruction}
            disabled={!instruction.trim()}
            className="shrink-0"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      ) : (
        <div className="px-3 pb-3 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="default"
            onClick={() => onAnswer({ kind: 'once' })}
          >
            Once
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAnswer({ kind: 'session' })}
          >
            This session
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAnswer({ kind: 'always' })}
          >
            Always
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setInstructMode(true)}
            className="ml-auto gap-1.5"
            title="Decline this call and tell the AI what to do instead"
          >
            <MessageSquarePlus className="size-3.5" />
            Tell AI
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onAnswer({ kind: 'deny' })}
          >
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Compact, user-facing preview of the tool input. Different tools need
 * different shapes — show the command / path / diff rather than raw JSON so
 * the user can decide without parsing.
 */
function summarizeInput(tool: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'bash':
    case 'bash_background': {
      const cmd = typeof obj.command === 'string' ? obj.command : '';
      const cwd = typeof obj.cwd === 'string' ? ` (cwd: ${obj.cwd})` : '';
      return `${cmd}${cwd}`;
    }
    case 'write_file': {
      const path = typeof obj.path === 'string' ? obj.path : '<no path>';
      const content = typeof obj.content === 'string' ? obj.content : '';
      const preview = content.split('\n').slice(0, 6).join('\n');
      const trailing =
        content.split('\n').length > 6 ? '\n…' : '';
      return `${path}\n────\n${preview}${trailing}`;
    }
    case 'edit_file': {
      const path = typeof obj.path === 'string' ? obj.path : '<no path>';
      const oldStr = typeof obj.old_string === 'string' ? obj.old_string : '';
      const newStr = typeof obj.new_string === 'string' ? obj.new_string : '';
      return `${path}\n- ${trim(oldStr, 200)}\n+ ${trim(newStr, 200)}`;
    }
    default: {
      try {
        return JSON.stringify(input, null, 2);
      } catch {
        return String(input);
      }
    }
  }
}

function trim(s: string, max: number): string {
  if (s.length <= max) return s.replace(/\n/g, '⏎');
  return s.slice(0, max).replace(/\n/g, '⏎') + '…';
}

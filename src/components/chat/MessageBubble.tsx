import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallBlock } from './ToolCallBlock';
import { MessageActions } from './MessageActions';
import { ImageViewDialog } from '@/components/ui/ai-prompt-box';
import type { Message, MessagePart } from '@/types';

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
  onEdit: (messageId: string, newContent: string) => void;
  onRegenerate: (messageId: string, modelConfigId?: string) => void;
  onSwitchBranch: (messageId: string) => void;
}

export function MessageBubble({
  message,
  isStreaming,
  onEdit,
  onRegenerate,
  onSwitchBranch,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [editing, setEditing] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const isThisStreaming = isStreaming && message.inputTokens == null;

  const userImages =
    isUser && message.parts
      ? message.parts.filter(
          (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image',
        )
      : [];

  if (isUser) {
    return (
      <div className="group flex flex-col items-end mb-6">
        {userImages.length > 0 && !editing && (
          <div className="max-w-[75%] flex flex-wrap gap-2 justify-end mb-2">
            {userImages.map((img, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPreviewImage(img.dataUrl)}
                className="h-24 w-24 overflow-hidden rounded-xl border border-border shadow-sm"
              >
                <img
                  src={img.dataUrl}
                  alt="attachment"
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {editing ? (
          <EditBubble
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSubmit={(next) => {
              setEditing(false);
              onEdit(message.id, next);
            }}
          />
        ) : message.content ? (
          <div
            className="max-w-[75%] rounded-2xl rounded-tr-md px-4 py-3 text-sm leading-relaxed
                       bg-secondary text-foreground whitespace-pre-wrap"
            style={{ boxShadow: '0 0 0 1px var(--ring-warm)' }}
          >
            {message.content}
          </div>
        ) : null}
        <ImageViewDialog
          imageUrl={previewImage}
          onClose={() => setPreviewImage(null)}
        />
        {!editing && (
          <div className="max-w-[75%] w-full">
            <MessageActions
              message={message}
              isStreaming={isStreaming}
              onEdit={() => setEditing(true)}
              onRegenerate={() => {}}
              onSwitchBranch={onSwitchBranch}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-start mb-6">
      <div className="max-w-[85%] text-sm leading-relaxed text-foreground w-full">
        {message.parts && message.parts.length > 0
          ? renderParts(message.parts, isThisStreaming)
          : message.content
          ? <MarkdownRenderer content={message.content} />
          : null}
      </div>
      {message.thinkingSkipped && (
        <div
          className="max-w-[85%] w-full mt-2 px-2.5 py-1 text-[11px] rounded-md"
          style={{
            background: 'color-mix(in oklab, var(--coral, #d97757) 10%, transparent)',
            color: 'color-mix(in oklab, var(--coral, #d97757) 70%, var(--foreground))',
            boxShadow:
              '0 0 0 1px color-mix(in oklab, var(--coral, #d97757) 25%, transparent)',
          }}
          title="Extended thinking is enabled in Settings → Capabilities, but the request ran without it — either the model or the upstream gateway didn't accept the parameter."
        >
          Extended thinking unavailable for this request.
        </div>
      )}
      <div className="max-w-[85%] w-full">
        <MessageActions
          message={message}
          isStreaming={isStreaming}
          onEdit={() => {}}
          onRegenerate={(modelId) => onRegenerate(message.id, modelId)}
          onSwitchBranch={onSwitchBranch}
        />
      </div>
    </div>
  );
}

function renderParts(
  parts: MessagePart[],
  streaming: boolean,
): ReactElement[] {
  const resultsByCallId = new Map<
    string,
    Extract<MessagePart, { type: 'tool_result' }>
  >();
  for (const p of parts) {
    if (p.type === 'tool_result') resultsByCallId.set(p.call_id, p);
  }

  // The streaming flag threads through to the last non-result block only —
  // earlier blocks in the same turn have already finished.
  const lastNonResultIdx = (() => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type !== 'tool_result') return i;
    }
    return -1;
  })();

  // Assistant parts we know how to render here — text, thinking, tool_call.
  // `tool_result` is paired into its call above; `image` only appears on
  // user messages and is rendered separately in the user branch.
  const renderable = parts
    .map((p, i) => ({ p, i }))
    .filter(
      (
        e,
      ): e is {
        p: Extract<MessagePart, { type: 'text' | 'thinking' | 'tool_call' }>;
        i: number;
      } =>
        e.p.type === 'text' ||
        e.p.type === 'thinking' ||
        e.p.type === 'tool_call',
    );

  return renderable.map(({ p, i }, filteredIdx, arr) => {
    const isLastOverall = i === lastNonResultIdx;
    const isTailStreaming =
      streaming && isLastOverall && filteredIdx === arr.length - 1;

    if (p.type === 'text') {
      return <MarkdownRenderer key={i} content={p.text} />;
    }
    if (p.type === 'thinking') {
      return (
        <ThinkingBlock key={i} text={p.text} streaming={isTailStreaming} />
      );
    }
    const result = resultsByCallId.get(p.id);
    return (
      <ToolCallBlock
        key={i}
        call={p}
        result={result}
        streaming={!result && isTailStreaming}
      />
    );
  });
}

interface EditBubbleProps {
  initial: string;
  onCancel: () => void;
  onSubmit: (next: string) => void;
}

function EditBubble({ initial, onCancel, onSubmit }: EditBubbleProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoResize(el);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed) onSubmit(trimmed);
    }
  };

  return (
    <div
      className="max-w-[75%] w-full rounded-2xl rounded-tr-md px-4 py-3 bg-secondary"
      style={{ boxShadow: '0 0 0 1px var(--ring-warm)' }}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          autoResize(e.target);
        }}
        onKeyDown={handleKeyDown}
        className="w-full bg-transparent text-sm text-foreground resize-none outline-none
                   whitespace-pre-wrap"
        rows={1}
      />
      <div className="flex items-center justify-end gap-2 mt-2 text-xs text-muted-foreground">
        <span>Esc to cancel · Enter to send</span>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-0.5 rounded hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            const trimmed = value.trim();
            if (trimmed) onSubmit(trimmed);
          }}
          className="px-2 py-0.5 rounded bg-primary text-primary-foreground"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
}

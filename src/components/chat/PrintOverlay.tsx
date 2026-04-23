import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Wrench } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import type { Conversation, Message, MessagePart } from '@/types';
import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * Hidden-by-default overlay rendered at app root. When `printOverlayId` is
 * set (via `setPrintOverlayId`), loads that conversation's active branch and
 * renders it into a print-only container. The global `@media print` rules
 * hide the rest of the app and show this container, so Export PDF works on
 * any conversation without visibly switching the current view.
 */
export function PrintOverlay() {
  const printOverlayId = useChatStore((s) => s.printOverlayId);
  const conversations = useChatStore((s) => s.conversations);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);

  useEffect(() => {
    if (!printOverlayId) {
      document.body.removeAttribute('data-print-overlay-active');
      setMessages(null);
      setConversation(null);
      return;
    }
    document.body.setAttribute('data-print-overlay-active', 'true');
    const conv = conversations.find((c) => c.id === printOverlayId) ?? null;
    setConversation(conv);
    let cancelled = false;
    (async () => {
      try {
        const msgs = await invoke<Message[]>('load_messages', {
          conversationId: printOverlayId,
        });
        if (!cancelled) setMessages(msgs);
      } catch (err) {
        console.error('print overlay: load messages failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [printOverlayId, conversations]);

  if (!printOverlayId) return null;

  // Rendered as a static block element at the app root — NOT `fixed`. When
  // `body[data-print-overlay-active]` is set, CSS in `index.css` hides the
  // regular chat chrome and loosens the root-level `overflow-hidden` so the
  // document grows to the overlay's natural height. That way Apple's
  // `createPDFWithConfiguration:` (called from the Rust side) can capture
  // the whole conversation in one tall page instead of just the viewport.
  return (
    <div
      data-print-overlay="active"
      className="relative w-full bg-background"
    >
      <div className="max-w-3xl mx-auto px-6 py-8">
        <h1
          className="text-2xl mb-6 text-foreground"
          style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
        >
          {conversation?.title ?? 'Conversation'}
        </h1>
        {messages === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className="mb-6"
              data-chat-print="message"
            >
              <div className="text-[11px] text-muted-foreground mb-1 uppercase tracking-wider">
                {m.role === 'user'
                  ? 'User'
                  : m.modelName
                  ? `Assistant · ${m.modelName}`
                  : 'Assistant'}
              </div>
              <div className="text-foreground text-sm leading-relaxed">
                {m.parts && m.parts.length > 0
                  ? renderParts(m.parts)
                  : m.content
                  ? <MarkdownRenderer content={m.content} />
                  : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function renderParts(parts: MessagePart[]): React.ReactNode {
  return parts
    .filter((p) => p.type !== 'tool_result')
    .map((p, i) => {
      if (p.type === 'text') {
        return <MarkdownRenderer key={i} content={p.text} />;
      }
      if (p.type === 'tool_call') {
        return (
          <div
            key={i}
            className="text-xs bg-muted/40 p-2 rounded my-2"
          >
            <div className="flex items-center gap-1.5 font-medium">
              <Wrench aria-hidden className="size-3" />
              <span>{p.name}</span>
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-all">
              {tryStringify(p.input)}
            </pre>
          </div>
        );
      }
      return null;
    });
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

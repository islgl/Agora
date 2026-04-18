import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThinkingBlockProps {
  text: string;
  /** Pulses while the model is actively emitting reasoning. */
  streaming?: boolean;
}

/**
 * Auto-open while streaming, auto-close ~1s after the stream ends, report
 * "Thought for N seconds" once a duration is known. Tight with Agora's
 * parchment palette — no shadcn Collapsible needed.
 */
export function ThinkingBlock({ text, streaming = false }: ThinkingBlockProps) {
  const [open, setOpen] = useState(streaming);
  const [duration, setDuration] = useState<number | null>(null);
  const everStreamed = useRef(streaming);
  const startAt = useRef<number | null>(streaming ? Date.now() : null);
  const closedOnce = useRef(false);

  // Track stream start/end for duration + auto-close.
  useEffect(() => {
    if (streaming) {
      everStreamed.current = true;
      if (startAt.current == null) startAt.current = Date.now();
      setOpen((v) => v || true); // open once on first chunk
      return;
    }
    if (startAt.current != null) {
      setDuration(Math.ceil((Date.now() - startAt.current) / 1000));
      startAt.current = null;
    }
    if (!everStreamed.current || closedOnce.current) return;
    const id = setTimeout(() => {
      closedOnce.current = true;
      setOpen(false);
    }, 1000);
    return () => clearTimeout(id);
  }, [streaming]);

  const label = streaming
    ? 'Thinking…'
    : duration != null
    ? `Thought for ${duration}s`
    : 'Thinking';

  return (
    <div
      className="my-2 rounded-xl bg-muted/30"
      style={{ boxShadow: '0 0 0 1px var(--border)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Brain className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        {streaming && (
          <span className="inline-block size-1 rounded-full bg-primary animate-pulse" />
        )}
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 text-[11px] text-muted-foreground">
          <MarkdownRenderer content={text} className="[&_p]:my-1" />
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { nousLight, nousDark } from '@/lib/nous-theme';
import { cn } from '@/lib/utils';

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        // `min-w-0` is load-bearing: without it, a wide code line would
        // trigger flex's default `min-width: auto` and push the card past
        // the message column, blowing out the whole chat layout.
        //
        // `bg-muted` (dusty parchment) rather than `bg-card` (ivory) — the
        // ivory is too close to Shiki's stark white and made the block
        // glare against the page. Muted gives the code block a warm,
        // recessed feel that sits naturally in the Parchment theme.
        'not-prose flex w-full min-w-0 flex-col overflow-clip border',
        'border-border bg-muted text-foreground rounded-xl',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlockCode({
  code,
  language = 'text',
  className,
  ...props
}: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setHighlightedHtml('<pre><code></code></pre>');
      return;
    }
    codeToHtml(code, {
      lang: language,
      // Custom Nous palette — warm, muted, terracotta/sage/plum. See
      // `lib/nous-theme.ts` for the full token map.
      themes: { light: nousLight, dark: nousDark },
      defaultColor: 'light',
    })
      .then((html) => {
        if (!cancelled) setHighlightedHtml(html);
      })
      .catch(() => {
        if (!cancelled) setHighlightedHtml(null);
      });
    return () => {
      cancelled = true;
    };
    // Include theme refs in deps so an HMR-triggered palette reload (or
    // any future theme prop) re-runs the highlight instead of reusing the
    // stale `highlightedHtml` baked into state.
  }, [code, language, nousLight, nousDark]);

  const classNames = cn(
    // `min-w-0` on the scroll container lets long lines scroll horizontally
    // inside the card instead of stretching the parent.
    'w-full min-w-0 overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-3 [&>pre]:bg-transparent',
    className,
  );

  return highlightedHtml ? (
    <div
      className={classNames}
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      {...props}
    />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div
      className={cn('flex items-center justify-between', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock };

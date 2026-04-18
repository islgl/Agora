import { memo, useState } from 'react';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { createMathPlugin } from '@streamdown/math';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CodeBlock,
  CodeBlockCode,
  CodeBlockGroup,
} from '@/components/ui/code-block';
import { MermaidBlock } from './MermaidBlock';
import { cn } from '@/lib/utils';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// Enable single-dollar inline math (`$...$`). The default @streamdown/math
// export has `singleDollarTextMath: false`, which leaves `$E = mc^2$` as
// literal text — only `$$...$$` blocks render. Re-create with the flag on.
const math = createMathPlugin({ singleDollarTextMath: true });
// Mermaid is handled by our own `MermaidBlock` inside the `code` override,
// so the Streamdown mermaid plugin is no longer needed.
const plugins = { cjk, math };

type CodeProps = {
  className?: string;
  children?: React.ReactNode;
};

function MarkdownCode({ className, children, ...rest }: CodeProps) {
  const match = /language-([\w-]+)/.exec(className ?? '');
  const language = match?.[1];

  if (!language) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  const raw = String(children ?? '').replace(/\n$/, '');

  // Mermaid fences render as diagrams, not syntax-highlighted text. The
  // block reserves its own card chrome, so no CodeBlock wrapper.
  if (language === 'mermaid') {
    return <MermaidBlock code={raw} />;
  }

  return (
    <CodeBlock className="my-3">
      <CodeBlockGroup className="bg-[var(--code-header-bg)] border-b border-border py-1.5 pr-1.5 pl-3">
        <span className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs font-medium lowercase">
          {language}
        </span>
        <CopyCodeButton code={raw} />
      </CodeBlockGroup>
      <CodeBlockCode code={raw} language={language} />
    </CodeBlock>
  );
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  );
}

const components = { code: MarkdownCode };

/**
 * Thin `.prose`-wrapped Streamdown. Streamdown handles the streaming-friendly
 * bits (half-open code fences, incremental lists, etc.) so incremental chunks
 * don't cause layout thrash. `.prose` pulls typography from the overrides in
 * `index.css` — keeps the markdown visuals coherent with the rest of the app.
 * Code blocks are rendered via the 21st.dev motion-primitives `CodeBlock`
 * primitives + Shiki directly, overriding Streamdown's built-in CodeBlock.
 */
export const MarkdownRenderer = memo(
  function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
    return (
      <Streamdown
        className={cn(
          'prose prose-sm max-w-none',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          className,
        )}
        plugins={plugins}
        components={components}
        lineNumbers={false}
      >
        {content}
      </Streamdown>
    );
  },
  (prev, next) =>
    prev.content === next.content && prev.className === next.className,
);

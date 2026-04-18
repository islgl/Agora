import { useEffect, useMemo, useState } from 'react';
import mermaid from 'mermaid';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

/**
 * Renders a mermaid code block into an SVG diagram. Handles:
 * - Theme switching (re-initialises mermaid when the app flips dark/light).
 * - Errors (keeps the last good render visible and surfaces a collapsible
 *   error panel instead of tearing the diagram out).
 * - Streaming (debounces so partial code mid-stream doesn't strobe the UI).
 */

let initializedMode: string | null = null;
let uid = 0;

function cssVar(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * Pull Parchment/dark tokens straight from the live `:root` so mermaid
 * inherits the warm palette instead of painting its default blue/pastel
 * theme. Called per ensureInit() so a theme flip picks up fresh values.
 */
function buildThemeVariables(): Record<string, string> {
  const card = cssVar('--card');
  const muted = cssVar('--muted');
  const secondary = cssVar('--secondary');
  const border = cssVar('--border');
  const ringWarm = cssVar('--ring-warm');
  const ringDeep = cssVar('--ring-deep');
  const mutedFg = cssVar('--muted-foreground');
  const foreground = cssVar('--foreground');
  const primary = cssVar('--primary');
  return {
    background: card,
    primaryColor: muted,
    primaryBorderColor: ringDeep || ringWarm,
    primaryTextColor: foreground,
    secondaryColor: secondary,
    secondaryBorderColor: ringWarm,
    secondaryTextColor: foreground,
    tertiaryColor: border,
    tertiaryBorderColor: ringWarm,
    tertiaryTextColor: foreground,
    lineColor: mutedFg,
    textColor: foreground,
    noteBkgColor: muted,
    noteBorderColor: ringWarm,
    noteTextColor: foreground,
    edgeLabelBackground: card,
    // Sequence diagrams
    actorBkg: muted,
    actorBorder: primary,
    actorTextColor: foreground,
    actorLineColor: mutedFg,
    signalColor: foreground,
    signalTextColor: foreground,
    labelBoxBkgColor: card,
    labelBoxBorderColor: ringWarm,
    labelTextColor: foreground,
    loopTextColor: foreground,
    activationBkgColor: primary,
    activationBorderColor: primary,
    // State diagrams
    specialStateColor: primary,
    transitionColor: mutedFg,
    // Class diagrams
    classText: foreground,
  };
}

function ensureInit(mode: 'light' | 'dark') {
  if (initializedMode === mode) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: buildThemeVariables(),
    securityLevel: 'strict',
    fontFamily: 'inherit',
    suppressErrorRendering: true,
  });
  initializedMode = mode;
}

interface MermaidBlockProps {
  code: string;
  className?: string;
}

export function MermaidBlock({ code, className }: MermaidBlockProps) {
  const { resolvedTheme } = useTheme();
  const mode: 'light' | 'dark' = resolvedTheme === 'dark' ? 'dark' : 'light';
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useMemo(() => `mermaid-${++uid}`, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      ensureInit(mode);
      mermaid
        .render(id, code)
        .then(({ svg }) => {
          if (cancelled) return;
          setSvg(svg);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, id, mode]);

  if (error && !svg) {
    return (
      <div
        className={cn(
          'not-prose my-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3',
          className,
        )}
      >
        <div className="mb-2 text-xs font-semibold text-destructive">
          Mermaid parse error
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-destructive/80">
          {error}
        </pre>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Source
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {code}
          </pre>
        </details>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className={cn(
          'not-prose my-3 flex w-full min-w-0 items-center justify-center rounded-xl border border-border bg-card p-6',
          className,
        )}
      >
        <span className="text-sm text-muted-foreground">
          Rendering diagram…
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'not-prose my-3 flex w-full min-w-0 justify-center overflow-x-auto rounded-xl border border-border bg-card p-4',
        '[&_svg]:max-w-full [&_svg]:h-auto',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

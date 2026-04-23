import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { CornerDownLeft } from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { AgoraLogo } from '@/components/icons/AgoraLogo';
import { SLASH_COMMANDS, type SlashCommandSpec } from '@/lib/slash';

// Temporarily disabled — flip back to `true` to restore the slash menu.
const SLASH_COMMANDS_ENABLED: boolean = false;

const COLLAPSED_HEIGHT = 120;
const LAUNCHER_WIDTH = 620;
// Slash menu geometry. Each row is `py-1.5` + `text-xs leading-5` ≈ 32px,
// and `space-y-1` adds a 4px gap. The 96px chrome covers the input row,
// footer, outer padding (`pt-3` / `pb-2`), and the `mt-2 pt-2 border-t`
// that opens the menu. Cap at 10 visible rows so the launcher never
// balloons past a laptop screen; anything beyond that scrolls in place.
const MENU_CHROME = 96;
const MENU_ROW_HEIGHT = 32;
const MENU_ROW_GAP = 4;
const MENU_MAX_ROWS = 10;

function launcherHeightFor(matchCount: number): number {
  if (matchCount <= 0) return COLLAPSED_HEIGHT;
  const rows = Math.min(MENU_MAX_ROWS, matchCount);
  return (
    MENU_CHROME + rows * MENU_ROW_HEIGHT + Math.max(0, rows - 1) * MENU_ROW_GAP
  );
}

export function LauncherPanel() {
  const panelWindow = useMemo(() => getCurrentWebviewWindow(), []);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [input, setInput] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Guard against double-invocation (Enter + key repeat, or a fast double
  // press) landing two `perform_launcher_submit` calls on the Rust side —
  // each one would hit `dispatch_background_action_with_text` and the main
  // window would end up creating a duplicate conversation for the same text.
  const submittingRef = useRef(false);

  useEffect(() => {
    const prevHtmlBackground = document.documentElement.style.backgroundColor;
    const prevBodyBackground = document.body.style.backgroundColor;
    const prevBodyBackgroundImage = document.body.style.backgroundImage;

    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.body.style.backgroundImage = 'none';

    void panelWindow.setBackgroundColor([0, 0, 0, 0]).catch(() => {});

    return () => {
      document.documentElement.style.backgroundColor = prevHtmlBackground;
      document.body.style.backgroundColor = prevBodyBackground;
      document.body.style.backgroundImage = prevBodyBackgroundImage;
    };
  }, [panelWindow]);

  useEffect(() => {
    let unlistenFocus: (() => void) | null = null;

    void panelWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          // Re-summoning the launcher always starts with a clean slate so
          // a stale `/mem` from the last session doesn't haunt the next one.
          setInput('');
          setSlashIndex(0);
          submittingRef.current = false;
          inputRef.current?.focus();
        } else {
          void panelWindow.hide().catch(() => {});
        }
      })
      .then((dispose) => {
        unlistenFocus = dispose;
      });

    return () => {
      unlistenFocus?.();
    };
  }, [panelWindow]);

  const hide = () => {
    setInput('');
    setSlashIndex(0);
    void panelWindow.hide().catch(() => {});
  };

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Re-entry lock — the Rust dispatch is idempotent per invocation but
    // invoking it twice would fire two background-action events, each of
    // which can spawn a new conversation in the main window.
    if (submittingRef.current) return;
    submittingRef.current = true;
    invoke('perform_launcher_submit', { text: trimmed })
      .then(() => {
        setInput('');
        setSlashIndex(0);
      })
      .catch((err) => {
        toast.error(String(err));
        // Only release on failure so the user can retry. On success we
        // stay locked — the window is about to hide, and re-opening it
        // resets the flag via `onFocusChanged`.
        submittingRef.current = false;
      });
  };

  // Slash-command menu is active only while the input is a leading `/token`
  // with no whitespace — mirrors the composer's behavior in
  // `src/components/ui/ai-prompt-box.tsx`.
  const slashMatches: SlashCommandSpec[] = useMemo(() => {
    if (!SLASH_COMMANDS_ENABLED) return [];
    if (!input.startsWith('/')) return [];
    if (/\s/.test(input)) return [];
    const prefix = input.toLowerCase();
    return SLASH_COMMANDS.filter((s) =>
      s.command.toLowerCase().startsWith(prefix),
    );
  }, [input]);

  const slashMenuOpen = slashMatches.length > 0;

  // Highlight a leading `/command` only when it exactly matches a known
  // command followed by whitespace or end-of-string — mirrors the
  // overlay in `src/components/ui/ai-prompt-box.tsx`. Partial typings
  // like `/ch` stay unstyled so they don't flash during typing.
  const knownSlashCommands = useMemo(
    () => SLASH_COMMANDS.map((s) => s.command),
    [],
  );
  const slashPrefix = useMemo(() => {
    if (!SLASH_COMMANDS_ENABLED) return null;
    const m = input.match(/^\/\S+/);
    if (!m) return null;
    const token = m[0];
    if (!knownSlashCommands.includes(token)) return null;
    const next = input.charAt(token.length);
    if (next !== '' && !/\s/.test(next)) return null;
    return token;
  }, [input, knownSlashCommands]);
  const slashRest = slashPrefix ? input.slice(slashPrefix.length) : '';

  // Grow the native window downward to match the actual number of matches
  // so the list isn't squeezed into a tiny scrollable strip, and shrink
  // back to the compact 1Password-style size when the slash clears.
  useEffect(() => {
    const height = launcherHeightFor(slashMatches.length);
    void panelWindow
      .setSize(new LogicalSize(LAUNCHER_WIDTH, height))
      .catch(() => {});
  }, [slashMatches.length, panelWindow]);

  useEffect(() => {
    if (!slashMenuOpen) {
      if (slashIndex !== 0) setSlashIndex(0);
      return;
    }
    if (slashIndex >= slashMatches.length) setSlashIndex(0);
  }, [slashMenuOpen, slashMatches.length, slashIndex]);

  const pickSlash = (cmd: SlashCommandSpec) => {
    if (cmd.prompt) {
      // Expansion commands get swapped for their natural-language
      // request — the user just hits Enter again to submit.
      setInput(cmd.prompt);
    } else {
      // Arg-taking commands (e.g. `/open raw`) keep the token and wait
      // for the user to type the argument.
      setInput(cmd.command + ' ');
    }
    setSlashIndex(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      return;
    }

    // IME composition (Chinese/Japanese/Korean): Enter commits a candidate
    // rather than submitting or navigating the slash menu. keyCode 229 is
    // the cross-browser fallback. Mirrors ai-prompt-box.tsx.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }

    if (slashMenuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (event.key === 'Tab') {
        const target = slashMatches[slashIndex];
        if (target) {
          event.preventDefault();
          pickSlash(target);
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const target = slashMatches[slashIndex];
        if (target) {
          event.preventDefault();
          pickSlash(target);
          return;
        }
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit(input);
    }
  };

  return (
    <>
      <div className="h-dvh w-screen overflow-hidden bg-transparent select-none">
        <div
          className="relative flex h-full flex-col overflow-hidden rounded-[20px]
                     bg-card text-foreground"
          style={{
            boxShadow: isDark
              ? [
                  'inset 0 1px 0 rgba(255,255,255,0.07)',
                  'inset 0 -1px 0 rgba(0,0,0,0.40)',
                  'inset 0 0 0 1px rgba(255,255,255,0.06)',
                ].join(', ')
              : [
                  'inset 0 1px 0 rgba(255,255,255,0.55)',
                  'inset 0 -1px 0 rgba(0,0,0,0.08)',
                  'inset 0 0 0 1px rgba(255,255,255,0.14)',
                ].join(', '),
            backgroundImage: isDark
              ? [
                  'radial-gradient(circle at top right, rgba(201,100,66,0.09), transparent 42%)',
                  'radial-gradient(circle at top left, rgba(56,152,236,0.06), transparent 36%)',
                  'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.10))',
                ].join(', ')
              : [
                  'radial-gradient(circle at top right, rgba(201,100,66,0.12), transparent 42%)',
                  'radial-gradient(circle at top left, rgba(56,152,236,0.08), transparent 36%)',
                  'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.04))',
                ].join(', '),
          }}
        >
          <div className="flex h-full flex-col px-4 pt-3 pb-2">
            <div className="relative flex items-center gap-2.5">
              <div className="flex h-8 shrink-0 items-center">
                <AgoraLogo className="size-6" />
              </div>
              <div className="relative flex-1 h-8 overflow-hidden">
                {slashPrefix && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[18px] leading-8"
                    style={{ fontFamily: 'Georgia, serif' }}
                  >
                    <span
                      style={{
                        color: 'var(--primary)',
                        background:
                          'color-mix(in oklab, var(--primary) 12%, transparent)',
                      }}
                    >
                      {slashPrefix}
                    </span>
                    <span className="text-foreground">{slashRest}</span>
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  rows={1}
                  placeholder="Ask Agora…"
                  className={`w-full resize-none bg-transparent border-0 m-0 py-0 h-8 text-[18px] leading-8 placeholder:text-muted-foreground/70 focus:outline-none ${
                    slashPrefix ? 'text-transparent' : 'text-foreground'
                  }`}
                  style={{
                    fontFamily: 'Georgia, serif',
                    caretColor: slashPrefix ? 'var(--foreground)' : undefined,
                  }}
                />
              </div>
            </div>

            {slashMenuOpen && (
              <ul className="mt-2 flex-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain rounded-lg border-t border-border/60 pt-2">
                {slashMatches.map((cmd, idx) => (
                  <li key={cmd.command}>
                    <button
                      type="button"
                      onMouseEnter={() => setSlashIndex(idx)}
                      onClick={() => pickSlash(cmd)}
                      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                        idx === slashIndex
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-background/60'
                      }`}
                    >
                      <span className="rounded-md bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                        {cmd.command}
                      </span>
                      <span className="flex-1 text-xs leading-5">
                        {cmd.description}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-auto flex items-center justify-between pt-1.5 text-[11px] text-muted-foreground">
              <div>
                <kbd className="rounded bg-background/70 px-1.5 py-0.5 text-[10px]">
                  Esc
                </kbd>{' '}
                to close
              </div>
              <div className="flex items-center gap-1">
                <kbd className="inline-flex items-center justify-center rounded bg-background/70 px-1.5 py-0.5">
                  <CornerDownLeft className="size-3" />
                </kbd>
                to continue in app
              </div>
            </div>
          </div>
        </div>
      </div>

      <Toaster position="top-center" />
    </>
  );
}

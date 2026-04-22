import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import logoLight from '../../../assets/logo-light.png';
import { Toaster } from '@/components/ui/sonner';
import { SLASH_COMMANDS, type SlashCommandSpec } from '@/lib/slash';

const COLLAPSED_HEIGHT = 120;
const EXPANDED_HEIGHT = 340;
const LAUNCHER_WIDTH = 620;

export function LauncherPanel() {
  const panelWindow = useMemo(() => getCurrentWebviewWindow(), []);
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
    if (!input.startsWith('/')) return [];
    if (/\s/.test(input)) return [];
    const prefix = input.toLowerCase();
    return SLASH_COMMANDS.filter((s) =>
      s.command.toLowerCase().startsWith(prefix),
    );
  }, [input]);

  const slashMenuOpen = slashMatches.length > 0;

  // Grow the native window downward when the slash menu opens; shrink back
  // to the compact 1Password-style size when the user clears the slash.
  useEffect(() => {
    const height = slashMenuOpen ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
    void panelWindow
      .setSize(new LogicalSize(LAUNCHER_WIDTH, height))
      .catch(() => {});
  }, [slashMenuOpen, panelWindow]);

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
            boxShadow: [
              'inset 0 1px 0 rgba(255,255,255,0.55)',
              'inset 0 -1px 0 rgba(0,0,0,0.08)',
              'inset 0 0 0 1px rgba(255,255,255,0.14)',
            ].join(', '),
            backgroundImage: [
              'radial-gradient(circle at top right, rgba(201,100,66,0.12), transparent 42%)',
              'radial-gradient(circle at top left, rgba(56,152,236,0.08), transparent 36%)',
              'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.04))',
            ].join(', '),
          }}
        >
          <div className="flex h-full flex-col px-4 pt-3 pb-2">
            <div className="relative flex items-center gap-2.5">
              <div
                aria-label="Agora"
                className="size-6 shrink-0"
                style={{
                  backgroundColor: 'var(--primary)',
                  maskImage: `url(${logoLight})`,
                  maskSize: 'contain',
                  maskRepeat: 'no-repeat',
                  maskPosition: 'center',
                  WebkitMaskImage: `url(${logoLight})`,
                  WebkitMaskSize: 'contain',
                  WebkitMaskRepeat: 'no-repeat',
                  WebkitMaskPosition: 'center',
                }}
              />
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                rows={1}
                placeholder="Ask Agora, or / to pick a command…"
                className="flex-1 resize-none bg-transparent text-[18px] leading-8 text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                style={{
                  fontFamily: 'Georgia, serif',
                }}
              />
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
              <div>
                <kbd className="rounded bg-background/70 px-1.5 py-0.5 text-[10px]">
                  ⏎
                </kbd>{' '}
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

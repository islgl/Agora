import { useEffect, useMemo, type ComponentType } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ArrowUpRight, Settings, SquarePen } from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import type { BackgroundAction } from '@/lib/background';

interface QuickActionCardProps {
  title: string;
  description: string;
  accent: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
}

function QuickActionCard({
  title,
  description,
  accent,
  icon: Icon,
  onClick,
}: QuickActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-start gap-3 rounded-[20px] border border-border/90
                 bg-background/85 px-3.5 py-3 text-left transition-all duration-150
                 cursor-pointer hover:border-primary/30 hover:bg-background"
      style={{
        boxShadow: '0 0 0 1px color-mix(in oklab, var(--border) 70%, transparent)',
      }}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-2xl"
        style={{
          background: accent,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
        }}
      >
        <Icon className="size-4 text-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground transition-colors group-hover:text-primary">
          {title}
        </div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </div>
      </div>
    </button>
  );
}

export function MenuBarPanel() {
  const panelWindow = useMemo(() => getCurrentWebviewWindow(), []);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

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
        if (!focused) {
          void panelWindow.hide().catch(() => {});
        }
      })
      .then((dispose) => {
        unlistenFocus = dispose;
      });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void panelWindow.hide().catch(() => {});
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      unlistenFocus?.();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [panelWindow]);

  const runBackgroundAction = async (action: BackgroundAction) => {
    try {
      await panelWindow.hide();
      await invoke('perform_background_action', { action });
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <>
      <div className="h-dvh w-screen overflow-hidden bg-transparent select-none">
        <div
          className="relative h-full overflow-hidden rounded-[26px]
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
                  'radial-gradient(circle at top right, rgba(201,100,66,0.10), transparent 34%)',
                  'radial-gradient(circle at top left, rgba(56,152,236,0.07), transparent 28%)',
                  'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.14))',
                  'radial-gradient(ellipse at top, transparent 45%, rgba(0,0,0,0.25) 100%)',
                ].join(', ')
              : [
                  'radial-gradient(circle at top right, rgba(201,100,66,0.16), transparent 34%)',
                  'radial-gradient(circle at top left, rgba(56,152,236,0.08), transparent 28%)',
                  'linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0.06))',
                  'radial-gradient(ellipse at top, transparent 45%, rgba(0,0,0,0.06) 100%)',
                ].join(', '),
          }}
        >
          <div
            className={`absolute inset-x-0 top-0 h-20 bg-gradient-to-b to-transparent pointer-events-none ${
              isDark ? 'from-white/[0.04]' : 'from-white/35'
            }`}
          />

          <div className="relative flex h-full flex-col p-6">
            <div className="px-1 pb-5">
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                Quick entry
              </div>
              <h1
                className="mt-1.5 text-[24px] leading-none text-foreground"
                style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
              >
                Agora
              </h1>
            </div>

            <div className="flex flex-col gap-2.5">
              <QuickActionCard
                title="New conversation"
                description="Bring Agora forward and open a fresh chat instantly."
                accent={isDark
                  ? 'linear-gradient(135deg, rgba(217,119,87,0.50), rgba(110,45,18,0.88))'
                  : 'linear-gradient(135deg, rgba(217,119,87,0.35), rgba(255,244,230,0.88))'}
                icon={SquarePen}
                onClick={() => void runBackgroundAction('new-conversation')}
              />
              <QuickActionCard
                title="Open Agora"
                description="Return to the full workspace without starting a new chat."
                accent={isDark
                  ? 'linear-gradient(135deg, rgba(56,152,236,0.45), rgba(18,45,90,0.88))'
                  : 'linear-gradient(135deg, rgba(56,152,236,0.18), rgba(240,247,255,0.92))'}
                icon={ArrowUpRight}
                onClick={() => void runBackgroundAction('open-agora')}
              />
              <QuickActionCard
                title="Settings"
                description="Jump straight into configuration and background preferences."
                accent={isDark
                  ? 'linear-gradient(135deg, rgba(90,90,85,0.50), rgba(35,35,32,0.88))'
                  : 'linear-gradient(135deg, rgba(20,20,19,0.09), rgba(255,255,255,0.86))'}
                icon={Settings}
                onClick={() => void runBackgroundAction('open-settings')}
              />
            </div>
          </div>
        </div>
      </div>

      <Toaster position="top-center" />
    </>
  );
}

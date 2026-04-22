import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  ArrowUpRight,
  Command,
  Power,
  Settings,
  Sparkles,
  SquarePen,
} from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Toggle } from '@/components/ui/toggle';
import type { BackgroundAction } from '@/lib/background';
import { useSettingsStore } from '@/store/settingsStore';
import type { BackgroundStatus } from '@/types';

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
                 hover:border-primary/30 hover:bg-background"
      style={{
        boxShadow: '0 0 0 1px color-mix(in oklab, var(--border) 70%, transparent)',
      }}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-2xl"
        style={{
          background: accent,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45)',
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
  const {
    globalSettings,
    backgroundStatus,
    loadGlobalSettings,
    loadBackgroundStatus,
    saveGlobalSettings,
  } = useSettingsStore();
  const [settingsReady, setSettingsReady] = useState(false);
  const [savingQuickLaunch, setSavingQuickLaunch] = useState(false);

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
    Promise.all([loadGlobalSettings(), loadBackgroundStatus()])
      .then(() => setSettingsReady(true))
      .catch((err) => {
        toast.error(String(err));
      });
  }, [loadGlobalSettings, loadBackgroundStatus]);

  useEffect(() => {
    let unlistenStatus: (() => void) | null = null;
    void listen<BackgroundStatus>('agora-background-status-changed', (event) => {
      useSettingsStore.getState().setBackgroundStatus(event.payload);
    }).then((dispose) => {
      unlistenStatus = dispose;
    });

    return () => {
      unlistenStatus?.();
    };
  }, []);

  useEffect(() => {
    let unlistenFocus: (() => void) | null = null;

    void panelWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        void panelWindow.hide().catch(() => {});
      }
    }).then((dispose) => {
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
      if (action !== 'quit') {
        await panelWindow.hide();
      }
      await invoke('perform_background_action', { action });
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleQuickLaunchToggle = async (checked: boolean) => {
    if (!settingsReady) return;
    setSavingQuickLaunch(true);
    try {
      await saveGlobalSettings({
        ...globalSettings,
        quickLaunchEnabled: checked,
      });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingQuickLaunch(false);
    }
  };

  const quickLaunchLabel = backgroundStatus?.quickLaunchActive
    ? 'Active'
    : backgroundStatus?.quickLaunchEnabled
      ? 'Standby'
      : 'Off';

  return (
    <>
      <div className="h-dvh w-screen overflow-hidden bg-transparent select-none">
        <div
          className="relative h-full overflow-hidden rounded-[26px]
                     bg-card text-foreground"
          style={{
            boxShadow: [
              'inset 0 1px 0 rgba(255,255,255,0.55)',
              'inset 0 -1px 0 rgba(0,0,0,0.08)',
              'inset 0 0 0 1px rgba(255,255,255,0.14)',
            ].join(', '),
            backgroundImage: [
              'radial-gradient(circle at top right, rgba(201,100,66,0.16), transparent 34%)',
              'radial-gradient(circle at top left, rgba(56,152,236,0.08), transparent 28%)',
              'linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0.06))',
              'radial-gradient(ellipse at top, transparent 45%, rgba(0,0,0,0.06) 100%)',
            ].join(', '),
          }}
        >
          <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/35 to-transparent pointer-events-none" />

          <div
            className="relative flex h-full flex-col overflow-y-auto overscroll-contain"
            style={{
              maskImage:
                'linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.35) 16px, black 44px, black calc(100% - 44px), rgba(0,0,0,0.35) calc(100% - 16px), transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.35) 16px, black 44px, black calc(100% - 44px), rgba(0,0,0,0.35) calc(100% - 16px), transparent 100%)',
            }}
          >
            <div className="px-4 pt-4 pb-3">
              <div className="inline-flex items-center gap-2 rounded-full bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground">
                <span className="size-2 rounded-full bg-primary" />
                Agora in the menu bar
              </div>

              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                    Quick entry
                  </div>
                  <h1
                    className="mt-1 text-[27px] leading-none text-foreground"
                    style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
                  >
                    Agora
                  </h1>
                  <p className="mt-2 max-w-[16rem] text-xs leading-5 text-muted-foreground">
                    Keep the full app out of the way, then drop into a new chat or
                    settings in one click.
                  </p>
                </div>

                <div
                  className="rounded-[18px] border border-border/80 bg-background/85 px-3 py-2"
                  style={{
                    boxShadow:
                      '0 0 0 1px color-mix(in oklab, var(--border) 70%, transparent)',
                  }}
                >
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Quick launch
                  </div>
                  <div className="mt-1 text-right text-sm text-foreground">
                    {quickLaunchLabel}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2 px-4">
              <QuickActionCard
                title="New conversation"
                description="Bring Agora forward and open a fresh chat instantly."
                accent="linear-gradient(135deg, rgba(217,119,87,0.35), rgba(255,244,230,0.88))"
                icon={SquarePen}
                onClick={() => void runBackgroundAction('new-conversation')}
              />
              <QuickActionCard
                title="Open Agora"
                description="Return to the full workspace without starting a new chat."
                accent="linear-gradient(135deg, rgba(56,152,236,0.18), rgba(240,247,255,0.92))"
                icon={ArrowUpRight}
                onClick={() => void runBackgroundAction('open-agora')}
              />
              <QuickActionCard
                title="Settings"
                description="Jump straight into configuration and background preferences."
                accent="linear-gradient(135deg, rgba(20,20,19,0.09), rgba(255,255,255,0.86))"
                icon={Settings}
                onClick={() => void runBackgroundAction('open-settings')}
              />
            </div>

            <div className="mt-3 px-4 pb-4">
              <div
                className="rounded-[22px] border border-border/80 bg-background/82 px-4 py-3.5"
                style={{
                  boxShadow:
                    '0 0 0 1px color-mix(in oklab, var(--border) 70%, transparent)',
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Command className="size-4" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm text-foreground">Double Option quick launch</div>
                        <div className="mt-1 text-xs leading-5 text-muted-foreground">
                          Tap <kbd className="rounded bg-card px-1.5 py-0.5 text-[11px]">Option</kbd>{' '}
                          twice to bring Agora forward and start fresh.
                        </div>
                      </div>

                      <Toggle
                        checked={globalSettings.quickLaunchEnabled}
                        disabled={!settingsReady || savingQuickLaunch}
                        onCheckedChange={(checked) => {
                          void handleQuickLaunchToggle(checked);
                        }}
                        className="mt-0.5"
                      />
                    </div>

                    <div className="mt-3 rounded-2xl bg-card/80 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                      <div className="flex items-center gap-1.5 text-foreground/85">
                        <Sparkles className="size-3.5 text-primary" />
                        Background status
                      </div>
                      <div className="mt-1.5">
                        {backgroundStatus?.quickLaunchMessage ??
                          'Background status will appear here after launch.'}
                      </div>
                      {backgroundStatus?.quickLaunchRequiresPermission && (
                        <div className="mt-1 text-[11px] text-primary">
                          Permission may be required in macOS privacy settings.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                <div>Press Esc to close</div>
                <button
                  type="button"
                  onClick={() => void runBackgroundAction('quit')}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors hover:bg-background hover:text-foreground"
                >
                  <Power className="size-3.5" />
                  Quit Agora
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Toaster position="top-center" />
    </>
  );
}

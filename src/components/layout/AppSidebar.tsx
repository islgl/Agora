import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  PanelLeft,
  Search,
  Settings,
  Sun,
  Moon,
  SquarePen,
  SlidersHorizontal,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect } from 'react';
import { ConversationList } from './ConversationList';
import { SelectionBar } from './SelectionBar';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';

interface AppSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Card metrics — header is sized + offset so that its icons share a
// horizontal centreline with the native macOS traffic lights
// (trafficLightPosition y=29 in tauri.conf.json → visible centre ≈ window
// y=29). Icon centre = CARD_TOP_PX + HEADER_HEIGHT_PX / 2.
const CARD_TOP_PX = 7;
const HEADER_HEIGHT_PX = 44;

export function AppSidebar({ open, onOpenChange }: AppSidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const {
    startNewConversation,
    conversations,
    selectionMode,
    enterSelectionMode,
    exitSelectionMode,
  } = useChatStore();
  const { activeModelId } = useSettingsStore();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Esc exits selection mode for quick cancellation.
  useEffect(() => {
    if (!selectionMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitSelectionMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectionMode, exitSelectionMode]);

  const filteredIds = (search.trim()
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(search.toLowerCase())
      )
    : conversations
  ).map((c) => c.id);

  const handleNew = () => {
    void startNewConversation(activeModelId ?? '');
  };

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  const iconClass =
    'size-7 rounded-lg text-muted-foreground hover:text-foreground ' +
    'hover:bg-[var(--titlebar-hover)] transition-colors';

  return (
    <>
      <aside
        aria-hidden={!open}
        data-chat-print="hide"
        className={`fixed left-2 bottom-2 z-40 w-60 flex flex-col overflow-hidden
                    rounded-[10px] border border-sidebar-border
                    bg-sidebar/70 backdrop-blur-xl backdrop-saturate-150
                    transition-transform duration-200 ease-out
                    ${open ? 'translate-x-0' : '-translate-x-[110%]'}`}
        style={{
          top: CARD_TOP_PX,
          boxShadow: '0 0 0 1px var(--sidebar-border), 0 10px 32px rgba(0,0,0,0.08)',
        }}
      >
        {/* Header row — icons align with traffic lights on y=22 */}
        <div
          data-tauri-drag-region
          className="relative shrink-0 flex items-center justify-end pr-1.5"
          style={{ height: HEADER_HEIGHT_PX }}
        >
          <div
            className="flex items-center gap-0.5"
            style={{ transform: 'translateY(-2px)' }}
          >
            <Button
              variant="ghost"
              size="icon"
              className={iconClass}
              onClick={handleNew}
              title="New conversation (⌘N)"
            >
              <SquarePen className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={iconClass}
              onClick={() => (selectionMode ? exitSelectionMode() : enterSelectionMode())}
              title={selectionMode ? 'Exit selection' : 'Select conversations'}
            >
              <SlidersHorizontal className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={iconClass}
              onClick={toggleTheme}
              title="Toggle theme"
            >
              {mounted && resolvedTheme === 'dark' ? (
                <Sun className="size-3.5" />
              ) : (
                <Moon className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={iconClass}
              onClick={() => onOpenChange(false)}
              title="Collapse sidebar (⌘B)"
            >
              <PanelLeft className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Search OR selection bar */}
        {selectionMode ? (
          <SelectionBar visibleIds={filteredIds} />
        ) : (
          <div className="px-3 pb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm bg-sidebar-accent border-transparent rounded-lg
                           placeholder:text-muted-foreground text-sidebar-foreground
                           focus-visible:ring-0 focus-visible:border-ring"
              />
            </div>
          </div>
        )}

        {/* Conversation list */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2">
          <ConversationList search={search} />
        </div>

        {/* Footer */}
        <div className="px-2 py-3 border-t border-sidebar-border">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-sidebar-foreground
                       hover:bg-sidebar-accent rounded-lg h-9"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4" />
            <span className="text-sm">Settings</span>
          </Button>
        </div>
      </aside>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

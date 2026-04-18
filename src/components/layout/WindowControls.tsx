import { Button } from '@/components/ui/button';
import { PanelLeft } from 'lucide-react';

interface WindowControlsProps {
  onOpenSidebar: () => void;
}

// Shown when the sidebar is collapsed — just the re-open button on the left,
// tucked right after the native macOS traffic lights. Everything else lives
// inside the sidebar card when it's open.
const EXPAND_BUTTON_LEFT_PX = 92; // sits past the traffic-light cluster

export function WindowControls({ onOpenSidebar }: WindowControlsProps) {
  return (
    <div data-chat-print="hide">
      {/* Draggable strip across the top so the frameless window stays movable. */}
      <div
        data-tauri-drag-region
        className="fixed top-0 left-0 right-0 h-11 z-30 pointer-events-auto"
      />

      {/* Single expand button, nudged 2 px above the traffic-light centreline. */}
      <div
        className="fixed z-40 flex items-center"
        style={{
          left: EXPAND_BUTTON_LEFT_PX,
          top: 27,
          transform: 'translateY(-50%)',
        }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg text-muted-foreground hover:text-foreground
                     hover:bg-[var(--titlebar-hover)] transition-colors"
          onClick={onOpenSidebar}
          title="Open sidebar (⌘B)"
        >
          <PanelLeft className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

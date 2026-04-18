import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  FileDown,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Printer,
  Share2,
  Trash2,
} from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { isMacOS } from '@/lib/platform';
import type { Conversation } from '@/types';

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
}

export function ConversationItem({ conversation, isActive }: ConversationItemProps) {
  const {
    setCurrentConversation,
    deleteConversation,
    renameConversation,
    setConversationPinned,
  } = useChatStore();
  const selectionMode = useChatStore((s) => s.selectionMode);
  const selected = useChatStore((s) => s.selectedIds.has(conversation.id));
  const toggleSelected = useChatStore((s) => s.toggleSelected);

  const handleExportMarkdown = async () => {
    try {
      const path = await invoke<string | null>(
        'export_conversation_markdown',
        { conversationId: conversation.id }
      );
      if (path) toast.success(`Exported to ${path}`);
    } catch (err) {
      toast.error(`Export failed: ${err}`);
    }
  };

  const handleExportPdf = async () => {
    // Paint the conversation into the hidden PrintOverlay so that WKWebView's
    // native PDF capture sees the right content (not the sidebar + current
    // chat). Then measure the document's full scroll size and ask the
    // backend to rasterise that whole rect — otherwise Apple's default
    // behaviour captures only the visible viewport.
    const { setPrintOverlayId } = useChatStore.getState();
    setPrintOverlayId(conversation.id);

    // Wait for React to paint and for async passes like Shiki / Mermaid /
    // KaTeX to settle. 500ms covers the common case; very long threads may
    // need a touch more, but we trade completeness for a snappier flow.
    await new Promise((r) => setTimeout(r, 500));

    const contentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    );
    const contentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );

    try {
      const path = await invoke<string | null>('save_conversation_pdf', {
        conversationId: conversation.id,
        contentWidth,
        contentHeight,
      });
      if (path) toast.success(`Saved to ${path}`);
    } catch (err) {
      toast.error(`Export failed: ${err}`);
    } finally {
      setPrintOverlayId(null);
    }
  };

  const handleShare = async () => {
    try {
      await invoke('share_conversation', { conversationId: conversation.id });
    } catch (err) {
      toast.error(`Share failed: ${err}`);
    }
  };
  const isStreaming = useChatStore(
    (s) => Boolean(s.activeStreams[conversation.id])
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      renameConversation(conversation.id, trimmed);
    }
    setIsRenaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Skip Enter while an IME is composing — that keystroke confirms the
    // candidate, not the rename.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') handleRenameSubmit();
    if (e.key === 'Escape') {
      setRenameValue(conversation.title);
      setIsRenaming(false);
    }
  };

  const activeClass = selectionMode
    ? selected
      ? 'bg-primary/10 text-sidebar-foreground'
      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60'
    : isActive
    ? 'bg-sidebar-accent text-sidebar-foreground'
    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground';

  return (
    <li className="list-none">
      <div
        className={`group/item flex items-center rounded-lg h-9 transition-colors ${activeClass}`}
      >
        {selectionMode && (
          <Checkbox
            checked={selected}
            onCheckedChange={() => toggleSelected(conversation.id)}
            aria-label={`Select ${conversation.title}`}
            className="ml-2"
          />
        )}
        {isRenaming ? (
          <Input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleKeyDown}
            className="flex-1 h-6 text-sm border-none bg-transparent px-2 focus-visible:ring-0"
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() =>
                selectionMode
                  ? toggleSelected(conversation.id)
                  : setCurrentConversation(conversation.id)
              }
              className="flex-1 min-w-0 h-full px-2 text-left text-sm truncate flex items-center gap-1.5"
            >
              {isStreaming && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse"
                  aria-label="Streaming"
                  title="Streaming"
                />
              )}
              {conversation.pinned && !isStreaming && (
                <Pin
                  className="size-3 shrink-0 text-muted-foreground fill-current"
                  aria-label="Pinned"
                />
              )}
              <span className="truncate">{conversation.title}</span>
            </button>
            {!selectionMode && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="opacity-0 group-hover/item:opacity-100 p-0.5 mr-1 rounded-md
                           hover:bg-sidebar-accent text-muted-foreground transition-opacity"
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="right">
                <DropdownMenuItem
                  onClick={() =>
                    setConversationPinned(conversation.id, !conversation.pinned)
                  }
                >
                  {conversation.pinned ? (
                    <>
                      <PinOff className="size-3.5 mr-2" />
                      Unpin
                    </>
                  ) : (
                    <>
                      <Pin className="size-3.5 mr-2" />
                      Pin
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setRenameValue(conversation.title);
                    setIsRenaming(true);
                  }}
                >
                  <Pencil className="size-3.5 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleExportMarkdown()}>
                  <FileDown className="size-3.5 mr-2" />
                  Export as Markdown…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportPdf}>
                  <Printer className="size-3.5 mr-2" />
                  Export as PDF…
                </DropdownMenuItem>
                {isMacOS && (
                  <DropdownMenuItem onClick={() => void handleShare()}>
                    <Share2 className="size-3.5 mr-2" />
                    Share…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => deleteConversation(conversation.id)}
                >
                  <Trash2 className="size-3.5 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </>
        )}
      </div>
    </li>
  );
}

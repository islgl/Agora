import { toast } from 'sonner';
import { Pin, Trash2, X } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';

interface SelectionBarProps {
  visibleIds: string[];
}

/**
 * Replaces the search row + floats above the list when `selectionMode` is on.
 * Shows the count, bulk actions (pin, delete), and an Exit button.
 */
export function SelectionBar({ visibleIds }: SelectionBarProps) {
  const {
    selectedIds,
    selectAllVisible,
    exitSelectionMode,
    bulkDelete,
    bulkSetPinned,
    conversations,
  } = useChatStore();

  const count = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  // If every selected convo is already pinned, the action becomes "Unpin".
  const allPinned =
    count > 0 &&
    Array.from(selectedIds).every(
      (id) => conversations.find((c) => c.id === id)?.pinned
    );

  const handleDelete = async () => {
    if (count === 0) return;
    if (!confirm(`Delete ${count} conversation${count === 1 ? '' : 's'}?`)) return;
    try {
      await bulkDelete();
      toast.success(`Deleted ${count}`);
    } catch (err) {
      toast.error(`Delete failed: ${err}`);
    }
  };

  const handleTogglePin = async () => {
    if (count === 0) return;
    try {
      await bulkSetPinned(!allPinned);
      toast.success(allPinned ? `Unpinned ${count}` : `Pinned ${count}`);
    } catch (err) {
      toast.error(`Pin failed: ${err}`);
    }
  };

  const iconBtn =
    'size-7 rounded-md flex items-center justify-center text-muted-foreground ' +
    'hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors ' +
    'disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div className="px-3 pb-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() =>
            allSelected ? selectAllVisible([]) : selectAllVisible(visibleIds)
          }
          className="text-xs text-muted-foreground hover:text-sidebar-foreground"
        >
          {allSelected ? 'Clear' : 'Select all'}
        </button>
        <span className="text-xs text-sidebar-foreground tabular-nums">
          {count} selected
        </span>
        <button
          type="button"
          onClick={exitSelectionMode}
          className={iconBtn}
          title="Exit selection"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void handleTogglePin()}
          disabled={count === 0}
          className={iconBtn}
          title={allPinned ? 'Unpin' : 'Pin'}
        >
          <Pin className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={count === 0}
          className="size-7 rounded-md flex items-center justify-center text-muted-foreground
                     hover:text-destructive hover:bg-destructive/10 transition-colors
                     disabled:opacity-40 disabled:pointer-events-none"
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

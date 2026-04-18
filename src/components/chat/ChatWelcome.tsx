import { HandWrittenTitle } from '@/components/ui/hand-written-title';

/**
 * Shared empty-state shown both on first app load (no conversation selected)
 * and when the user starts a fresh conversation (⌘N). Keeps a single source
 * of truth for the welcome copy and layout so the two paths look identical.
 */
export function ChatWelcome() {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-4">
      <HandWrittenTitle
        title="How can I help?"
        subtitle="Start a conversation below"
      />
    </div>
  );
}

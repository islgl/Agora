import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useBrandStore } from '@/store/brandStore';
import type { BrandEditableFile, BrandSection } from '@/types';

interface RememberResult {
  written: boolean;
  file: string;
  reason: string | null;
}

interface BrandLineListProps {
  file: BrandEditableFile;
  section: BrandSection;
  placeholder?: string;
  emptyMessage?: string;
  addLabel?: string;
  forgetAriaLabel?: string;
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '');
}

interface Entry {
  rawLine: string;
  display: string;
}

function isDivider(line: string): boolean {
  // `---` on its own (optionally with trailing whitespace) is the
  // convention separating template/default content from user-authored
  // content. Matches both `---` and `----` etc.
  return /^-{3,}\s*$/.test(line);
}

/**
 * Extract the user-authored lines from a Brand file.
 *
 * Convention: everything *after* the last `---` divider is the user's
 * custom section. If the file has no divider, every non-empty
 * non-heading line counts — this covers files like USER.md that don't
 * ship with a template and are user-only from line one.
 */
function extractLines(content: string): Entry[] {
  const allLines = content.split('\n');
  const lastDividerIdx = (() => {
    for (let i = allLines.length - 1; i >= 0; i--) {
      if (isDivider(allLines[i])) return i;
    }
    return -1;
  })();
  const userLines =
    lastDividerIdx >= 0 ? allLines.slice(lastDividerIdx + 1) : allLines;
  return userLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((rawLine) => ({ rawLine, display: stripBullet(rawLine) }));
}

/**
 * Generic list-based editor for a single Brand file. Each entry is one
 * bulleted line; add / delete round-trip through `append_to_memory` and
 * `delete_memory_line`, so the secret denylist and dedup still apply.
 *
 * Used anywhere the raw file contents would be too technical to show —
 * the user adds short directives, the file on disk stays a plain
 * bulleted markdown list that the model reads from `<brand>` directly.
 */
export function BrandLineList({
  file,
  section,
  placeholder,
  emptyMessage = "Nothing here yet. Add one below.",
  addLabel = 'Add',
  forgetAriaLabel = 'Forget this',
}: BrandLineListProps) {
  const refresh = useBrandStore((s) => s.refresh);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const entries = extractLines(section.content);

  const add = async () => {
    const content = input.trim();
    if (!content) return;
    setAdding(true);
    try {
      const result = await invoke<RememberResult>('append_to_memory', {
        file,
        content,
      });
      if (result.written) {
        setInput('');
        await refresh();
      } else {
        toast.error(result.reason ?? "Couldn't save that one");
      }
    } catch (err) {
      toast.error(`Add failed: ${String(err)}`);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (rawLine: string) => {
    setDeleting(rawLine);
    try {
      const ok = await invoke<boolean>('delete_memory_line', {
        file,
        line: rawLine,
      });
      if (!ok) {
        toast.error('Already gone — refresh and try again');
      }
      await refresh();
    } catch (err) {
      toast.error(`Delete failed: ${String(err)}`);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3">
      {entries.length === 0 ? (
        <div
          className="rounded-lg bg-card px-3 py-3 text-[12px] text-muted-foreground"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          {emptyMessage}
        </div>
      ) : (
        <ul
          className="divide-y divide-border/60 rounded-lg bg-card"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          {entries.map((entry) => (
            <li
              key={entry.rawLine}
              className="group flex items-start gap-2 px-3 py-2.5 text-[13px] leading-relaxed"
            >
              <span className="flex-1 min-w-0 break-words text-foreground">
                {entry.display}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => void remove(entry.rawLine)}
                disabled={deleting === entry.rawLine}
                aria-label={forgetAriaLabel}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void add()}
          disabled={!input.trim() || adding}
        >
          {adding ? 'Adding…' : addLabel}
        </Button>
      </div>
    </div>
  );
}

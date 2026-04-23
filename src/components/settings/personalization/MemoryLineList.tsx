import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSubsection } from '@/components/settings/SettingsSection';
import { Toggle } from '@/components/ui/toggle';
import { classifyMemoryContent } from '@/lib/ai/classify-memory';
import { useBrandStore } from '@/store/brandStore';
import { useSettingsStore } from '@/store/settingsStore';

interface RememberResult {
  written: boolean;
  file: string;
  reason: string | null;
}

interface AutoMemoryRow {
  id: string;
  text: string;
  createdAt: number;
}

type MarkdownSource = 'MEMORY.md' | 'TOOLS.md';

interface MarkdownEntry {
  kind: 'markdown';
  source: MarkdownSource;
  // The exact line as stored on disk (with leading `- `), used as the
  // delete key so we can round-trip through delete_memory_line.
  rawLine: string;
  // The text shown to the user, bullet stripped.
  display: string;
}

interface AutoEntry {
  kind: 'auto';
  id: string;
  display: string;
  createdAt: number;
}

type MemoryEntry = MarkdownEntry | AutoEntry;

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '');
}

function extractLines(content: string, source: MarkdownSource): MarkdownEntry[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((rawLine) => ({
      kind: 'markdown' as const,
      source,
      rawLine,
      display: stripBullet(rawLine),
    }));
}

export function MemoryLineList() {
  const memory = useBrandStore((s) => s.payload.memory);
  const tools = useBrandStore((s) => s.payload.tools);
  const refresh = useBrandStore((s) => s.refresh);

  const autoMemoryEnabled = useSettingsStore(
    (s) => s.globalSettings.autoMemoryEnabled,
  );
  const saveGlobalSettings = useSettingsStore((s) => s.saveGlobalSettings);

  const [autoRows, setAutoRows] = useState<AutoMemoryRow[]>([]);
  const [loadingAuto, setLoadingAuto] = useState(true);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await invoke<
          { id: string; text: string; createdAt: number }[]
        >('list_auto_memory', { limit: 200 });
        if (!cancelled) {
          setAutoRows(rows);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(`Couldn't load memories: ${String(err)}`);
        }
      } finally {
        if (!cancelled) setLoadingAuto(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const entries: MemoryEntry[] = useMemo(() => {
    const mdEntries: MemoryEntry[] = [
      ...extractLines(memory.content, 'MEMORY.md'),
      ...extractLines(tools.content, 'TOOLS.md'),
    ];
    const autoEntries: MemoryEntry[] = autoRows
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        kind: 'auto' as const,
        id: r.id,
        display: r.text,
        createdAt: r.createdAt,
      }));
    return [...mdEntries, ...autoEntries];
  }, [memory.content, tools.content, autoRows]);

  const entryKey = (e: MemoryEntry): string =>
    e.kind === 'markdown' ? `${e.source}:${e.rawLine}` : `auto:${e.id}`;

  const add = async () => {
    const content = input.trim();
    if (!content) return;
    setAdding(true);
    try {
      // Optimistic: write to MEMORY.md first so the user sees it in the
      // list immediately. A background classifier then decides whether
      // it belongs under USER / TOOLS / SOUL — if so, we move it
      // silently. MEMORY.md is an unclassified inbox by design; the
      // chat remember tool treats it the same way.
      const result = await invoke<RememberResult>('append_to_memory', {
        file: 'MEMORY.md',
        content,
      });
      if (!result.written) {
        toast.error(result.reason ?? "Couldn't save that one");
        return;
      }
      setInput('');
      await refresh();
      void reclassifyInBackground(content);
    } catch (err) {
      toast.error(`Add failed: ${String(err)}`);
    } finally {
      setAdding(false);
    }
  };

  const reclassifyInBackground = async (content: string) => {
    let target;
    try {
      target = await classifyMemoryContent(content);
    } catch (err) {
      console.warn('classify failed', err);
      return;
    }
    if (target === 'MEMORY.md') return;

    // The writer stores lines with a `- ` bullet prefix (see
    // memory_active.rs::append_line), so round-trip the delete with the
    // canonical form.
    const bulletForm = `- ${content}`;
    try {
      const removed = await invoke<boolean>('delete_memory_line', {
        file: 'MEMORY.md',
        line: bulletForm,
      });
      if (!removed) return;
      await invoke<RememberResult>('append_to_memory', {
        file: target,
        content,
      });
      await refresh();
    } catch (err) {
      console.warn('reclassify move failed', err);
    }
  };

  const remove = async (entry: MemoryEntry) => {
    const key = entryKey(entry);
    setDeletingKey(key);
    try {
      if (entry.kind === 'markdown') {
        const ok = await invoke<boolean>('delete_memory_line', {
          file: entry.source,
          line: entry.rawLine,
        });
        if (!ok) {
          toast.error('Already gone — refresh and try again');
        }
        await refresh();
      } else {
        const ok = await invoke<boolean>('delete_auto_memory', { id: entry.id });
        if (ok) {
          setAutoRows((prev) => prev.filter((r) => r.id !== entry.id));
        } else {
          toast.error('Already gone — refresh and try again');
        }
      }
    } catch (err) {
      toast.error(`Delete failed: ${String(err)}`);
    } finally {
      setDeletingKey(null);
    }
  };

  const toggleAutoMemory = async (checked: boolean) => {
    const latest = useSettingsStore.getState().globalSettings;
    try {
      await saveGlobalSettings({ ...latest, autoMemoryEnabled: checked });
    } catch (err) {
      toast.error(String(err));
    }
  };

  const showEmpty = !loadingAuto && entries.length === 0;

  return (
    <div className="space-y-3">
      {loadingAuto && entries.length === 0 ? (
        <div
          className="rounded-lg bg-card px-3 py-3 text-[12px] text-muted-foreground"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          Loading…
        </div>
      ) : showEmpty ? (
        <div
          className="rounded-lg bg-card px-3 py-3 text-[12px] text-muted-foreground"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          Agora doesn't remember anything yet. Tell it something below.
        </div>
      ) : (
        <ul
          className="divide-y divide-border/60 rounded-lg bg-card"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          {entries.map((entry) => {
            const key = entryKey(entry);
            return (
              <li
                key={key}
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
                  onClick={() => void remove(entry)}
                  disabled={deletingKey === key}
                  aria-label="Forget this"
                >
                  <Trash2 />
                </Button>
              </li>
            );
          })}
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
          placeholder="Something you'd like Agora to remember…"
          className="flex-1"
        />
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void add()}
          disabled={!input.trim() || adding}
        >
          {adding ? 'Adding…' : 'Add'}
        </Button>
      </div>

      <SettingsSubsection
        title="Auto-memory"
        description="Runs after each turn. Extracts short factual lines and embeds them for later recall."
      >
        <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px] text-muted-foreground">
          <span>Let Agora remember things on its own</span>
          <Toggle
            checked={autoMemoryEnabled}
            onCheckedChange={(checked) => void toggleAutoMemory(checked)}
          />
        </label>
      </SettingsSubsection>
    </div>
  );
}

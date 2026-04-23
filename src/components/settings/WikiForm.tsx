import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, RefreshCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { triggerIngest } from '@/lib/ai/wiki-ingest';
import { useWikiStore } from '@/store/wikiStore';
import { SettingsPage } from './SettingsPage';
import { SettingsSection } from './SettingsSection';
import type { WikiPage } from '@/types';

interface RawFile {
  relPath: string;
  absPath: string;
  sizeBytes: number;
  modifiedAt: number;
  supported: boolean;
}

function deriveKind(relPath: string): string {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'md';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  return '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KNOWN_CATEGORIES = ['concepts', 'projects', 'domains'] as const;
const TAG_DISPLAY_LIMIT = 12;

function groupByCategory(pages: WikiPage[]): Record<string, WikiPage[]> {
  const groups: Record<string, WikiPage[]> = {};
  for (const p of pages) {
    const key = p.category ?? 'uncategorized';
    (groups[key] ??= []).push(p);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }
  return groups;
}

function topTags(pages: WikiPage[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function formatCategory(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function orderedCategories(groups: Record<string, WikiPage[]>): string[] {
  const present = new Set(Object.keys(groups));
  const ordered = KNOWN_CATEGORIES.filter((c) => present.has(c));
  const extras = [...present]
    .filter((c) => !KNOWN_CATEGORIES.includes(c as (typeof KNOWN_CATEGORIES)[number]))
    .sort();
  return [...ordered, ...extras];
}

export function WikiForm() {
  const pages = useWikiStore((s) => s.pages);
  const refresh = useWikiStore((s) => s.refresh);
  const deletePage = useWikiStore((s) => s.deletePage);

  const [rawFiles, setRawFiles] = useState<RawFile[]>([]);
  const [triggering, setTriggering] = useState<string | null>(null);

  const refreshRaw = async () => {
    try {
      const files = await invoke<RawFile[]>('list_raw_files');
      setRawFiles(files);
    } catch (err) {
      console.warn('list_raw_files failed', err);
      setRawFiles([]);
    }
  };

  useEffect(() => {
    void refresh();
    void refreshRaw();
  }, [refresh]);

  const groups = useMemo(() => groupByCategory(pages), [pages]);
  const tags = useMemo(() => topTags(pages, TAG_DISPLAY_LIMIT), [pages]);
  const categoryOrder = useMemo(() => orderedCategories(groups), [groups]);

  // Wiki pages record their source file paths like `raw/foo.pdf`;
  // list_raw_files returns relPath like `foo.pdf`. Normalize both sides
  // to the bare relPath for the ingested-or-not lookup.
  const ingestedSet = useMemo(() => {
    const set = new Set<string>();
    for (const p of pages) {
      for (const src of p.sources) {
        set.add(src.replace(/^raw\//, ''));
      }
    }
    return set;
  }, [pages]);

  const handleDelete = async (page: WikiPage) => {
    const ok = window.confirm(
      `Delete "${page.title}"? This removes the wiki page only — the source file in raw/ is untouched.`,
    );
    if (!ok) return;
    try {
      await deletePage(page.relPath);
      toast.success('Page deleted');
    } catch (err) {
      toast.error(`Delete failed: ${String(err)}`);
    }
  };

  const handleIngest = async (file: RawFile) => {
    setTriggering(file.relPath);
    try {
      await triggerIngest({
        relPath: file.relPath,
        absPath: file.absPath,
        kind: deriveKind(file.relPath),
        supported: file.supported,
      });
      // triggerIngest already refreshes wikiStore internally on success;
      // repeat here so a failed ingest still re-reads the raw list.
      await refreshRaw();
    } catch (err) {
      toast.error(`Ingest failed: ${String(err)}`);
    } finally {
      setTriggering(null);
    }
  };

  return (
    <SettingsPage
      title="Wiki"
      description="Structured knowledge Agora generates from files you drop into ~/.agora/raw/. Each page links back to its source so you can trace what came from where."
    >
      {pages.length === 0 && rawFiles.length === 0 ? (
        <div
          className="rounded-lg bg-card px-3 py-3 text-[12px] text-muted-foreground"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          No wiki pages yet. Drop a Markdown, PDF, HTML, or text file into <code className="font-mono text-[11px]">~/.agora/raw/</code> to trigger ingest.
        </div>
      ) : (
        <>
          {pages.length > 0 && (
          <SettingsSection
            title="At a glance"
            description="Overview of what Agora has read and organized."
          >
            <div
              className="space-y-3 rounded-lg bg-card px-3 py-3"
              style={{ boxShadow: '0 0 0 1px var(--border)' }}
            >
              <div className="text-[12px] text-foreground">
                {pages.length} {pages.length === 1 ? 'page' : 'pages'} across{' '}
                {categoryOrder.map((c, i) => (
                  <span key={c}>
                    {i > 0 && ', '}
                    <span className="text-foreground">
                      {groups[c].length}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      {formatCategory(c).toLowerCase()}
                    </span>
                  </span>
                ))}
              </div>
              {tags.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    Top tags
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map(([tag, count]) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground"
                      >
                        {tag}
                        <span className="text-muted-foreground">·{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SettingsSection>
          )}

          {rawFiles.length > 0 && (
            <SettingsSection
              title="Raw inbox"
              description="Files in ~/.agora/raw/ that Agora can read. New drops ingest automatically; click Re-ingest to regenerate a page."
            >
              <ul
                className="divide-y divide-border/60 rounded-lg bg-card"
                style={{ boxShadow: '0 0 0 1px var(--border)' }}
              >
                {rawFiles.map((file) => {
                  const ingested = ingestedSet.has(file.relPath);
                  const busy = triggering === file.relPath;
                  return (
                    <li
                      key={file.relPath}
                      className="flex items-center gap-2 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-foreground">
                          {file.relPath}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatBytes(file.sizeBytes)}
                          {' · '}
                          {!file.supported
                            ? 'unsupported format'
                            : ingested
                              ? 'ingested'
                              : 'not ingested'}
                        </div>
                      </div>
                      {file.supported && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => void handleIngest(file)}
                          disabled={busy}
                        >
                          {busy ? (
                            'Working…'
                          ) : (
                            <>
                              <RefreshCcw />
                              {ingested ? 'Re-ingest' : 'Ingest'}
                            </>
                          )}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </SettingsSection>
          )}

          {categoryOrder.map((category) => (
            <SettingsSection
              key={category}
              title={formatCategory(category)}
              description={`${groups[category].length} ${groups[category].length === 1 ? 'page' : 'pages'}`}
            >
              <ul
                className="divide-y divide-border/60 rounded-lg bg-card"
                style={{ boxShadow: '0 0 0 1px var(--border)' }}
              >
                {groups[category].map((page) => (
                  <PageRow
                    key={page.relPath}
                    page={page}
                    onDelete={() => void handleDelete(page)}
                  />
                ))}
              </ul>
            </SettingsSection>
          ))}
        </>
      )}
    </SettingsPage>
  );
}

interface PageRowProps {
  page: WikiPage;
  onDelete: () => void;
}

function PageRow({ page, onDelete }: PageRowProps) {
  return (
    <li className="group flex items-start gap-2 px-3 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-sm text-foreground">{page.title}</div>
        {page.summary && (
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            {page.summary}
          </div>
        )}
        {page.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {page.tags.map((t) => (
              <span
                key={t}
                className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {page.sources.length > 0 && (
          <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <FileText className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="text-muted-foreground/80">From: </span>
              {page.sources.join(', ')}
            </span>
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="opacity-0 transition-opacity group-hover:opacity-100"
        onClick={onDelete}
        aria-label="Delete page"
      >
        <Trash2 />
      </Button>
    </li>
  );
}

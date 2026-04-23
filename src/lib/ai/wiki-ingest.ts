import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useSettingsStore } from '@/store/settingsStore';
import { useWikiStore } from '@/store/wikiStore';
import { spawnSubagent, snapshotSubagent } from '@/lib/ai/subagent';
import { loadWikiIngestTools } from '@/lib/ai/tools';

/**
 * Phase 4 · Raw Layer auto-ingest pipeline.
 *
 * The Rust watcher (`wiki_watcher.rs`) emits `wiki-ingest-request`
 * whenever a file lands under ~/.agora/raw/. We:
 *   1. Extract text from the file (markdown / pdf / html / txt).
 *   2. Spawn a background subagent with the wiki-ingest toolset and a
 *      system prompt that spells out the output format.
 *   3. Wait for the subagent to finish, then refresh the wiki store so
 *      the new page shows up in the UI.
 *
 * The whole flow is fire-and-forget from the user's perspective — they
 * see a toast when a page is created, and the page appears in the Wiki
 * Settings tab when they next open it.
 */

export interface IngestRequest {
  relPath: string;
  absPath: string;
  kind: string;
  supported: boolean;
}

/**
 * Imperative entry point mirroring the file-watcher event path. Use this
 * from the UI when the user wants to re-run ingest on an existing raw
 * file, or ingest a pre-existing file the watcher never saw (app start
 * does not retroactively ingest). Identical semantics to the auto-path:
 * same subagent, same inFlight dedup, same toasts, same wikiStore
 * refresh.
 */
export async function triggerIngest(req: IngestRequest): Promise<void> {
  return handleRequest(req);
}

interface ExtractedText {
  relPath: string;
  text: string;
  truncated: boolean;
  kind: string;
}

/**
 * De-dupe in-flight requests — the watcher debounces at the OS layer,
 * but tab-focus-driven re-renders can also re-subscribe, so we track
 * per-file "already running" state here.
 */
const inFlight = new Set<string>();

let unlisten: UnlistenFn | null = null;

/** Subscribe to the ingest event bus. Safe to call more than once —
 *  subsequent calls are no-ops. */
export async function mountWikiIngest(): Promise<void> {
  if (unlisten) return;
  unlisten = await listen<IngestRequest>('wiki-ingest-request', (ev) => {
    void handleRequest(ev.payload);
  });
}

export function unmountWikiIngest(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  inFlight.clear();
}

async function handleRequest(req: IngestRequest): Promise<void> {
  if (!req.supported) {
    console.info(`[wiki-ingest] skipping unsupported file: ${req.relPath}`);
    return;
  }
  if (inFlight.has(req.relPath)) {
    console.info(`[wiki-ingest] already running for ${req.relPath}`);
    return;
  }

  const settings = useSettingsStore.getState();
  const modelConfig = settings.modelConfigs.find(
    (m) => m.id === settings.activeModelId,
  );
  if (!modelConfig || !settings.globalSettings.apiKey.trim()) {
    // No configured model = silently skip. We don't want to hassle the
    // user during onboarding.
    console.info('[wiki-ingest] no active model configured; skipping');
    return;
  }

  inFlight.add(req.relPath);
  try {
    const extracted = await invoke<ExtractedText>('extract_raw_text', {
      relPath: req.relPath,
    });
    if (!extracted.text.trim()) {
      toast.warning(`Empty text extracted from ${req.relPath}; skipping ingest`, {
        description:
          'The file may be a scanned PDF, a binary the extractor does not understand, or truly empty.',
      });
      return;
    }

    const resolved = settings.resolveModelConfig(modelConfig);
    const tools = await loadWikiIngestTools();
    const system = buildIngestSystemPrompt();
    const prompt = buildIngestPrompt(extracted);

    const { id, done } = spawnSubagent({
      description: `Ingest raw → wiki: ${req.relPath}`,
      prompt,
      system,
      tools,
      modelConfig: resolved,
      background: true,
    });

    toast.info(`Generating wiki page from ${req.relPath}…`);
    const result = await done;
    if (result) {
      toast.success(`Wiki updated from ${req.relPath}`);
    } else {
      // Dig the actual failure reason out of the subagent record — the
      // null-done case covers both `failed` (with an error message) and
      // `cancelled` (user pressed Stop). Distinguish them for the
      // toast so the user isn't left guessing what went wrong.
      const snap = snapshotSubagent(id);
      const reason =
        snap?.status === 'cancelled'
          ? 'cancelled'
          : snap?.error?.trim() || 'no output from subagent';
      toast.error(`Wiki ingest failed for ${req.relPath}`, {
        description: reason.length > 200 ? reason.slice(0, 200) + '…' : reason,
      });
    }
    // Refresh so the new page appears in the Wiki chip's selector on
    // the next turn, even on partial failure (some pages may have been
    // written before the run aborted).
    await useWikiStore.getState().refresh();
  } catch (err) {
    console.error('[wiki-ingest] pipeline error', err);
    toast.error(`Wiki ingest error: ${String(err)}`);
  } finally {
    inFlight.delete(req.relPath);
  }
}

function buildIngestSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Agora's Wiki maintainer subagent.

Mission: read a single raw-inbox file the user just dropped into
~/.agora/raw/ and produce (or update) a structured Wiki page under
~/.agora/wiki/.

Workflow:
1. Call \`list_wiki_pages\` to see what already exists. If an existing
   page covers the same topic, prefer \`read_wiki_page\` + \`write_wiki_page\`
   to MERGE / EXTEND that page rather than creating a near-duplicate.
2. Pick a category: \`concepts\` | \`projects\` | \`domains\`.
   Put new pages under \`wiki/{category}/{kebab-slug}.md\`.
3. The page MUST begin with YAML frontmatter:
   ---
   title: <concise human title>
   tags: [<3-6 short tags>]
   category: <concepts|projects|domains>
   summary: <3-5 sentence plain-language summary>
   updated_at: ${today}
   sources: [<"raw/..." paths or URLs from the source>]
   ---
4. Body layout (use these section headings, in English):
   ## Core concepts
   ## Key points
   ## Related — link related concepts using \`[[Title]]\` syntax
   ## Sources — bullet list of source paths / URLs
5. Keep the page <= 2000 words. Summaries over completeness.
6. After writing the page, call \`update_wiki_index\` exactly once to
   rebuild \`wiki/index.md\`.
7. Never fabricate sources or cross-links. Only \`[[Link]]\` to pages you
   verified exist via \`list_wiki_pages\`.

Output: your final text response must be ONE short sentence of the form
\`Generated wiki/<path>.md\` or \`Updated wiki/<path>.md\`. All actual
content goes through \`write_wiki_page\`.`;
}

function buildIngestPrompt(extracted: ExtractedText): string {
  const trunc = extracted.truncated
    ? '\n\n[Note: source was truncated at 512 KB; the tail is missing. If this seems to matter, call it out in the frontmatter summary.]'
    : '';
  return `Source file: raw/${extracted.relPath}
Format: ${extracted.kind}${trunc}

=== BEGIN CONTENT ===
${extracted.text}
=== END CONTENT ===

Ingest this into the Wiki.`;
}

/**
 * Canonical description of the 4 user-editable Brand files and what
 * each one is for.
 *
 * Single source of truth, referenced by:
 * - `appendBrandFileTool` description (`tools.ts`) — the chat remember
 *   tool, where the model picks `file` based on this taxonomy.
 * - `classifyMemoryContent` (`classify-memory.ts`) — the Settings UI
 *   Add classifier, same taxonomy used as a one-shot routing prompt.
 * - `runDreaming` prompt (`dreaming.ts`) — the nightly distillation's
 *   candidate router.
 *
 * Keep per-line phrasing concrete so the model doesn't have to guess on
 * borderline items (e.g. "be concise" → SOUL not USER).
 */

export interface BrandFileEntry {
  name: 'USER' | 'TOOLS' | 'SOUL' | 'MEMORY';
  description: string;
}

export const BRAND_FILE_TAXONOMY: readonly BrandFileEntry[] = [
  {
    name: 'USER',
    description: 'identity, name, title, timezone, ways to address them',
  },
  {
    name: 'TOOLS',
    description: 'tech stack, tooling preferences, CLI/editor/env choices',
  },
  {
    name: 'SOUL',
    description: 'communication / tone / style preferences ("be more concise")',
  },
  {
    name: 'MEMORY',
    description: 'everything else worth long-term recall',
  },
] as const;

export interface FormatTaxonomyOptions {
  /** `.md` to match on-disk file names, empty to just show the keys. */
  suffix?: '.md' | '';
  /** Prefix each bullet with this string — use for nested indentation. */
  indent?: string;
}

export function formatTaxonomy(opts: FormatTaxonomyOptions = {}): string {
  const suffix = opts.suffix ?? '';
  const indent = opts.indent ?? '';
  return BRAND_FILE_TAXONOMY.map(
    ({ name, description }) => `${indent}- ${name}${suffix}: ${description}`,
  ).join('\n');
}

import { generateText } from 'ai';
import { useSettingsStore } from '@/store/settingsStore';
import { modelForConfig } from './providers';
import { formatTaxonomy } from './brand-taxonomy';
import type { BrandEditableFile } from '@/types';

/**
 * Pick the right Brand file for a user-added memory line.
 *
 * Mirrors the classification the chat `remember` tool (`tools.ts:500-515`)
 * does implicitly via the LLM-in-the-turn, but for the Settings UI path
 * where there is no ambient turn to ride along.
 *
 * Failure modes (no active model, no API key, bad JSON, network error)
 * all fall back to `MEMORY.md` — the unclassified inbox — which is the
 * same place the chat tool lands anything it's unsure about, and what
 * Dreaming will later re-sort.
 */
export async function classifyMemoryContent(
  content: string,
): Promise<BrandEditableFile> {
  const trimmed = content.trim();
  if (!trimmed) return 'MEMORY.md';

  const settings = useSettingsStore.getState();
  const modelConfig = settings.modelConfigs.find(
    (m) => m.id === settings.activeModelId,
  );
  if (!modelConfig) return 'MEMORY.md';
  if (!settings.globalSettings.apiKey.trim()) return 'MEMORY.md';

  const resolved = settings.resolveModelConfig(modelConfig);

  const prompt = [
    'Classify the following memory line into one of four Brand files the assistant uses to persist knowledge about the user.',
    '',
    formatTaxonomy(),
    '',
    'Return JSON ONLY, no prose:',
    '{"target": "USER|TOOLS|SOUL|MEMORY"}',
    '',
    'Line:',
    trimmed,
  ].join('\n');

  try {
    const result = await generateText({
      model: modelForConfig(resolved),
      prompt,
      maxOutputTokens: 40,
    });
    return parseTarget(result.text);
  } catch (err) {
    console.warn('classifyMemoryContent failed', err);
    return 'MEMORY.md';
  }
}

function parseTarget(raw: string): BrandEditableFile {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return 'MEMORY.md';
  try {
    const parsed = JSON.parse(match[0]) as { target?: unknown };
    const target = typeof parsed.target === 'string' ? parsed.target.toUpperCase() : '';
    switch (target) {
      case 'USER':
        return 'USER.md';
      case 'TOOLS':
        return 'TOOLS.md';
      case 'SOUL':
        return 'SOUL.md';
      case 'MEMORY':
      default:
        return 'MEMORY.md';
    }
  } catch {
    return 'MEMORY.md';
  }
}

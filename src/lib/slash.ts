import type { ConversationMode } from '@/types';

/**
 * Shared parser for leading `/cmd` tokens on a user prompt. Used by both the
 * immediate-send path in `ChatInput` and the queued-send path in
 * `QueuedChips`, so `/plan write tests` behaves the same whether the user
 * sent it live or popped it off the queue minutes later.
 *
 * Only mode-switch commands are recognized today (`/chat`, `/plan`,
 * `/execute`). Any other `/foo` token is treated as literal text and
 * returned whole in `remainder`.
 */
export const SLASH_MODE: Record<string, ConversationMode> = {
  '/chat': 'chat',
  '/plan': 'plan',
  '/execute': 'execute',
};

export const SLASH_COMMANDS = [
  { command: '/chat', description: 'Switch to chat mode' },
  { command: '/plan', description: 'Switch to plan mode (readonly)' },
  {
    command: '/execute',
    description: 'Switch to execute mode (auto-allow writes)',
  },
];

export interface ParsedSlash {
  /** Mode to switch into, or null when the text has no mode-switch prefix. */
  mode: ConversationMode | null;
  /** Text that should be forwarded to the model after the mode switch. */
  remainder: string;
}

export function parseSlashMode(text: string): ParsedSlash {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\/\S+)(?:\s+([\s\S]+))?$/);
  if (!match) return { mode: null, remainder: trimmed };
  const mode = SLASH_MODE[match[1].toLowerCase()] ?? null;
  if (!mode) return { mode: null, remainder: trimmed };
  return { mode, remainder: match[2]?.trim() ?? '' };
}

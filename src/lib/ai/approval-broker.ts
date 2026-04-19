import type { ApprovalAnswer, ApprovalRequest } from '@/types';

/**
 * Module-level bridge between non-React modules (e.g. `tools.ts`) and the
 * React-rendered `<ApprovalGate />`. The gate registers a handler on mount;
 * tool execution calls `requestApproval()` and awaits the user's choice.
 *
 * We use a singleton rather than React context because the AI SDK's
 * `tool.execute` lives outside any component tree — it's a plain async
 * function constructed at turn start and passed to `streamText`.
 */

type Handler = (req: ApprovalRequest) => Promise<ApprovalAnswer>;

let currentHandler: Handler | null = null;

/** Requests that came in while no handler was mounted. Drained in FIFO
 *  order as soon as a handler is installed. This avoids spurious
 *  auto-denials when React StrictMode re-mounts `ApprovalGate` (which
 *  runs mount → cleanup → mount in dev) or when `ChatArea` swaps its
 *  welcome-vs-active branches and the cleanup of the old gate runs
 *  after the new one has already installed its handler. */
const pending: Array<{
  req: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
  reject: (err: unknown) => void;
}> = [];

export function setApprovalHandler(handler: Handler | null): void {
  currentHandler = handler;
  if (!handler || pending.length === 0) return;
  // Drain queued requests through the freshly-installed handler. Each
  // handler call may queue internally (the permissions store does FIFO),
  // so we just forward promises one-by-one without waiting.
  const drained = pending.splice(0);
  for (const p of drained) {
    handler(p.req).then(p.resolve, p.reject);
  }
}

/**
 * Clear the handler only if `handler` is still the current one. Used by
 * React cleanups so a lingering cleanup doesn't wipe a handler installed
 * by a newly-mounted component.
 */
export function clearApprovalHandlerIf(handler: Handler): void {
  if (currentHandler === handler) currentHandler = null;
}

export async function requestApproval(
  req: ApprovalRequest,
): Promise<ApprovalAnswer> {
  if (currentHandler) return currentHandler(req);
  // Queue until a handler shows up. Under StrictMode this is usually
  // microseconds; under the welcome→active branch swap it's at most a
  // single render pass.
  return new Promise<ApprovalAnswer>((resolve, reject) => {
    pending.push({ req, resolve, reject });
  });
}

/**
 * Pick a sensible default "save as" pattern for an approval. Users can
 * always widen it later in Settings → Permissions.
 *
 * - `bash` / `bash_background` → `<first_token> *` (e.g. "git status" → "git *")
 * - anything with a `path` input → the exact path
 * - fallback → empty pattern (matches every call to this tool)
 */
export function defaultPatternFor(tool: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (tool === 'bash' || tool === 'bash_background') {
    const cmd = typeof obj.command === 'string' ? obj.command.trim() : '';
    if (!cmd) return '';
    const head = cmd.split(/\s+/, 1)[0] ?? '';
    return head ? `${head} *` : '';
  }
  if (typeof obj.path === 'string' && obj.path.length > 0) {
    return obj.path;
  }
  if (typeof obj.cwd === 'string' && obj.cwd.length > 0) {
    return obj.cwd;
  }
  return '';
}

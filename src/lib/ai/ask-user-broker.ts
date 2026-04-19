import type { AskUserRequest } from '@/types';

/**
 * Module-level bridge between the `ask_user` tool and the React-rendered
 * `<AskUserGate />`. Mirrors `approval-broker.ts` — the gate registers a
 * handler on mount; `tool.execute` calls `requestAskUser()` and awaits the
 * user's answer text.
 */

type Handler = (req: AskUserRequest) => Promise<string>;

let currentHandler: Handler | null = null;

/** Requests queued while no handler was mounted — drained when one arrives.
 *  See the matching comment in `approval-broker.ts` for why the StrictMode
 *  and branch-swap cases make this important. */
const pending: Array<{
  req: AskUserRequest;
  resolve: (answer: string) => void;
  reject: (err: unknown) => void;
}> = [];

export function setAskUserHandler(handler: Handler | null): void {
  currentHandler = handler;
  if (!handler || pending.length === 0) return;
  const drained = pending.splice(0);
  for (const p of drained) {
    handler(p.req).then(p.resolve, p.reject);
  }
}

/** Only null the handler if `handler` is still the current one. */
export function clearAskUserHandlerIf(handler: Handler): void {
  if (currentHandler === handler) currentHandler = null;
}

export async function requestAskUser(req: AskUserRequest): Promise<string> {
  if (currentHandler) return currentHandler(req);
  return new Promise<string>((resolve, reject) => {
    pending.push({ req, resolve, reject });
  });
}

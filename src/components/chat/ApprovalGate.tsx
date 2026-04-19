import { useEffect } from 'react';
import { usePermissionsStore } from '@/store/permissionsStore';
import {
  setApprovalHandler,
  clearApprovalHandlerIf,
} from '@/lib/ai/approval-broker';
import { ApprovalPrompt } from './ApprovalPrompt';

/**
 * Wires the permissions store into the module-level approval broker that
 * `tools.ts` calls, and renders the inline prompt when one is pending.
 * Mount this once, near the chat area, above `<ChatInput />`.
 */
export function ApprovalGate() {
  const currentPrompt = usePermissionsStore((s) => s.currentPrompt);
  const queue = usePermissionsStore((s) => s.queue);
  const answerCurrent = usePermissionsStore((s) => s.answerCurrent);
  const requestApproval = usePermissionsStore((s) => s.requestApproval);
  const loadPermissions = usePermissionsStore((s) => s.loadPermissions);

  useEffect(() => {
    setApprovalHandler(requestApproval);
    void loadPermissions();
    // Identity-aware clear: only null the handler if we're still the one
    // that owns it. StrictMode's mount→cleanup→mount cycle and the
    // welcome↔active branch swap both run cleanups out of order with
    // new mounts; without this check a stale cleanup would wipe the
    // freshly-installed handler and the next tool call would auto-deny.
    return () => clearApprovalHandlerIf(requestApproval);
  }, [requestApproval, loadPermissions]);

  if (!currentPrompt) return null;
  return (
    <ApprovalPrompt
      request={currentPrompt}
      queueSize={queue.length}
      onAnswer={answerCurrent}
    />
  );
}

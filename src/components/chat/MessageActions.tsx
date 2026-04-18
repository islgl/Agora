import { Pencil, RotateCcw, Copy, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Message, ModelConfig } from '@/types';
import { useSettingsStore } from '@/store/settingsStore';
import { ProviderIcon } from '@/components/settings/ProviderIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface MessageActionsProps {
  message: Message;
  isStreaming: boolean;
  onEdit: () => void;
  onRegenerate: (modelConfigId?: string) => void;
  onSwitchBranch: (targetMessageId: string) => void;
}

export function MessageActions({
  message,
  isStreaming,
  onEdit,
  onRegenerate,
  onSwitchBranch,
}: MessageActionsProps) {
  const modelLabel = message.role === 'assistant' && message.modelName
    ? message.modelName
    : null;

  const tokenLabel = message.role === 'assistant'
    && (message.inputTokens || message.outputTokens)
    ? `${formatTokens(message.inputTokens ?? 0)} in · ${formatTokens(
        message.outputTokens ?? 0
      )} out`
    : null;
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const { modelConfigs, activeModelId } = useSettingsStore();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('Copy failed');
    }
  };

  const siblingNav = message.siblingCount > 1 && (
    <div className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
      <button
        type="button"
        onClick={() => message.prevSiblingId && onSwitchBranch(message.prevSiblingId)}
        disabled={!message.prevSiblingId || isStreaming}
        className="p-0.5 rounded hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
        title="Previous branch"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="tabular-nums select-none">
        {message.siblingIndex + 1}/{message.siblingCount}
      </span>
      <button
        type="button"
        onClick={() => message.nextSiblingId && onSwitchBranch(message.nextSiblingId)}
        disabled={!message.nextSiblingId || isStreaming}
        className="p-0.5 rounded hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
        title="Next branch"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );

  const iconBtn =
    'p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div
      className={`mt-1 flex items-center gap-2 ${
        isUser ? 'justify-end' : 'justify-start'
      }`}
    >
      {modelLabel && (
        <span className="text-[11px] text-muted-foreground shrink-0">
          {modelLabel}
        </span>
      )}
      {tokenLabel && (
        <span
          className="text-[11px] text-muted-foreground/70 shrink-0 tabular-nums"
          title="Prompt in · completion out"
        >
          {tokenLabel}
        </span>
      )}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      {siblingNav}

      {isUser ? (
        <button
          type="button"
          onClick={onEdit}
          disabled={isStreaming}
          className={iconBtn}
          title="Edit message"
        >
          <Pencil className="size-3.5" />
        </button>
      ) : (
        <RegenerateButton
          disabled={isStreaming}
          onDefault={() => onRegenerate()}
          onPickModel={(id) => onRegenerate(id)}
          modelConfigs={modelConfigs}
          activeModelId={activeModelId}
        />
      )}

      <button type="button" onClick={handleCopy} className={iconBtn} title="Copy">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

interface RegenerateButtonProps {
  disabled: boolean;
  onDefault: () => void;
  onPickModel: (id: string) => void;
  modelConfigs: ModelConfig[];
  activeModelId: string | null;
}

function RegenerateButton({
  disabled,
  onDefault,
  onPickModel,
  modelConfigs,
  activeModelId,
}: RegenerateButtonProps) {
  if (modelConfigs.length === 0) {
    return (
      <button
        type="button"
        onClick={onDefault}
        disabled={disabled}
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
        title="Regenerate"
      >
        <RotateCcw className="size-3.5" />
      </button>
    );
  }

  // Split button: main click → default model, chevron → full model picker
  // (includes the current model — user can re-roll with the same one).
  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={onDefault}
        disabled={disabled}
        className="pl-1 pr-0.5 py-1 rounded-l hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
        title="Regenerate with current model"
      >
        <RotateCcw className="size-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className="pl-0.5 pr-1 py-1 rounded-r hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
          title="Regenerate with…"
        >
          <svg className="size-3" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          {modelConfigs.map((m) => (
            <DropdownMenuItem
              key={m.id}
              onClick={() => onPickModel(m.id)}
              className="gap-2"
            >
              <ProviderIcon provider={m.provider} className="size-3.5 shrink-0" />
              <span className="truncate">{m.name}</span>
              {m.id === activeModelId && (
                <span className="ml-auto text-[10px] text-muted-foreground">current</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

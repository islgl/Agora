import { useState } from 'react';
import { HelpCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AskUserRequest } from '@/types';

interface AskUserPromptProps {
  request: AskUserRequest;
  queueSize: number;
  onAnswer: (answer: string) => void;
}

/**
 * Inline card shown above the chat input when the model raises an
 * `ask_user` clarification. Renders the question, a row of click-through
 * option buttons, and (when `allowFreeText` is true) a small text field
 * for anything the provided options don't cover.
 */
export function AskUserPrompt({
  request,
  queueSize,
  onAnswer,
}: AskUserPromptProps) {
  const [freeText, setFreeText] = useState('');

  const submitFreeText = () => {
    const trimmed = freeText.trim();
    if (!trimmed) return;
    onAnswer(trimmed);
  };

  return (
    <div
      className="mx-3 mb-2 rounded-xl bg-card"
      style={{ boxShadow: '0 0 0 1px var(--border)' }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-xs">
        <HelpCircle className="size-3.5 shrink-0 text-primary" />
        <span className="font-medium text-foreground">
          Agent asks for clarification
        </span>
        {queueSize > 0 && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            +{queueSize} queued
          </span>
        )}
      </div>

      <div className="px-3 pb-2 text-sm text-foreground whitespace-pre-wrap">
        {request.question}
      </div>

      {request.options.length > 0 && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          {request.options.map((opt, i) => (
            <Button
              key={`${i}-${opt}`}
              size="sm"
              variant="secondary"
              className="whitespace-normal text-left h-auto py-1.5 justify-start w-full"
              onClick={() => onAnswer(opt)}
            >
              {opt}
            </Button>
          ))}
        </div>
      )}

      {request.allowFreeText && (
        <div className="px-3 pb-3 flex items-center gap-1.5">
          <input
            type="text"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitFreeText();
              }
            }}
            placeholder={
              request.options.length > 0
                ? 'Or type your own answer…'
                : 'Type your answer…'
            }
            className="flex-1 rounded-md bg-background px-2 py-1 text-xs outline-none"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
            autoFocus
          />
          <Button
            size="sm"
            variant="default"
            onClick={submitFreeText}
            disabled={!freeText.trim()}
            className="shrink-0"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

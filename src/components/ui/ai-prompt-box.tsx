import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ArrowUp,
  Paperclip,
  Square,
  X,
  BrainCog,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/lib/platform';

const MOD_KEY = isMacOS ? '⌘' : 'Ctrl+';
const EXPANDED_PLACEHOLDER = `${MOD_KEY}↩ send · ↩ newline`;

/* ─── Textarea ─────────────────────────────────────────────── */

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={1}
    className={cn(
      'flex w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm leading-relaxed',
      'text-foreground placeholder:text-muted-foreground placeholder:font-[Georgia,serif]',
      'focus-visible:outline-none focus-visible:ring-0',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'min-h-[44px]',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

/* ─── Tooltip (radix + theme tokens) ───────────────────────── */

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      'z-50 overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md',
      'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/* ─── Dialog (image preview modal) ────────────────────────── */

const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-[90vw] -translate-x-1/2 -translate-y-1/2 md:max-w-3xl',
        'rounded-2xl border border-border bg-card p-0 shadow-xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 z-10 rounded-full bg-background/70 p-1.5 text-muted-foreground hover:bg-background hover:text-foreground transition-colors">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

/** Full-size image preview. Exported so user message bubbles can re-use it. */
export interface ImageViewDialogProps {
  imageUrl: string | null;
  onClose: () => void;
}
export const ImageViewDialog: React.FC<ImageViewDialogProps> = ({
  imageUrl,
  onClose,
}) => {
  if (!imageUrl) return null;
  return (
    <Dialog open={!!imageUrl} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-none bg-transparent p-0 shadow-none md:max-w-3xl">
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="relative overflow-hidden rounded-2xl bg-card shadow-2xl"
        >
          <img
            src={imageUrl}
            alt="Full preview"
            className="max-h-[80vh] w-full rounded-2xl object-contain"
          />
        </motion.div>
      </DialogContent>
    </Dialog>
  );
};

/* ─── PromptInput context + primitives ───────────────────── */

interface PromptInputContextType {
  value: string;
  setValue: (v: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
  /** `'enter'` → plain Enter submits, Shift+Enter newline.
   *  `'cmd-enter'` → Cmd/Ctrl+Enter submits, plain Enter newlines. */
  submitKey: 'enter' | 'cmd-enter';
}
const PromptInputContext = React.createContext<PromptInputContextType | null>(
  null,
);
function usePromptInput() {
  const ctx = React.useContext(PromptInputContext);
  if (!ctx) throw new Error('usePromptInput must be used within <PromptInput>');
  return ctx;
}

interface PromptInputProps {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit?: () => void;
  maxHeight?: number | string;
  disabled?: boolean;
  isLoading?: boolean;
  submitKey?: 'enter' | 'cmd-enter';
  className?: string;
  children: React.ReactNode;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}
const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    {
      className,
      isLoading = false,
      maxHeight = 180,
      value,
      onValueChange,
      onSubmit,
      children,
      disabled = false,
      submitKey = 'enter',
      onDragOver,
      onDragLeave,
      onDrop,
    },
    ref,
  ) => (
    <TooltipProvider delayDuration={200}>
      <PromptInputContext.Provider
        value={{
          value,
          setValue: onValueChange,
          maxHeight,
          onSubmit,
          disabled,
          submitKey,
        }}
      >
        <div
          ref={ref}
          className={cn(
            'relative rounded-2xl border bg-card p-2 transition-colors',
            isLoading ? 'border-primary/60' : 'border-border',
            className,
          )}
          style={{ boxShadow: '0 0 0 1px var(--border), 0 4px 24px rgba(0,0,0,0.05)' }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {children}
        </div>
      </PromptInputContext.Provider>
    </TooltipProvider>
  ),
);
PromptInput.displayName = 'PromptInput';

interface PromptInputTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  disableAutosize?: boolean;
  /** Known slash commands to highlight. Only exact matches (the leading
   *  `/<token>` before any whitespace must equal one of these) render the
   *  overlay; partial typings like `/pl` stay unstyled. */
  knownSlashCommands?: string[];
}
const PromptInputTextarea: React.FC<PromptInputTextareaProps> = ({
  className,
  onKeyDown,
  disableAutosize = false,
  placeholder,
  knownSlashCommands,
  ...props
}) => {
  const { value, setValue, maxHeight, onSubmit, disabled, submitKey } =
    usePromptInput();
  const ref = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (disableAutosize || !ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height =
      typeof maxHeight === 'number'
        ? `${Math.min(ref.current.scrollHeight, maxHeight)}px`
        : `min(${ref.current.scrollHeight}px, ${maxHeight})`;
  }, [value, maxHeight, disableAutosize]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (Chinese/Japanese/Korean): Enter commits a candidate
    // rather than submitting. keyCode 229 is the cross-browser fallback.
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      onKeyDown?.(e);
      return;
    }
    // Let the caller intercept first — e.g. a slash-command menu that
    // needs to steal Enter/Arrow/Escape before the default submit logic
    // fires. If they `preventDefault`, we bail out of the built-in flow.
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter') {
      const isCmd = e.metaKey || e.ctrlKey;
      const shouldSubmit =
        submitKey === 'cmd-enter' ? isCmd : !e.shiftKey && !isCmd;
      if (shouldSubmit) {
        e.preventDefault();
        onSubmit?.();
      }
      // Otherwise let the browser insert the newline (plain Enter in
      // cmd-enter mode, or Shift+Enter in enter mode).
    }
  };

  // Highlight a leading `/command` chunk *only when it exactly matches* a
  // known slash command followed by a whitespace boundary (or end of
  // string). Partial typings like `/pl` stay unstyled. The highlight is
  // rendered via an absolutely-positioned overlay above a transparent-text
  // textarea; the caret stays visible via `caret-color`.
  //
  // The overlay's span must introduce zero extra horizontal space — any
  // padding / bold weight / different font would shift the following text
  // relative to the textarea's caret. So we use color + background only,
  // no padding, no weight change.
  const slashPrefix = (() => {
    if (!knownSlashCommands || knownSlashCommands.length === 0) return null;
    const m = value.match(/^\/\S+/);
    if (!m) return null;
    const token = m[0];
    if (!knownSlashCommands.includes(token)) return null;
    // Must be followed by whitespace or end-of-string — otherwise it's
    // `/chatZZZ`, not a real command.
    const next = value.charAt(token.length);
    if (next !== '' && !/\s/.test(next)) return null;
    return token;
  })();
  const rest = slashPrefix ? value.slice(slashPrefix.length) : '';
  const overlayRef = React.useRef<HTMLDivElement>(null);

  const handleScroll = () => {
    if (overlayRef.current && ref.current) {
      overlayRef.current.scrollTop = ref.current.scrollTop;
    }
  };

  return (
    <div className="relative">
      {slashPrefix && (
        <div
          ref={overlayRef}
          aria-hidden
          className="absolute inset-0 px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words pointer-events-none overflow-hidden"
          style={{ fontFamily: 'inherit' }}
        >
          <span
            style={{
              color: 'var(--primary)',
              background: 'color-mix(in oklab, var(--primary) 12%, transparent)',
            }}
          >
            {slashPrefix}
          </span>
          <span className="text-foreground">{rest}</span>
        </div>
      )}
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        className={cn(className, slashPrefix && 'text-transparent')}
        style={slashPrefix ? { caretColor: 'var(--foreground)' } : undefined}
        disabled={disabled}
        placeholder={placeholder}
        {...props}
      />
    </div>
  );
};

interface PromptInputActionProps extends React.ComponentProps<typeof Tooltip> {
  tooltip: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}
const PromptInputAction: React.FC<PromptInputActionProps> = ({
  tooltip,
  children,
  side = 'top',
  ...props
}) => {
  // Deliberately NOT forwarding the context `disabled` here. With
  // `asChild`, TooltipTrigger clones props onto the child button, so
  // `disabled={true}` would disable the button itself — which silently
  // killed the Stop button while streaming. Each button decides its
  // own disabled state via its own `disabled` attribute.
  return (
    <Tooltip {...props}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  );
};

/* ─── Public: PromptInputBox ────────────────────────────── */

export interface SlashCommand {
  command: string;
  description?: string;
}

export interface PromptInputBoxProps {
  onSend: (text: string, files: File[]) => void;
  onStop?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  thinkingEnabled: boolean;
  onThinkingToggle: (v: boolean) => void;
  /** Slot rendered at the bottom-left, inline with the toggles. Used for ModelSelector. */
  bottomStartSlot?: React.ReactNode;
  /** When provided and the user starts typing `/`, surface a filter-as-you-type
   *  menu above the textarea. Picking an item replaces the input and submits. */
  slashCommands?: SlashCommand[];
}

export const PromptInputBox = React.forwardRef<
  HTMLDivElement,
  PromptInputBoxProps
>(function PromptInputBox(
  {
    onSend,
    onStop,
    isLoading = false,
    placeholder = 'Ask anything',
    className,
    thinkingEnabled,
    onThinkingToggle,
    bottomStartSlot,
    slashCommands,
  },
  ref,
) {
  const [input, setInput] = React.useState('');
  const [files, setFiles] = React.useState<File[]>([]);
  const [previews, setPreviews] = React.useState<Record<string, string>>({});
  const [selectedImage, setSelectedImage] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [slashIndex, setSlashIndex] = React.useState(0);
  const uploadRef = React.useRef<HTMLInputElement>(null);

  const isImage = (f: File) => f.type.startsWith('image/');

  const ingest = React.useCallback((file: File) => {
    if (!isImage(file)) return;
    if (file.size > 10 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setFiles((prev) => [...prev, file]);
      setPreviews((prev) => ({ ...prev, [file.name]: dataUrl }));
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      Array.from(e.dataTransfer.files).filter(isImage).forEach(ingest);
    },
    [ingest],
  );

  const handleRemoveFile = (index: number) => {
    const f = files[index];
    if (!f) return;
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => {
      const next = { ...prev };
      delete next[f.name];
      return next;
    });
  };

  const handlePaste = React.useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            ingest(f);
          }
        }
      }
    },
    [ingest],
  );

  React.useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const hasContent = input.trim() !== '' || files.length > 0;

  const handleSubmit = () => {
    if (isLoading || !hasContent) return;
    onSend(input.trim(), files);
    setInput('');
    setFiles([]);
    setPreviews({});
  };

  // Slash-command completion. Active while the input is a single-line
  // slash prefix with no whitespace — as soon as the user types a space
  // the menu closes and the text is treated as a normal message.
  const slashMatches = React.useMemo<SlashCommand[]>(() => {
    if (!slashCommands || slashCommands.length === 0) return [];
    if (!input.startsWith('/')) return [];
    if (/\s/.test(input)) return [];
    const prefix = input.toLowerCase();
    return slashCommands.filter((s) =>
      s.command.toLowerCase().startsWith(prefix),
    );
  }, [slashCommands, input]);
  const slashMenuOpen = slashMatches.length > 0;

  // Clamp the highlight when the match list shrinks (e.g. user added a
  // character that filters the list down).
  React.useEffect(() => {
    if (!slashMenuOpen) {
      if (slashIndex !== 0) setSlashIndex(0);
      return;
    }
    if (slashIndex >= slashMatches.length) setSlashIndex(0);
  }, [slashMenuOpen, slashMatches.length, slashIndex]);

  const pickSlashCommand = (cmd: string) => {
    // Insert `<cmd> ` into the box and close the menu. We don't
    // auto-submit — some future commands may take arguments
    // (e.g. `/prompt <text>`), so the user still needs one Enter to fire
    // after picking. Argument-less commands are a single extra keystroke.
    setInput(cmd + ' ');
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Shift + E toggles the expanded editing mode.
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === 'e'
    ) {
      e.preventDefault();
      setExpanded((v) => !v);
      return;
    }
    if (!slashMenuOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIndex((i) => (i + 1) % slashMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const target = slashMatches[slashIndex];
      if (!target) return;
      e.preventDefault();
      pickSlashCommand(target.command);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setInput('');
    }
  };

  return (
    <>
      <PromptInput
        value={input}
        onValueChange={setInput}
        isLoading={isLoading}
        onSubmit={handleSubmit}
        disabled={isLoading}
        maxHeight={expanded ? '60vh' : 180}
        submitKey={expanded ? 'cmd-enter' : 'enter'}
        className={className}
        ref={ref}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {slashMenuOpen && (
          <div
            className="absolute left-0 right-0 bottom-full mb-2 rounded-xl bg-popover py-1 text-sm shadow-md"
            style={{ boxShadow: '0 0 0 1px var(--border), 0 8px 24px rgba(0,0,0,0.08)' }}
            role="listbox"
          >
            {slashMatches.map((cmd, i) => (
              <button
                key={cmd.command}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                onMouseDown={(e) => {
                  // prevent textarea blur before the click lands
                  e.preventDefault();
                }}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => pickSlashCommand(cmd.command)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left',
                  i === slashIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/50',
                )}
              >
                <span className="font-mono text-xs">{cmd.command}</span>
                {cmd.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {cmd.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2">
            {files.map((file, index) =>
              previews[file.name] ? (
                <div key={`${file.name}-${index}`} className="relative group">
                  <button
                    type="button"
                    className="block h-14 w-14 overflow-hidden rounded-lg border border-border"
                    onClick={() => setSelectedImage(previews[file.name])}
                  >
                    <img
                      src={previews[file.name]}
                      alt={file.name}
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveFile(index);
                    }}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground/80 p-0.5 text-background shadow-sm transition hover:bg-foreground"
                    aria-label="Remove image"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null,
            )}
          </div>
        )}

        <PromptInputTextarea
          placeholder={expanded ? EXPANDED_PLACEHOLDER : placeholder}
          className={expanded ? 'min-h-[30vh]' : undefined}
          onKeyDown={handleTextareaKeyDown}
          knownSlashCommands={slashCommands?.map((c) => c.command)}
        />

        <div className="flex items-center justify-between gap-2 pt-2">
          <div className="flex items-center gap-1 min-w-0">
            <PromptInputAction tooltip="Upload image">
              <button
                type="button"
                onClick={() => uploadRef.current?.click()}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                disabled={isLoading}
              >
                <Paperclip className="h-4 w-4" />
                <input
                  ref={uploadRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept="image/*"
                  onChange={(e) => {
                    const picked = e.target.files;
                    if (picked) Array.from(picked).forEach(ingest);
                    if (e.target) e.target.value = '';
                  }}
                />
              </button>
            </PromptInputAction>

            <PromptInputAction
              tooltip={expanded ? 'Collapse (⌘⇧E)' : 'Expand (⌘⇧E)'}
            >
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={expanded ? 'Collapse input' : 'Expand input'}
              >
                {expanded ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
            </PromptInputAction>

            <ToggleButton
              active={thinkingEnabled}
              onClick={() => onThinkingToggle(!thinkingEnabled)}
              icon={<BrainCog className="h-3.5 w-3.5" />}
              label="Think"
              tooltip={thinkingEnabled ? 'Extended thinking on' : 'Enable extended thinking'}
            />

            {bottomStartSlot ? (
              <div className="ml-1 flex min-w-0 items-center">{bottomStartSlot}</div>
            ) : null}
          </div>

          {isLoading ? (
            <PromptInputAction tooltip="Stop generating">
              <button
                type="button"
                onClick={onStop}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/90"
                style={{ boxShadow: '0 0 0 1px var(--foreground)' }}
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            </PromptInputAction>
          ) : (
            <PromptInputAction
              tooltip={expanded ? `Send (${MOD_KEY}↩)` : 'Send (↩)'}
            >
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!hasContent}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                  hasContent
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed',
                )}
                style={hasContent ? { boxShadow: '0 0 0 1px var(--primary)' } : {}}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </PromptInputAction>
          )}
        </div>
      </PromptInput>

      <ImageViewDialog
        imageUrl={selectedImage}
        onClose={() => setSelectedImage(null)}
      />
    </>
  );
});

/* ─── Toggle pill used for Search / Think ─────────────────── */

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tooltip: string;
}
function ToggleButton({ active, onClick, icon, label, tooltip }: ToggleButtonProps) {
  return (
    <PromptInputAction tooltip={tooltip}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex h-7 items-center gap-1 rounded-full border px-2 text-xs transition-colors',
          active
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <motion.span
          animate={{ rotate: active ? 360 : 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 25 }}
          className="flex items-center justify-center"
        >
          {icon}
        </motion.span>
        <AnimatePresence initial={false}>
          {active && (
            <motion.span
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'auto', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="overflow-hidden whitespace-nowrap"
            >
              {label}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </PromptInputAction>
  );
}

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useBrandStore } from '@/store/brandStore';
import type { BrandEditableFile, BrandSection } from '@/types';

interface BrandFileEditorProps {
  file: Exclude<BrandEditableFile, 'MEMORY.md' | 'TOOLS.md'>;
  section: BrandSection;
  placeholder?: string;
  savedMessage?: string;
}

export function BrandFileEditor({
  file,
  section,
  placeholder,
  savedMessage = 'Saved',
}: BrandFileEditorProps) {
  const writeFile = useBrandStore((s) => s.writeFile);
  const [draft, setDraft] = useState(section.content);
  const [saving, setSaving] = useState(false);

  // Re-sync when the underlying file changes on disk (e.g. the chat
  // remember tool appended a line) and the user hasn't made local edits —
  // otherwise preserve the in-progress draft.
  useEffect(() => {
    setDraft((current) =>
      current === '' || current === section.content ? section.content : current,
    );
  }, [section.content]);

  const dirty = draft !== section.content;

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await writeFile(file, draft);
      toast.success(savedMessage);
    } catch (err) {
      toast.error(`Save failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="min-h-[240px] w-full resize-y rounded-lg bg-card px-3 py-2.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      />
      {section.truncated && (
        <div className="text-[11px] text-muted-foreground">
          This is long enough that only the beginning is shown here. Saving
          will keep just what's above — for longer notes, open the file
          directly.
        </div>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

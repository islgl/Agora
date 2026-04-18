import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { X, FileCode } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSkillsStore } from '@/store/skillsStore';
import type { ScriptUpload } from '@/types';

const INPUT_CLASS =
  'rounded-xl border-border bg-card text-foreground focus-visible:border-ring focus-visible:ring-0 placeholder:text-muted-foreground';

interface SkillFormProps {
  onClose: () => void;
}

export function SkillForm({ onClose }: SkillFormProps) {
  const { create } = useSkillsStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scripts, setScripts] = useState<ScriptUpload[]>([]);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const additions: ScriptUpload[] = [];
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      additions.push({
        filename: file.name,
        contentBase64: arrayBufferToBase64(buf),
      });
    }
    setScripts((prev) => {
      const byName = new Map(prev.map((s) => [s.filename, s]));
      for (const add of additions) byName.set(add.filename, add);
      return Array.from(byName.values());
    });
  };

  const removeScript = (filename: string) => {
    setScripts((prev) => prev.filter((s) => s.filename !== filename));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await create({ name: name.trim(), description: description.trim(), body, scripts });
      toast.success(`Created skill '${name.trim()}'`);
      onClose();
    } catch (err) {
      toast.error(`Create failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between">
        <h2
          className="text-lg text-foreground"
          style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
        >
          New skill
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 rounded-md hover:bg-accent text-muted-foreground"
        >
          ← Back
        </button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Name</Label>
        <Input
          className={INPUT_CLASS}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-skill"
          required
        />
        <p className="text-[11px] text-muted-foreground">
          Letters, numbers, dashes, underscores, spaces. Becomes the folder name.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Description</Label>
        <Input
          className={INPUT_CLASS}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line summary shown to the model."
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">SKILL.md body (markdown)</Label>
        <textarea
          className={`${INPUT_CLASS} min-h-56 w-full p-3 text-sm resize-y font-mono`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`# Usage\n\nExplain what this skill does and when the model should invoke it...`}
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
          required
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm text-muted-foreground">Scripts (optional)</Label>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-xs px-2 py-1 rounded-md bg-card text-foreground hover:bg-accent"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            + Upload script
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {scripts.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            Uploaded files go into <code>scripts/</code>. The model can only run them when
            script execution is enabled in Skills settings.
          </p>
        )}
        {scripts.map((s) => (
          <div
            key={s.filename}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            <FileCode className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm text-foreground truncate flex-1">{s.filename}</span>
            <button
              type="button"
              onClick={() => removeScript(s.filename)}
              className="text-muted-foreground hover:text-destructive"
              title="Remove"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm disabled:opacity-60"
        >
          {saving ? 'Creating…' : 'Create skill'}
        </button>
      </div>
    </form>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

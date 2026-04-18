import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Trash2, FolderOpen, FolderInput, Plus } from 'lucide-react';
import { useSkillsStore } from '@/store/skillsStore';
import { SkillForm } from './SkillForm';
import { Toggle } from '@/components/ui/toggle';

export function SkillsList() {
  const {
    skills,
    meta,
    load,
    loadMeta,
    rescan,
    setScriptsEnabled,
    openFolder,
    importFolder,
    remove,
  } = useSkillsStore();
  const [adding, setAdding] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    void load();
    void loadMeta();
  }, [load, loadMeta]);

  if (adding) {
    return <SkillForm onClose={() => setAdding(false)} />;
  }

  const handleImport = async () => {
    setAddMenuOpen(false);
    try {
      const name = await importFolder();
      if (name) toast.success(`Imported ${name}`);
    } catch (e) {
      toast.error(`Import failed: ${e}`);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete skill "${name}" and all its files?`)) return;
    try {
      await remove(name);
      toast.success(`Deleted ${name}`);
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2
          className="text-lg text-foreground mb-1"
          style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
        >
          Skills
        </h2>
        <p className="text-xs text-muted-foreground">
          Skills are folders with a <code>SKILL.md</code>. Agora manages them in its own
          directory; imports are copied in so the originals stay untouched.
        </p>
      </div>

      <div
        className="flex items-center gap-2 p-3 rounded-xl bg-card"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground">Agora skills folder</div>
          <div className="text-[11px] text-muted-foreground/80 truncate font-mono">
            {meta?.directory ?? '…'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void openFolder()}
          className="text-xs px-2 py-1.5 rounded-md bg-card text-foreground hover:bg-accent flex items-center gap-1.5"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          <FolderOpen className="size-3.5" />
          Open
        </button>
        <button
          type="button"
          onClick={() => void rescan()}
          className="text-xs px-2 py-1.5 rounded-md bg-card text-foreground hover:bg-accent"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          Rescan
        </button>
      </div>

      <div
        className="flex items-start gap-3 p-3 rounded-xl bg-card text-sm"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      >
        <div className="space-y-0.5 flex-1 min-w-0">
          <div className="text-foreground">Enable script execution</div>
          <div className="text-xs text-muted-foreground">
            Let the model run scripts in <code>&lt;skill&gt;/scripts/</code>. Scripts run
            with your user permissions and a 30-second timeout. Leave off for untrusted
            skills.
          </div>
        </div>
        <Toggle
          checked={meta?.scriptsEnabled ?? false}
          onCheckedChange={(checked) => void setScriptsEnabled(checked)}
          className="mt-0.5"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {skills.length} skill{skills.length === 1 ? '' : 's'}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5"
          >
            <Plus className="size-3.5" />
            Add skill
          </button>
          {addMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setAddMenuOpen(false)}
              />
              <div
                className="absolute right-0 mt-1 w-52 rounded-lg bg-card py-1 z-20"
                style={{ boxShadow: '0 0 0 1px var(--border), 0 4px 16px rgba(0,0,0,0.08)' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAdding(true);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                >
                  <Plus className="size-3.5 text-muted-foreground" />
                  Create new skill
                </button>
                <button
                  type="button"
                  onClick={() => void handleImport()}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                >
                  <FolderInput className="size-3.5 text-muted-foreground" />
                  Import folder…
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {skills.length === 0 && (
          <div
            className="text-xs text-muted-foreground p-6 rounded-xl border border-dashed border-border text-center"
          >
            No skills yet. Use <b>Add skill</b> to create one or import a folder.
          </div>
        )}
        {skills.map((s) => (
          <div
            key={s.name}
            className="flex items-start gap-3 p-3 rounded-xl bg-card"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm text-foreground">{s.name}</div>
              <div className="text-xs text-muted-foreground line-clamp-2">
                {s.description || <span className="italic">No description</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleDelete(s.name)}
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 p-1.5 rounded-md"
              title="Delete"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

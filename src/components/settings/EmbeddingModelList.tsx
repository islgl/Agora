import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useSettingsStore } from '@/store/settingsStore';
import { EmbeddingModelForm } from './EmbeddingModelForm';
import type { EmbeddingConfig } from '@/types';

export function EmbeddingModelList() {
  const {
    embeddingConfigs,
    activeEmbeddingId,
    deleteEmbeddingConfig,
    setActiveEmbedding,
  } = useSettingsStore();
  const [editing, setEditing] = useState<EmbeddingConfig | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  if (isAdding || editing) {
    return (
      <EmbeddingModelForm
        existing={editing ?? undefined}
        onClose={() => {
          setIsAdding(false);
          setEditing(null);
        }}
      />
    );
  }

  // Flat list — we don't group by "provider" because the on-wire protocol
  // ("OpenAI-compatible") is an implementation detail. The user-facing
  // identity is the Gateway Provider ID, rendered as a chip per row.
  return (
    <div className="space-y-3">
      {embeddingConfigs.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          No embedding models configured.
        </p>
      ) : (
        <div className="space-y-2">
          {[...embeddingConfigs]
            .sort((a, b) => {
              if (a.id === activeEmbeddingId) return -1;
              if (b.id === activeEmbeddingId) return 1;
              return 0;
            })
            .map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-card min-w-0"
              style={{ boxShadow: '0 0 0 1px var(--border)' }}
            >
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  {m.providerId ? (
                    <span
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium tracking-wide uppercase"
                      title="Gateway Provider ID"
                    >
                      {m.providerId}
                    </span>
                  ) : null}
                  <span className="text-sm font-medium text-foreground truncate min-w-0">
                    {m.name}
                  </span>
                  {m.id === activeEmbeddingId && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                      Active
                    </span>
                  )}
                </div>
                <p
                  className="text-xs text-muted-foreground truncate"
                  title={m.model}
                >
                  {m.model}
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-1">
                {m.id !== activeEmbeddingId && (
                  <button
                    onClick={() => void setActiveEmbedding(m.id)}
                    className="px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:text-foreground
                               hover:bg-accent transition-colors whitespace-nowrap"
                  >
                    Use
                  </button>
                )}
                <button
                  onClick={() => setEditing(m)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground
                             hover:bg-accent transition-colors"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  onClick={() => void deleteEmbeddingConfig(m.id)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive
                             hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => setIsAdding(true)}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm
                   text-muted-foreground hover:text-foreground border border-dashed border-border
                   hover:border-ring-warm hover:bg-accent transition-colors"
      >
        <Plus className="size-3.5" />
        Add embedding model
      </button>
    </div>
  );
}

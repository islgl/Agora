import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Pencil,
  Trash2,
  Plus,
  Zap,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { useSettingsStore } from '@/store/settingsStore';
import { ModelForm } from './ModelForm';
import {
  ProviderIcon,
  PROVIDER_DISPLAY_LABEL,
  PROVIDER_ORDER,
} from './ProviderIcon';
import type { ModelConfig } from '@/types';

type TestOutcome = { ok: true; message: string } | { ok: false; error: string };

export function ModelList() {
  const {
    modelConfigs,
    activeModelId,
    deleteModelConfig,
    setActiveModel,
    resolveModelConfig,
  } = useSettingsStore();
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [results, setResults] = useState<Record<string, TestOutcome>>({});

  const markTesting = (id: string, on: boolean) => {
    setTesting((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const runTest = async (m: ModelConfig): Promise<TestOutcome> => {
    markTesting(m.id, true);
    try {
      const msg = await invoke<string>('test_model_config', {
        modelConfig: resolveModelConfig(m),
      });
      const outcome: TestOutcome = { ok: true, message: msg };
      setResults((r) => ({ ...r, [m.id]: outcome }));
      return outcome;
    } catch (err) {
      const outcome: TestOutcome = { ok: false, error: String(err) };
      setResults((r) => ({ ...r, [m.id]: outcome }));
      return outcome;
    } finally {
      markTesting(m.id, false);
    }
  };

  const handleTest = async (m: ModelConfig) => {
    const outcome = await runTest(m);
    if (outcome.ok) toast.success(outcome.message);
    else toast.error(`${m.name}: ${outcome.error}`);
  };

  const handleTestAll = async () => {
    if (modelConfigs.length === 0) return;
    setTestingAll(true);
    try {
      const outcomes = await Promise.all(modelConfigs.map((m) => runTest(m)));
      const okCount = outcomes.filter((o) => o.ok).length;
      const failCount = outcomes.length - okCount;
      if (failCount === 0) {
        toast.success(`All ${okCount} models OK`);
      } else {
        toast.error(`${okCount} OK · ${failCount} failed`);
      }
    } finally {
      setTestingAll(false);
    }
  };

  if (isAdding || editingModel) {
    return (
      <ModelForm
        existing={editingModel ?? undefined}
        onClose={() => {
          setIsAdding(false);
          setEditingModel(null);
        }}
      />
    );
  }

  const groups = PROVIDER_ORDER.map((p) => ({
    provider: p,
    models: modelConfigs
      .filter((m) => m.provider === p)
      .sort((a, b) => {
        if (a.id === activeModelId) return -1;
        if (b.id === activeModelId) return 1;
        return 0;
      }),
  })).filter((g) => g.models.length > 0);

  const anyTesting = testing.size > 0 || testingAll;

  return (
    <div className="space-y-6">
      {modelConfigs.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={() => void handleTestAll()}
            disabled={anyTesting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-foreground
                       bg-card hover:bg-accent transition-colors disabled:opacity-60
                       disabled:pointer-events-none"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            {testingAll ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Zap className="size-3.5" />
            )}
            {testingAll ? 'Testing all…' : 'Test all'}
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          No models configured. Add one to start chatting.
        </p>
      ) : (
        groups.map(({ provider, models }) => (
          <section key={provider} className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <ProviderIcon provider={provider} className="size-4 shrink-0" />
              <span className="text-sm font-semibold text-foreground">
                {PROVIDER_DISPLAY_LABEL[provider]}
              </span>
            </div>
            <div className="space-y-2">
              {models.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-card min-w-0"
                  style={{ boxShadow: '0 0 0 1px var(--border)' }}
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate min-w-0">
                        {m.name}
                      </span>
                      {results[m.id]?.ok === true && (
                        <CheckCircle2
                          className="size-3.5 shrink-0 text-emerald-500"
                          aria-label={results[m.id] && results[m.id].ok ? (results[m.id] as { ok: true; message: string }).message : ''}
                        />
                      )}
                      {results[m.id]?.ok === false && (
                        <XCircle
                          className="size-3.5 shrink-0 text-destructive"
                          aria-label={results[m.id] && !results[m.id].ok ? (results[m.id] as { ok: false; error: string }).error : ''}
                        />
                      )}
                      {m.id === activeModelId && (
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
                    {m.id !== activeModelId && (
                      <button
                        onClick={() => setActiveModel(m.id)}
                        className="px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:text-foreground
                                   hover:bg-accent transition-colors whitespace-nowrap"
                      >
                        Use
                      </button>
                    )}
                    <button
                      onClick={() => void handleTest(m)}
                      disabled={anyTesting}
                      title="Test connection"
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground
                                 hover:bg-accent transition-colors disabled:opacity-40
                                 disabled:pointer-events-none"
                    >
                      {testing.has(m.id) ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Zap className="size-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => setEditingModel(m)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground
                                 hover:bg-accent transition-colors"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      onClick={() => deleteModelConfig(m.id)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive
                                 hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
      <button
        onClick={() => setIsAdding(true)}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm
                   text-muted-foreground hover:text-foreground border border-dashed border-border
                   hover:border-ring-warm hover:bg-accent transition-colors"
      >
        <Plus className="size-3.5" />
        Add model
      </button>
    </div>
  );
}

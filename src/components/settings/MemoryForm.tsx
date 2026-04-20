import { toast } from 'sonner';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/store/settingsStore';
import { SettingsPage } from './SettingsPage';
import { SettingsSection } from './SettingsSection';

export function MemoryForm() {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();

  const handleToggle = async (checked: boolean) => {
    // Read the latest snapshot so a mutation made elsewhere (e.g. an
    // embedding-model edit from the Models tab) isn't clobbered by a
    // stale copy captured at mount.
    const latest = useSettingsStore.getState().globalSettings;
    try {
      await saveGlobalSettings({ ...latest, autoMemoryEnabled: checked });
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <SettingsPage
      title="Memory"
      description="After each turn, a lightweight model pass extracts 0–3 durable facts and stores them in a local vector index. Recall at turn start always runs — the toggle below only gates new writes."
    >
      <SettingsSection
        title="Auto-extraction"
        description="Disable to keep only the memories you explicitly ask Agora to remember."
      >
        <div
          className="flex items-start gap-3 p-3 rounded-xl bg-card"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          <div className="space-y-0.5 flex-1 min-w-0">
            <div className="text-sm text-foreground">
              Enable auto-extraction
            </div>
            <div className="text-xs text-muted-foreground">
              Runs in the background per turn. Recall at turn start keeps
              working either way.
            </div>
          </div>
          <Toggle
            checked={globalSettings.autoMemoryEnabled}
            onCheckedChange={(checked) => void handleToggle(checked)}
            className="mt-0.5"
          />
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Dream controls — the opt-in idle trigger + its threshold. Manual
 * Dreaming runs (via the `run_dreaming` tool) work regardless of the
 * toggle here; this section only governs the automatic fire.
 */
export function DreamingSettings() {
  const autoDreamOnIdle = useSettingsStore(
    (s) => s.globalSettings.autoDreamOnIdle,
  );
  const dreamIdleMinutes = useSettingsStore(
    (s) => s.globalSettings.dreamIdleMinutes,
  );
  const saveGlobalSettings = useSettingsStore((s) => s.saveGlobalSettings);

  const toggleAutoDream = async (checked: boolean) => {
    const latest = useSettingsStore.getState().globalSettings;
    try {
      await saveGlobalSettings({ ...latest, autoDreamOnIdle: checked });
    } catch (err) {
      toast.error(String(err));
    }
  };

  const saveIdleMinutes = async (value: number) => {
    const clamped = Number.isFinite(value)
      ? Math.max(1, Math.min(720, Math.round(value)))
      : 60;
    const latest = useSettingsStore.getState().globalSettings;
    if (latest.dreamIdleMinutes === clamped) return;
    try {
      await saveGlobalSettings({ ...latest, dreamIdleMinutes: clamped });
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px] text-muted-foreground">
        <span>Dream when idle for a while</span>
        <Toggle
          checked={autoDreamOnIdle}
          onCheckedChange={(checked) => void toggleAutoDream(checked)}
        />
      </label>

      {autoDreamOnIdle && (
        <label className="flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
          <span>Idle threshold (minutes)</span>
          <Input
            type="number"
            min={1}
            max={720}
            defaultValue={dreamIdleMinutes}
            onBlur={(e) => void saveIdleMinutes(Number(e.currentTarget.value))}
            className="h-7 w-20 text-right"
          />
        </label>
      )}
    </div>
  );
}

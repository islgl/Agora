import { useEffect } from 'react';
import { useBrandStore } from '@/store/brandStore';
import { SettingsPage } from './SettingsPage';
import { SettingsSection } from './SettingsSection';
import { BrandFileEditor } from './personalization/BrandFileEditor';
import { BrandLineList } from './personalization/BrandLineList';
import { DreamingSettings } from './personalization/DreamingSettings';
import { MemoryLineList } from './personalization/MemoryLineList';

export function PersonalizationForm() {
  const payload = useBrandStore((s) => s.payload);
  const refresh = useBrandStore((s) => s.refresh);

  // Re-read on mount so a user who opened Settings right after a chat
  // turn (which may have appended to MEMORY/TOOLS) sees fresh content.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsPage
      title="Personalization"
      description="Shape how Agora knows you and how it shows up. Changes take effect on the next turn — no restart needed."
    >
      <SettingsSection
        title="About you"
        description="Who Agora is talking to. Anything here is kept in mind in every conversation."
      >
        <BrandFileEditor
          file="USER.md"
          section={payload.user}
          placeholder="Tell Agora what matters — your name, how you'd like to be addressed, timezone, what you're working on…"
          savedMessage="Agora will keep that in mind"
        />
      </SettingsSection>

      <SettingsSection
        title="About Agora"
        description="How Agora should show up for you. Add one preference at a time — tone, style, habits to keep or avoid."
      >
        <BrandLineList
          file="SOUL.md"
          section={payload.soul}
          placeholder="Something Agora should be or do…"
          emptyMessage="No preferences yet. Add one below — for example, “be concise” or “never apologize reflexively”."
        />
      </SettingsSection>

      <SettingsSection
        title="What Agora remembers"
        description="Durable facts Agora keeps across conversations. Add ones you want remembered; forget ones you'd rather it let go."
      >
        <MemoryLineList />
      </SettingsSection>

      <SettingsSection
        title="Dream"
        description="Periodic background pass that distills durable memories from recent conversations. Auto-fires when the app has been idle; you can also trigger it manually from chat."
      >
        <DreamingSettings />
      </SettingsSection>
    </SettingsPage>
  );
}

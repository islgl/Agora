import {
  Bot,
  BrainCircuit,
  KeyRound,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Wand2,
  Webhook,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { McpIcon } from '@/components/icons/McpIcon';
import { ModelsPage } from './ModelsPage';
import { ProvidersForm } from './ProvidersForm';
import { CapabilitiesForm } from './CapabilitiesForm';
import { GeneralForm } from './GeneralForm';
import { McpServersList } from './McpServersList';
import { HooksForm } from './HooksForm';
import { PermissionsForm } from './PermissionsForm';
import { SkillsList } from './SkillsList';
import { MemoryForm } from './MemoryForm';

const TAB_TRIGGER_CLASS =
  '!flex-none !h-auto w-full rounded-lg px-3 py-2 text-muted-foreground ' +
  'justify-start gap-2 hover:text-foreground ' +
  'data-[state=active]:bg-card data-[state=active]:text-foreground ' +
  'data-[state=active]:shadow-none';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        // Dragging the window via a `data-tauri-drag-region` can briefly blur
        // the webview; don't let that close the panel.
        if (!nextOpen && eventDetails?.reason === 'focus-out') {
          eventDetails.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-3xl h-[640px] max-h-[85vh] grid-rows-1 p-0 gap-0 overflow-hidden
                   rounded-2xl bg-background border-border"
        style={{
          boxShadow: '0 0 0 1px var(--border), 0 4px 24px rgba(0,0,0,0.08)',
        }}
      >
        <Tabs
          defaultValue="general"
          orientation="vertical"
          className="h-full !gap-0"
        >
          <aside className="w-48 shrink-0 flex flex-col bg-muted/40 border-r border-border">
            <div data-tauri-drag-region className="px-5 pt-5 pb-3">
              <DialogTitle
                className="text-foreground pointer-events-none"
                style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
              >
                Settings
              </DialogTitle>
            </div>
            <TabsList
              className="bg-transparent !h-auto !justify-start px-3 pb-3 gap-1 w-full rounded-none"
            >
              <TabsTrigger value="general" className={TAB_TRIGGER_CLASS}>
                <SettingsIcon className="size-4 shrink-0" />
                General
              </TabsTrigger>
              <TabsTrigger value="models" className={TAB_TRIGGER_CLASS}>
                <Bot className="size-4 shrink-0" />
                Models
              </TabsTrigger>
              <TabsTrigger value="providers" className={TAB_TRIGGER_CLASS}>
                <KeyRound className="size-4 shrink-0" />
                Providers
              </TabsTrigger>
              <TabsTrigger value="capabilities" className={TAB_TRIGGER_CLASS}>
                <Sparkles className="size-4 shrink-0" />
                Capabilities
              </TabsTrigger>
              <TabsTrigger value="memory" className={TAB_TRIGGER_CLASS}>
                <BrainCircuit className="size-4 shrink-0" />
                Memory
              </TabsTrigger>
              <TabsTrigger value="mcp" className={TAB_TRIGGER_CLASS}>
                <McpIcon className="size-4 shrink-0" />
                MCP
              </TabsTrigger>
              <TabsTrigger value="skills" className={TAB_TRIGGER_CLASS}>
                <Wand2 className="size-4 shrink-0" />
                Skills
              </TabsTrigger>
              <TabsTrigger value="permissions" className={TAB_TRIGGER_CLASS}>
                <ShieldCheck className="size-4 shrink-0" />
                Permissions
              </TabsTrigger>
              <TabsTrigger value="hooks" className={TAB_TRIGGER_CLASS}>
                <Webhook className="size-4 shrink-0" />
                Hooks
              </TabsTrigger>
            </TabsList>
          </aside>

          <div className="flex-1 min-w-0 flex flex-col">
            <TabsContent
              value="general"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <GeneralForm />
            </TabsContent>
            <TabsContent
              value="models"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <ModelsPage />
            </TabsContent>
            <TabsContent
              value="providers"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <ProvidersForm />
            </TabsContent>
            <TabsContent
              value="capabilities"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <CapabilitiesForm />
            </TabsContent>
            <TabsContent
              value="memory"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <MemoryForm />
            </TabsContent>
            <TabsContent
              value="mcp"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <McpServersList />
            </TabsContent>
            <TabsContent
              value="skills"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <SkillsList />
            </TabsContent>
            <TabsContent
              value="permissions"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <PermissionsForm />
            </TabsContent>
            <TabsContent
              value="hooks"
              className="flex-1 min-w-0 min-h-0 overflow-y-auto px-6 py-6"
            >
              <HooksForm />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

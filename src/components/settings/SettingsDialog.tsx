import { Bot, KeyRound, Settings as SettingsIcon, Sparkles, Wand2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { McpIcon } from '@/components/icons/McpIcon';
import { ModelList } from './ModelList';
import { ProvidersForm } from './ProvidersForm';
import { CapabilitiesForm } from './CapabilitiesForm';
import { GeneralForm } from './GeneralForm';
import { McpServersList } from './McpServersList';
import { SkillsList } from './SkillsList';

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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            <div className="px-5 pt-5 pb-3">
              <DialogTitle
                className="text-foreground"
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
              <TabsTrigger value="mcp" className={TAB_TRIGGER_CLASS}>
                <McpIcon className="size-4 shrink-0" />
                MCP
              </TabsTrigger>
              <TabsTrigger value="skills" className={TAB_TRIGGER_CLASS}>
                <Wand2 className="size-4 shrink-0" />
                Skills
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
              <ModelList />
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
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

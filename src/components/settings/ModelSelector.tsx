import { Fragment } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, Check } from 'lucide-react';
import { useSettingsStore } from '@/store/settingsStore';
import {
  ProviderIcon,
  PROVIDER_DISPLAY_LABEL,
  PROVIDER_ORDER,
} from './ProviderIcon';

export function ModelSelector() {
  const { modelConfigs, activeModelId, setActiveModel } = useSettingsStore();
  const activeModel = modelConfigs.find((m) => m.id === activeModelId);

  if (modelConfigs.length === 0) {
    return (
      <span className="text-xs text-muted-foreground px-1">No models configured</span>
    );
  }

  const groups = PROVIDER_ORDER.map((p) => ({
    provider: p,
    models: modelConfigs.filter((m) => m.provider === p),
  })).filter((g) => g.models.length > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-muted-foreground
                   hover:text-foreground hover:bg-accent transition-colors max-w-[14rem]"
      >
        {activeModel && (
          <ProviderIcon provider={activeModel.provider} className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{activeModel?.name ?? 'Select model'}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem] max-w-[22rem]">
        {groups.map(({ provider, models }, i) => (
          <Fragment key={provider}>
            {i > 0 && (
              <DropdownMenuSeparator
                className="h-0 bg-transparent border-t border-dashed border-border/60 my-1.5"
              />
            )}
            <DropdownMenuGroup>
              <DropdownMenuLabel
                className="flex items-center gap-1.5 px-1.5 py-1
                           text-sm font-semibold text-foreground"
              >
                <ProviderIcon provider={provider} className="size-4 shrink-0" />
                <span>{PROVIDER_DISPLAY_LABEL[provider]}</span>
              </DropdownMenuLabel>
              {models.map((m) => {
                const active = m.id === activeModelId;
                return (
                  <DropdownMenuItem
                    key={m.id}
                    onClick={() => setActiveModel(m.id)}
                    className={`flex items-center gap-2 whitespace-nowrap pl-7 ${
                      active ? 'font-medium text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <span className="truncate flex-1">{m.name}</span>
                    <Check
                      className={`size-3 shrink-0 text-primary ${active ? 'opacity-100' : 'opacity-0'}`}
                    />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

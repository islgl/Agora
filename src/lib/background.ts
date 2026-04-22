export const MENUBAR_PANEL_WINDOW_LABEL = 'menubar-panel';
export const LAUNCHER_WINDOW_LABEL = 'launcher';

export type BackgroundAction =
  | 'new-conversation'
  | 'new-conversation-with-text'
  | 'open-settings'
  | 'open-agora'
  | 'hide-menubar-panel'
  | 'toggle-menubar-panel'
  | 'hide-launcher'
  | 'toggle-launcher'
  | 'quit';

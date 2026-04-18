/**
 * Lightweight platform detection that works in Tauri's webview without
 * needing the @tauri-apps/plugin-os plugin. Good enough to gate macOS-only
 * affordances like the native Share sheet.
 */
export const isMacOS: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = (navigator as Navigator & { platform?: string }).platform || '';
  return /Mac/i.test(platform) || /Mac OS X/i.test(ua);
})();

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { ModelConfig } from '@/types';
import { tauriProxyFetch } from './proxy-fetch';

/**
 * Resolve a `ModelConfig` (already merged with globalSettings by
 * `settingsStore.resolveModelConfig`) into a Vercel AI SDK `LanguageModel`
 * instance. API keys are stubbed with a placeholder — the real keys live
 * Rust-side and are injected by `proxy_ai_request` based on URL matching.
 */
export function modelForConfig(config: ModelConfig): LanguageModel {
  const provider = config.provider;
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  // Non-empty dummy so the providers don't bail in their own validation.
  const proxied = 'proxied-by-tauri';

  switch (provider) {
    case 'anthropic': {
      // Anthropic SDK hits `{baseURL}/messages`; our stored base is the
      // service root, so we append `/v1` here.
      const anthropic = createAnthropic({
        apiKey: proxied,
        baseURL: `${base}/v1`,
        fetch: tauriProxyFetch,
      });
      return anthropic(config.model);
    }
    case 'openai': {
      // Stored base already ends with `/v1` by default.
      const openai = createOpenAI({
        apiKey: proxied,
        baseURL: base,
        fetch: tauriProxyFetch,
      });
      return openai(config.model);
    }
    case 'gemini': {
      const google = createGoogleGenerativeAI({
        apiKey: proxied,
        baseURL: `${base}/v1beta`,
        fetch: tauriProxyFetch,
      });
      return google(config.model);
    }
  }
}

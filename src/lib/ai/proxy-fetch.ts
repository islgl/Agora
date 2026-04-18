import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * A `fetch`-compatible function that routes all HTTP traffic through a
 * Rust command. The Rust side owns the API keys (injected by URL-prefix
 * matching against `global_settings`) so they never touch the webview.
 *
 * The body is streamed back over a Tauri `Channel` in base64 chunks;
 * we reassemble it into a `Response` whose `body` is a `ReadableStream`,
 * exactly what the Vercel AI SDK expects from a custom fetch.
 */

type ProxyEvent =
  | { type: 'head'; status: number; headers: Record<string, string> }
  | { type: 'chunk'; bytes_base64: string }
  | { type: 'end' }
  | { type: 'error'; message: string };

export const tauriProxyFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = normalizeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = await readBody(init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined));

  // Deferred head — AI SDK awaits the Response before touching `.body`.
  let resolveResp!: (r: Response) => void;
  let rejectResp!: (e: Error) => void;
  const respPromise = new Promise<Response>((res, rej) => {
    resolveResp = res;
    rejectResp = rej;
  });

  // Streaming body. Close on 'end', error on 'error'.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const bodyStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const channel = new Channel<ProxyEvent>();
  let headDelivered = false;
  channel.onmessage = (event) => {
    switch (event.type) {
      case 'head':
        headDelivered = true;
        resolveResp(
          new Response(bodyStream, {
            status: event.status,
            headers: new Headers(event.headers),
          })
        );
        break;
      case 'chunk':
        try {
          controller.enqueue(base64ToBytes(event.bytes_base64));
        } catch {
          // stream may have been cancelled; swallow
        }
        break;
      case 'end':
        try {
          controller.close();
        } catch {
          // already closed
        }
        break;
      case 'error':
        if (!headDelivered) {
          rejectResp(new Error(event.message));
        }
        try {
          controller.error(new Error(event.message));
        } catch {
          // already closed
        }
        break;
    }
  };

  invoke('proxy_ai_request', {
    request: {
      url,
      method,
      headers,
      bodyBase64: bytesToBase64(body),
    },
    onEvent: channel,
  }).catch((err) => {
    if (!headDelivered) rejectResp(err instanceof Error ? err : new Error(String(err)));
    try {
      controller.error(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // noop
    }
  });

  return respPromise;
};

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    return Object.fromEntries(h);
  }
  return { ...(h as Record<string, string>) };
}

async function readBody(
  body: BodyInit | ArrayBuffer | null | undefined
): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
  // URLSearchParams / FormData: fall through to string coercion.
  return new TextEncoder().encode(String(body));
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

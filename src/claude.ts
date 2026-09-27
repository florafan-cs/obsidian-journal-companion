import { requestUrl } from "obsidian";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Minimal client for the Anthropic Messages API.
 *
 * Uses Obsidian's `requestUrl` instead of `fetch`, because it runs outside the
 * renderer's CORS restrictions and works on both desktop and mobile.
 */
export async function callClaude(opts: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  if (!opts.apiKey) {
    throw new Error("No API key set (Settings → Journal Companion).");
  }

  const res = await requestUrl({
    url: API_URL,
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey.trim(),
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
    throw: false,
  });

  if (res.status !== 200) {
    let message = res.text;
    try {
      message = res.json?.error?.message ?? message;
    } catch {
      // Body wasn't JSON; keep the raw text.
    }
    if (res.status === 401) message = "Invalid API key. Check it in the plugin settings.";
    throw new Error(`Claude API ${res.status}: ${message}`);
  }

  const blocks: Array<{ type: string; text?: string }> = res.json?.content ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

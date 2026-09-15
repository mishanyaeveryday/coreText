// Minimal Gemini API client: REST, no SDK.
// env.ts is generated from .env by scripts/writeEnv.mts before every build.
import { GEMINI_API_KEY, GEMINI_MODEL } from "./env.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_MODEL = GEMINI_MODEL || "gemini-3.8-flash";

export type ThinkingLevel = "low" | "medium" | "high";

export type GeminiOptions = {
  /** Instructions for the model: role, rules, output format. */
  system?: string;
  /** The actual input: page text, user query, etc. */
  user: string;
  /** JSON Schema of the answer. When set, Gemini returns JSON that matches it. */
  schema?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
};

type Part = { text?: string; thought?: boolean };

type GenerateContentResponse = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

/** Sends a request and returns the model's text answer. */
export async function askGemini(options: GeminiOptions): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is empty. Put it in .env and rebuild.");
  }

  const body = {
    ...(options.system && { systemInstruction: { parts: [{ text: options.system }] } }),
    contents: [{ role: "user", parts: [{ text: options.user }] }],
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      ...(options.thinkingLevel && { thinkingConfig: { thinkingLevel: options.thinkingLevel } }),
      ...(options.schema && { responseMimeType: "application/json", responseJsonSchema: options.schema }),
    },
  };

  const response = await fetch(`${BASE_URL}/${options.model ?? DEFAULT_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  const data = (await response.json()) as GenerateContentResponse;
  if (!response.ok) {
    throw new Error(`Gemini returned ${response.status}: ${data.error?.message ?? response.statusText}`);
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts
    ?.filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");

  if (!text) {
    const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? "empty response";
    throw new Error(`Gemini returned no text: ${reason}`);
  }
  return text;
}

/** Same as askGemini, but requires a schema and returns the parsed JSON. */
export async function askGeminiJson<T>(
  options: GeminiOptions & { schema: Record<string, unknown> },
): Promise<T> {
  return JSON.parse(await askGemini(options)) as T;
}
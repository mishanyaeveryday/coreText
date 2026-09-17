import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = join(import.meta.dirname, "..", ".env");
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const PROMPT = process.argv[2] ?? "Reply with the single word: ok";

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

function readApiKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  let contents: string;
  try {
    contents = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new Error(
      "No key found. Set GEMINI_API_KEY in the environment, or put GEMINI_API_KEY=... in .env",
    );
  }

  const key = contents
    .match(/^\s*GEMINI_API_KEY\s*=\s*(.+)$/m)?.[1]
    .trim()
    .replace(/^["']|["']$/g, "");

  if (!key) {
    throw new Error(`No GEMINI_API_KEY line in ${ENV_FILE}`);
  }
  return key;
}

async function main(): Promise<void> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      // The key goes in a header so it never lands in a URL or error message.
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": readApiKey(),
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }] }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  console.log(`model: ${MODEL}`);
  console.log(`prompt: ${PROMPT}`);
  console.log(`reply: ${text ?? JSON.stringify(data, null, 2)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

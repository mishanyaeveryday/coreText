# Stack & Architecture

## Decisions
- **No backend.** The Chrome extension calls the Gemini API directly.
- **No RAG, no embeddings.** The whole page goes into the Gemini context.
- **Ids, not quotes.** Gemini returns **sentence ids**, so every result maps to real text in the DOM and can always be highlighted.

## Stack
**Chrome extension, Manifest V3, TypeScript**
- `tsc` compiles `extension/src` → `extension/dist` (no bundler, no framework)
- `@types/chrome` for extension API types
- Gemini REST API via `fetch` (no SDK)
- Model: `gemini-3.8-flash` by default, override with `GEMINI_MODEL` in `.env`

## Project structure
```
coreText/
├── .env                    # GEMINI_API_KEY=..., GEMINI_MODEL= (gitignored)
├── .env.example
├── extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── src/
│   │   ├── gemini.ts       # Gemini client: askGemini / askGeminiJson
│   │   ├── env.ts          # generated from .env (gitignored, contains the key!)
│   │   ├── popup.ts
│   │   └── printPage.ts
│   └── dist/               # build output (gitignored, contains the key!)
└── scripts/
    ├── writeEnv.mts        # .env → extension/src/env.ts, runs before build/watch
    └── testGemini.mts      # quick check of the key: npm run gemini
```

Commands:
```bash
npm run build     # writeEnv + tsc
npm run watch     # writeEnv + tsc --watch
npm run gemini    # test the key from .env
```

Imports between extension files use the `.js` extension (tsc output is plain ES modules):
```ts
import { askGeminiJson } from "./gemini.js";
```

## Flow
```
content.ts                               background.ts (service worker)
──────────                               ──────────────────────────────
collect sentences [{id, text}] + query
        ── chrome.runtime.sendMessage ──►  fetch Gemini generateContent
                                           (key from generated env.ts)
                                           filter invalid ids
highlight ids + scroll  ◄───────────────   { matches: [12, 13] }
```

## Message contract
```ts
type Sentence = { id: number; text: string };

type SearchMessage = { type: "search"; query: string; sentences: Sentence[] };

type SearchResult =
  | { matches: number[] }                  // [] = not found on this page
  | { error: "api_error" };
```

## Gemini call
All Gemini requests go through `extension/src/gemini.ts`. Pass a system prompt, the input and any params:

```ts
import { askGeminiJson } from "./gemini.js";

const { matches } = await askGeminiJson<{ matches: number[] }>({
  system: SEARCH_SYSTEM_PROMPT,          // rules: ids only, max 5, [] if nothing
  user: `Query: ${query}\n\nSentences:\n${numbered}`,
  schema: {
    type: "object",
    properties: { matches: { type: "array", items: { type: "integer" } } },
    required: ["matches"],
  },
  temperature: 0,
  thinkingLevel: "low",                  // gemini-3.8-flash: low | medium | high
});
```

Options: `system`, `user`, `schema`, `model`, `temperature`, `maxOutputTokens`, `thinkingLevel`, `signal`.
Use `askGemini` (without a schema) for a plain text answer.

Tested live: a Ukrainian query against English sentences returned `{"matches":[2]}` in ~2.7 s.

## manifest.json: what to add for search
```json
{
  "background": { "service_worker": "dist/background.js", "type": "module" },
  "host_permissions": ["https://generativelanguage.googleapis.com/*"]
}
```

## Why ids, not quotes
Even with a strict prompt, an LLM can change a quote a little: whitespace, quote marks, dashes, trimming, fixing typos, or translating. Then the quote no longer matches the DOM and there is nothing to highlight.
With ids:
- a highlight always maps to real text
- the response is shorter and faster
- invented ids are easy to filter out

Trade-off: we highlight whole sentences, not exact fragments.

## API key
- The key lives in `.env`. Before each build `scripts/writeEnv.mts` writes it into `extension/src/env.ts`.
- `.env`, `extension/src/env.ts` and `extension/dist/` are gitignored. Never commit them or share the built extension: the key is inside.
- Fine for the MVP. For production: a thin proxy server that holds the key.

## Notes
- Call Gemini from `background.ts`, not from the content script (avoids page CSP/CORS issues).
- In `onMessage`, return `true` to keep `sendResponse` alive for the async call.
- Filter returned ids against the ids that were sent.
- Cap page text (e.g. ~200k chars) for huge pages.
- Show a spinner: a long page can take 2–6 s.
- Highlight with the CSS Custom Highlight API (does not change the DOM).

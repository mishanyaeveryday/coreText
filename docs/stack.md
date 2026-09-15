# Stack & Architecture

## Decisions
- **No backend.** The Chrome extension calls the Gemini API directly.
- **No RAG, no embeddings.** The whole page goes into the Gemini context.
- **Citations + tolerant matching.** Gemini returns verbatim quotes from the page; the extension finds them in the DOM ignoring whitespace, case, quote/dash styles, and falls back to shorter pieces of a quote.

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
│   │   ├── gemini.ts         # Gemini client: askGemini / askGeminiJson
│   │   ├── semanticSearch.ts # search prompt: query + page text → citations
│   │   ├── pageScripts.ts    # injected into the page: get text, highlight, navigate
│   │   ├── popup.ts          # search box UI
│   │   └── env.ts            # generated from .env (gitignored, contains the key!)
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
popup.ts                                         page (chrome.scripting.executeScript)
────────                                         ─────────────────────────────────────
Enter ─────────────────────────────────────────► getPageText(): document.body.innerText
findCitations(query, pageText) → Gemini
  { citations: ["Thus with a kiss I die.", …] }
       ─────────────────────────────────────────► highlightCitations(citations)
                                                   find each quote in text nodes → Range
                                                   CSS.highlights (no DOM changes)
↑ / ↓ ──────────────────────────────────────────► setActiveMatch(i): orange + scroll
```

## Files
- `extension/src/gemini.ts`: generic Gemini client (`askGemini`, `askGeminiJson`)
- `extension/src/semanticSearch.ts`: system prompt + `findCitations(query, pageText)`
- `extension/src/pageScripts.ts`: functions injected into the page. Each one must be self-contained (Chrome serializes it): no imports, no outside helpers.
- `extension/src/popup.ts`: search box, status, navigation

## Gemini call
All Gemini requests go through `extension/src/gemini.ts`. Pass a system prompt, the input and any params:

```ts
import { askGeminiJson } from "./gemini.js";

const { citations } = await askGeminiJson<{ citations: string[] }>({
  system: SYSTEM_PROMPT,                 // verbatim quotes only, all relevant (max 50), [] if nothing
  user: `Search query: ${query}\n\nPage text:\n<<<\n${pageText}\n>>>`,
  schema: {
    type: "object",
    properties: { citations: { type: "array", items: { type: "string" } } },
    required: ["citations"],
  },
  thinkingLevel: "low",                  // gemini-3.8-flash: low | medium | high
});
```

Options: `system`, `user`, `schema`, `model`, `temperature`, `maxOutputTokens`, `thinkingLevel`, `signal`.
Use `askGemini` (without a schema) for a plain text answer.

Tested on the full text of Romeo and Juliet (~170k chars), ~2–3 s per query:
- "romeo dies" → "Thy drugs are quick. Thus with a kiss I die."
- a Ukrainian query "Juliet wakes up in the tomb" → the scene where Juliet wakes
- "how to bake a cake" → no citations → "Not found on this page."

## Number of results
There is no setting: Gemini returns every relevant passage, best first, up to `MAX_CITATIONS = 50` (`semanticSearch.ts`).
The limit is a cap, not a target: the model never pads the list.
On Romeo and Juliet "romeo dies" returns about 13 passages, "how to bake a cake" returns none.

Questions are detected by the model (any language, with or without "?") and answered with passages that contain the answer, not passages that repeat the question's words:
- "who kills Tybalt?" → "Romeo slew Tybalt, Romeo must not live."
- "where does Romeo buy the poison?" → "SCENE I. Mantua. A street." and "he did buy a poison Of a poor 'pothecary"
- "what is the capital of France?" → not found (the model must not answer from its own knowledge)

## Order: Appearance / Importance
Gemini always returns citations best first. The page script keeps that index and sorts the matches:
- **Appearance**: top to bottom, like Ctrl+F.
- **Importance**: best match first.

Switching the order calls `reorderPageMatches` in the page: no new Gemini request.
The order is saved in the popup's `localStorage`.

## Why tolerant matching
Even with a strict prompt, an LLM can change a quote a little: whitespace, line breaks, quote marks, dashes, a skipped line. An exact search would then find nothing. So the page script:
1. builds one normalized string from all text nodes (no whitespace, lowercase, unified quotes/dashes) with a map back to each node and offset;
2. searches the normalized quote; quotes spanning several elements still match;
3. if not found, retries with fewer words from the start or the end (down to half of the quote).

## API key
- The key lives in `.env`. Before each build `scripts/writeEnv.mts` writes it into `extension/src/env.ts`.
- `.env`, `extension/src/env.ts` and `extension/dist/` are gitignored. Never commit them or share the built extension: the key is inside.
- Fine for the MVP. For production: a thin proxy server that holds the key.

## Notes
- Page text is capped at 400k chars (`MAX_PAGE_CHARS`).
- The Gemini request runs in the popup: closing the popup cancels a search in progress.
- Citations that could not be located are logged with `console.warn` in the popup DevTools.
- Highlight with the CSS Custom Highlight API (does not change the DOM).

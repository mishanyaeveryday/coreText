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

## Large pages: Gemini File Search
Pages longer than `MAX_PAGE_CHARS` (400k chars) don't go into the prompt. `extension/src/fileSearch.ts` instead:
1. hashes the page text (SHA-256) and looks for an index of this tab in `chrome.storage.session`;
2. if there is none, or the page text changed: creates a File Search store (`coretext-temp-<timestamp>`), uploads the text straight from memory (resumable upload, 200-token chunks) and waits until it is indexed;
3. runs the query through `/v1beta/interactions` with the `file_search` tool (at most 3 searches, `thinking_level: low`) and the same JSON schema (`citations`).

The citations then go through the same `highlightCitations` as small pages.

**The index lives as long as the tab.** Repeated searches on the same page skip indexing: no waiting for it and no extra indexing tokens.
The store is deleted when:
- the tab is closed (`background.ts`, `chrome.tabs.onRemoved`);
- the page text changes (the next search re-indexes and deletes the old store);
- indexing or the search fails;
- the browser starts again, or the popup opens, and a coreText store is not used by any open tab and is older than 15 min (`deleteUnusedStores`).

Privacy: nothing is written to disk. The tab → store mapping is in `chrome.storage.session` (memory, cleared when the browser closes); the page text only lives in Gemini while its tab is open.

Timing (Sherlock Holmes, 584k chars): first search ~35 s (indexing ~5 s + query), next searches on the same page skip indexing; the query itself takes 10–30 s depending on how many file searches the model runs. For 1.4M chars (Moby Dick) indexing takes ~25 s. Closing the popup cancels a search in progress (the index is kept).

Tested:
- Moby Dick: "how does captain ahab die" → "Ahab stooped to clear it; … the flying turn caught him round the neck…"
- Sherlock Holmes, same tab: 1st search indexed, 2nd search reused the store, changed text → re-indexed and the old store was deleted, tab closed → no stores left

Good pages to try: [Moby Dick](https://www.gutenberg.org/cache/epub/2701/pg2701-images.html), [War and Peace](https://www.gutenberg.org/cache/epub/2600/pg2600-images.html), [ECMAScript spec](https://tc39.es/ecma262/).

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
- Pages up to 400k chars go into the prompt (`MAX_PAGE_CHARS`); longer ones use File Search, capped at 20M chars (`MAX_FILE_SEARCH_CHARS`).
- The Gemini request runs in the popup: closing the popup cancels a search in progress.
- Citations that could not be located are logged with `console.warn` in the popup DevTools.
- Highlight with the CSS Custom Highlight API (does not change the DOM).

import { askGeminiJson } from "./gemini.js";

/** Longer pages are cut to keep requests fast (~100k tokens). */
export const MAX_PAGE_CHARS = 400_000;
export const MAX_CITATIONS = 6;

export type SearchOrder = "appearance" | "importance";

function getSystemPrompt(order: SearchOrder): string {
  const orderRule =
    order === "appearance"
      ? `- Return at most ${MAX_CITATIONS} citations that match the query by meaning, in the order they appear on the page (from top to bottom).`
      : `- Return at most ${MAX_CITATIONS} citations that match the query by meaning, ordered by importance (the best match first).`;

  return `You are a semantic search engine for a web page: Ctrl+F that understands meaning.

You receive the text of a page and a search query. The query describes what the user is looking for.
It can be a paraphrase, a question, a short description of an event, or written in another language.
Find the passages of the page that best match the query by meaning.

Rules:
${orderRule}
- Every citation MUST be copied verbatim from the page text: the same words, spelling, punctuation and order.
  Do not paraphrase, translate, shorten, fix typos or change capitalization.
- Each citation is one continuous span of the page, usually one sentence or one line (3 to 40 words).
  Never join text from different places and never use "...".
- Prefer passages that directly show or state what the query asks about.
  For example, for "romeo dies" return the lines where Romeo actually dies,
  not every line that mentions Romeo or death.
- If nothing on the page matches the query by meaning, return an empty list. Do not guess.`;
}

const SCHEMA = {
  type: "object",
  properties: {
    citations: {
      type: "array",
      items: { type: "string" },
      description: "Verbatim quotes from the page text.",
    },
  },
  required: ["citations"],
};

/** Asks Gemini for verbatim quotes from the page that match the query by meaning. */
export async function findCitations(
  query: string,
  pageText: string,
  order: SearchOrder = "appearance",
): Promise<string[]> {
  const { citations } = await askGeminiJson<{ citations: string[] }>({
    system: getSystemPrompt(order),
    user: `Search query: ${query}\n\nPage text:\n<<<\n${pageText.slice(0, MAX_PAGE_CHARS)}\n>>>`,
    schema: SCHEMA,
    thinkingLevel: "low",
  });

  return citations
    .map((citation) => citation.trim())
    .filter(Boolean)
    .slice(0, MAX_CITATIONS);
}
import { askGeminiJson } from "./gemini.js";

/** Longer pages are cut to keep requests fast (~100k tokens). */
export const MAX_PAGE_CHARS = 400_000;
/** Upper limit only: Gemini returns as many citations as are actually relevant. */
export const MAX_CITATIONS = 50;

/**
 * How the popup lists matches. Gemini always returns citations best first;
 * the page script sorts them into page order for "appearance".
 */
export type SearchOrder = "appearance" | "importance";

const SYSTEM_PROMPT = `You are a semantic search engine for a web page: Ctrl+F that understands meaning.

You receive the text of a page and a search query.
The query describes what the user is looking for. It can be a paraphrase, a question,
a short description of an event, or written in another language.
Find the passages of the page that match the query by meaning.

First decide what kind of query it is:
- A description or topic ("romeo dies", "refund policy"): find passages where this happens or is described.
- A question ("who kills Tybalt?", "how do I cancel my subscription", "when does the shop open"):
  treat it as a question even without "?" and in any language, if it asks who, what, when, where, why, how,
  how much, which, whether, or asks for instructions.
  Find the passages that ANSWER it, not passages that merely repeat the words of the question.
  The answer may use completely different words than the question:
  for "how to stop a request that hangs" the answer can be a sentence about the "timeout" parameter.
  Return the sentence or line that contains the answer itself; if the answer spans a few lines, return that span.
  If the page does not contain the answer, return an empty list, even if the topic is mentioned.
  Never answer from your own knowledge: only text that is on the page counts.

How many citations to return:
- Return all passages that are really relevant, and only those: 0, 1, 7 or ${MAX_CITATIONS}, whatever is really there.
- Order them from the best match to the weakest. The first ones must be the most exact matches.
- Never pad the list with unrelated text, and never return more than ${MAX_CITATIONS}.

How to write citations:
- Every citation MUST be copied verbatim from the page text: the same words, spelling, punctuation and order.
  Do not paraphrase, translate, shorten, fix typos or change capitalization.
- Each citation is one continuous span of the page, usually one sentence or one line (3 to 40 words).
  Never join text from different places, never use "...", never return the same passage twice.
- If nothing on the page matches, return an empty list. Do not guess.`;

const SCHEMA = {
  type: "object",
  properties: {
    citations: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_CITATIONS,
      description: "Verbatim quotes from the page text, best match first.",
    },
  },
  required: ["citations"],
};

/** Asks Gemini for verbatim quotes from the page that match the query, best match first. */
export async function findCitations(query: string, pageText: string): Promise<string[]> {
  const { citations } = await askGeminiJson<{ citations: string[] }>({
    system: SYSTEM_PROMPT,
    user: `Search query: ${query}\n\nPage text:\n<<<\n${pageText.slice(0, MAX_PAGE_CHARS)}\n>>>`,
    schema: SCHEMA,
    thinkingLevel: "low",
  });

  return [...new Set(citations.map((citation) => citation.trim()).filter(Boolean))].slice(0, MAX_CITATIONS);
}

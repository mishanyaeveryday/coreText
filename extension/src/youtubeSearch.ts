import { askGeminiJson } from "./gemini.js";
import { SearchOrder } from "./semanticSearch.js";
import type { YoutubeTranscriptSegment } from "./youtubeScripts.js";

/** Longer transcripts are cut to keep requests fast. */
export const MAX_TRANSCRIPT_CHARS = 200_000;
export const MAX_MOMENTS = 6;

function getSystemPrompt(order: SearchOrder): string {
  const orderRule =
    order === "appearance"
      ? `- Return at most ${MAX_MOMENTS} segment indices that match the query by meaning, in the order they appear in the video (lowest index first).`
      : `- Return at most ${MAX_MOMENTS} segment indices that match the query by meaning, ordered by importance (the best match first).`;

  return `You are given the transcript of a YouTube video, split into numbered timed segments.
A user describes a moment (or moments) they want to find in the video, in their own words, possibly in another language.

Find the segments where that moment happens or starts being discussed.

Rules:
${orderRule}
- Each index must point to a genuinely distinct moment. Never repeat the same index, and never
  return two indices that describe the same moment just because nearby segments overlap in wording.
- If nothing in the transcript matches the query, return an empty list. Do not guess.`;
}

const SCHEMA = {
  type: "object",
  properties: {
    indices: {
      type: "array",
      items: { type: "integer" },
      description: "Indices of the matching segments.",
    },
  },
  required: ["indices"],
};

function formatSegments(segments: YoutubeTranscriptSegment[]): string {
  let text = "";
  for (let i = 0; i < segments.length; i++) {
    const line = `[${i}] ${segments[i].text}\n`;
    if (text.length + line.length > MAX_TRANSCRIPT_CHARS) break;
    text += line;
  }
  return text;
}

/** Asks Gemini which transcript segments best match the query. */
export async function findMomentIndices(
  query: string,
  segments: YoutubeTranscriptSegment[],
  order: SearchOrder = "appearance",
): Promise<number[]> {
  const { indices } = await askGeminiJson<{ indices: number[] }>({
    system: getSystemPrompt(order),
    user: `Search query: ${query}\n\nTranscript segments:\n<<<\n${formatSegments(segments)}\n>>>`,
    schema: SCHEMA,
    thinkingLevel: "low",
  });

  const seen = new Set<number>();
  const unique = indices.filter((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= segments.length || seen.has(i)) return false;
    seen.add(i);
    return true;
  });

  return unique.slice(0, MAX_MOMENTS);
}

// Functions injected into the page with chrome.scripting.executeScript({ func }).
// Chrome serializes each function on its own, so every function must be
// self-contained: no imports and no helpers defined outside its body.

type CoretextMatch = {
  citation: string;
  startOffset: number;
  importanceIndex: number;
  range: Range;
};

type PageWindow = Window & {
  __coretextRanges?: Range[];
  __coretextMatches?: CoretextMatch[];
};

export function getPageText(maxLength: number): string {
  return (document.body?.innerText ?? "").slice(0, maxLength);
}

/**
 * Finds each citation in the page text and highlights it.
 * Matching ignores whitespace, case, quote and dash styles, so small differences
 * between Gemini's quote and the DOM still match. If a citation is not found,
 * shorter pieces of it are tried before giving up.
 */
export function highlightCitations(
  citations: string[],
  order: "appearance" | "importance" = "appearance",
): { found: number; missing: string[]; citationsInOrder: string[] } {
  const MATCH = "coretext-match";
  const ACTIVE = "coretext-active";
  const STYLE_ID = "coretext-highlight-style";
  const MIN_NEEDLE_LENGTH = 8;

  const normalizeChar = (char: string): string => {
    if (/\s/.test(char) || "­​‌‍﻿".includes(char)) return "";
    if ("‘’‚‛′`´".includes(char)) return "'";
    if ("“”„‟″«»".includes(char)) return '"';
    if ("‐‑‒–—―−".includes(char)) return "-";
    if (char === "…") return "...";
    return char.toLowerCase();
  };
  const normalize = (text: string): string => Array.from(text, normalizeChar).join("");

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ::highlight(${MATCH}) { background-color: #ffe066; color: inherit; }
      ::highlight(${ACTIVE}) { background-color: #ff9632; color: #000; }
    `;
    document.head.append(style);
  }

  // Build one normalized string for the whole page and remember where every
  // normalized character came from, so a match can be turned back into a Range.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT"
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  const nodeIndexes: number[] = [];
  const offsets: number[] = [];
  let pageText = "";

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node as Text).data;
    nodes.push(node as Text);
    for (let i = 0; i < text.length; i++) {
      for (const char of normalizeChar(text[i])) {
        pageText += char;
        nodeIndexes.push(nodes.length - 1);
        offsets.push(i);
      }
    }
  }

  const usedStarts = new Set<number>();
  const find = (words: string[]): [number, number] | null => {
    const needle = normalize(words.join(""));
    if (needle.length < MIN_NEEDLE_LENGTH) return null;
    for (let start = pageText.indexOf(needle); start !== -1; start = pageText.indexOf(needle, start + 1)) {
      if (!usedStarts.has(start)) return [start, needle.length];
    }
    return null;
  };

  const locate = (citation: string): [number, number] | null => {
    // Gemini sometimes wraps quotes or adds "...": search the longest piece.
    const piece = citation
      .split(/\.\.\.|…/)
      .map((part) => part.trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, ""))
      .sort((a, b) => b.length - a.length)[0];
    const words = piece.split(/\s+/).filter(Boolean);
    const minWords = Math.min(words.length, Math.max(3, Math.ceil(words.length / 2)));

    for (let count = words.length; count >= minWords; count--) {
      const match = find(words.slice(0, count)) ?? find(words.slice(words.length - count));
      if (match) return match;
    }
    return null;
  };

  const matches: Array<{
    citation: string;
    startOffset: number;
    importanceIndex: number;
    range: Range;
  }> = [];
  const missing: string[] = [];

  for (let i = 0; i < citations.length; i++) {
    const citation = citations[i];
    const match = locate(citation);
    if (!match) {
      missing.push(citation);
      continue;
    }
    const [start, length] = match;
    const end = start + length - 1;
    usedStarts.add(start);

    const range = document.createRange();
    range.setStart(nodes[nodeIndexes[start]], offsets[start]);
    range.setEnd(nodes[nodeIndexes[end]], offsets[end] + 1);

    matches.push({
      citation,
      startOffset: start,
      importanceIndex: i,
      range,
    });
  }

  if (order === "appearance") {
    matches.sort((a, b) => a.startOffset - b.startOffset);
  } else {
    matches.sort((a, b) => a.importanceIndex - b.importanceIndex);
  }

  const ranges = matches.map((m) => m.range);

  CSS.highlights.delete(ACTIVE);
  CSS.highlights.set(MATCH, new Highlight(...ranges));
  (window as PageWindow).__coretextRanges = ranges;
  (window as PageWindow).__coretextMatches = matches;

  return {
    found: ranges.length,
    missing,
    citationsInOrder: matches.map((m) => m.citation),
  };
}

/** Reorders existing page highlights without re-scanning or calling Gemini. */
export function reorderPageMatches(order: "appearance" | "importance"): {
  found: number;
  citationsInOrder: string[];
} {
  const MATCH = "coretext-match";
  type CoretextMatch = {
    citation: string;
    startOffset: number;
    importanceIndex: number;
    range: Range;
  };
  type PageWindow = Window & {
    __coretextRanges?: Range[];
    __coretextMatches?: CoretextMatch[];
  };

  const win = window as PageWindow;
  const matches = win.__coretextMatches ?? [];
  if (matches.length === 0) {
    return { found: 0, citationsInOrder: [] };
  }

  if (order === "appearance") {
    matches.sort((a, b) => a.startOffset - b.startOffset);
  } else {
    matches.sort((a, b) => a.importanceIndex - b.importanceIndex);
  }

  win.__coretextRanges = matches.map((m) => m.range);
  CSS.highlights.set(MATCH, new Highlight(...win.__coretextRanges));

  return {
    found: matches.length,
    citationsInOrder: matches.map((m) => m.citation),
  };
}

/** Marks match number `index` as active and scrolls to it. Returns the clamped index. */
export function setActiveMatch(index: number): number {
  const ACTIVE = "coretext-active";
  const ranges = (window as PageWindow).__coretextRanges ?? [];
  if (ranges.length === 0) return -1;

  const clamped = ((index % ranges.length) + ranges.length) % ranges.length;
  const range = ranges[clamped];
  CSS.highlights.set(ACTIVE, new Highlight(range));

  const container = range.startContainer;
  const element = container instanceof Element ? container : container.parentElement;
  element?.scrollIntoView({ behavior: "smooth", block: "center" });

  return clamped;
}

export function clearHighlights(): void {
  CSS.highlights.delete("coretext-match");
  CSS.highlights.delete("coretext-active");
  (window as PageWindow).__coretextRanges = [];
  (window as PageWindow).__coretextMatches = [];
}
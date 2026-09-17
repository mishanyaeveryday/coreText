// Functions injected into the YouTube watch page with chrome.scripting.executeScript({ func }).
// Chrome serializes each function on its own, so every function must be
// self-contained: no imports and no helpers defined outside its body.

export type YoutubeTranscriptSegment = { start: number; text: string };

/**
 * Fetches the transcript of the currently open video.
 *
 * Primary path: calls the same internal youtubei "get_transcript" endpoint that
 * YouTube's own "Show transcript" button calls, so nothing opens on screen.
 * Fallback: clicks that button itself (opening the transcript panel briefly)
 * and scrapes the panel it renders, in case the internal endpoint's shape
 * changes or the request is rejected. The panel is closed again afterwards.
 *
 * Returns null if there is no transcript available for this video.
 */
export async function fetchYoutubeTranscript(): Promise<YoutubeTranscriptSegment[] | null> {
  const parseJsonAfter = (html: string, marker: string): any => {
    const startIdx = html.indexOf(marker);
    if (startIdx === -1 || html[startIdx + marker.length] !== "{") return null;

    let i = startIdx + marker.length;
    let depth = 0;
    let inString: string | null = null;
    let escaped = false;
    let end = -1;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) return null;
    try {
      return JSON.parse(html.slice(startIdx + marker.length, end));
    } catch {
      return null;
    }
  };

  const scrapePanel = (): YoutubeTranscriptSegment[] => {
    const items = document.querySelectorAll("ytd-transcript-segment-renderer");
    const segments: YoutubeTranscriptSegment[] = [];
    items.forEach((item) => {
      const raw = (item.textContent ?? "").replace(/\s+/g, " ").trim();
      const match = raw.match(/^(\d{1,2}(?::\d{2}){1,2})\s+(.*)$/);
      if (!match) return;
      const start = match[1].split(":").reduce((acc, part) => acc * 60 + parseInt(part, 10), 0);
      const text = match[2].trim();
      if (text) segments.push({ start, text });
    });
    return segments;
  };

  // Walks the page's data tree looking for the transcript panel's continuation
  // token, wherever YouTube happens to nest it (avoids hardcoding an exact path
  // that can shift between layout versions).
  const findTranscriptParams = (node: unknown, depth = 0): string | null => {
    if (!node || typeof node !== "object" || depth > 40) return null;
    const obj = node as Record<string, any>;
    if (typeof obj.getTranscriptEndpoint?.params === "string") {
      return obj.getTranscriptEndpoint.params;
    }
    for (const key of Object.keys(obj)) {
      const found = findTranscriptParams(obj[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  // Primary: call the internal endpoint directly, invisibly.
  try {
    const html = await (await fetch(location.href)).text();
    const initialData = parseJsonAfter(html, "ytInitialData = ");
    const params = initialData ? findTranscriptParams(initialData) : null;
    const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    const clientVersion = html.match(/"clientVersion":"([^"]+)"/)?.[1] ?? "2.20240101.00.00";

    if (params && apiKey) {
      const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion } },
          params,
        }),
      });
      const data = await response.json();
      const initialSegments =
        data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content
          ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments ?? [];

      const segments: YoutubeTranscriptSegment[] = [];
      for (const item of initialSegments) {
        const renderer = item?.transcriptSegmentRenderer;
        if (!renderer) continue;
        const text = (renderer.snippet?.runs ?? [])
          .map((run: any) => run.text ?? "")
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        const startMs = Number(renderer.startMs);
        if (text && !Number.isNaN(startMs)) segments.push({ start: startMs / 1000, text });
      }
      if (segments.length > 0) return segments;
    }
  } catch {
    // Fall through to the DOM fallback below.
  }

  // If the panel is already open (user opened it themselves), just read it.
  const alreadyOpen = scrapePanel();
  if (alreadyOpen.length > 0) return alreadyOpen;

  // Last resort: open the "Show transcript" panel ourselves, scrape it, then
  // close it back so the page ends up looking the way it did before we ran.
  const transcriptButton = document.querySelector<HTMLElement>(
    "ytd-video-description-transcript-section-renderer button",
  );
  if (!transcriptButton) return null;

  transcriptButton.click();

  const waitForSegments = async (): Promise<YoutubeTranscriptSegment[]> => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = scrapePanel();
      if (found.length > 0) return found;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return [];
  };

  const segments = await waitForSegments();

  // Toggle it closed again — the same button now hides the panel.
  transcriptButton.click();

  return segments.length > 0 ? segments : null;
}

export type YoutubeMoment = { start: number; text: string; importanceIndex: number };
type YoutubeWindow = Window & { __coretextYoutubeMoments?: YoutubeMoment[] };

/** Stores the segments Gemini picked as the current match list, ordered as requested. */
export function setYoutubeMoments(
  segments: YoutubeTranscriptSegment[],
  order: "appearance" | "importance",
): { found: number; moments: YoutubeMoment[] } {
  const seenSeconds = new Set<number>();
  const moments: YoutubeMoment[] = segments
    .map((s, i) => ({ start: s.start, text: s.text, importanceIndex: i }))
    .filter((m) => {
      const rounded = Math.round(m.start);
      if (seenSeconds.has(rounded)) return false;
      seenSeconds.add(rounded);
      return true;
    });

  if (order === "appearance") {
    moments.sort((a, b) => a.start - b.start);
  } else {
    moments.sort((a, b) => a.importanceIndex - b.importanceIndex);
  }

  (window as YoutubeWindow).__coretextYoutubeMoments = moments;
  return { found: moments.length, moments };
}

/** Reorders the existing match list without re-scanning or calling Gemini. */
export function reorderYoutubeMoments(order: "appearance" | "importance"): {
  found: number;
  moments: YoutubeMoment[];
} {
  type YoutubeMoment = { start: number; text: string; importanceIndex: number };
  type YoutubeWindow = Window & { __coretextYoutubeMoments?: YoutubeMoment[] };

  const win = window as YoutubeWindow;
  const moments = win.__coretextYoutubeMoments ?? [];

  if (order === "appearance") {
    moments.sort((a, b) => a.start - b.start);
  } else {
    moments.sort((a, b) => a.importanceIndex - b.importanceIndex);
  }

  win.__coretextYoutubeMoments = moments;
  return { found: moments.length, moments };
}

/** Seeks the page's <video> to match number `index` and plays it. Returns the clamped index. */
export function setActiveYoutubeMoment(index: number): number {
  type YoutubeMoment = { start: number; text: string; importanceIndex: number };
  type YoutubeWindow = Window & { __coretextYoutubeMoments?: YoutubeMoment[] };

  const moments = (window as YoutubeWindow).__coretextYoutubeMoments ?? [];
  if (moments.length === 0) return -1;

  const clamped = ((index % moments.length) + moments.length) % moments.length;
  const video = document.querySelector("video");
  if (video) {
    video.currentTime = moments[clamped].start;
    void video.play();
  }

  return clamped;
}

export function clearYoutubeMoments(): void {
  (window as YoutubeWindow).__coretextYoutubeMoments = [];
}

import { clearHighlights, getPageText, highlightCitations, setActiveMatch } from "./pageScripts.js";
import { MAX_PAGE_CHARS, findCitations } from "./semanticSearch.js";

const input = document.querySelector<HTMLInputElement>("#search")!;
const count = document.querySelector<HTMLSpanElement>("#count")!;
const prevButton = document.querySelector<HTMLButtonElement>("#prev")!;
const nextButton = document.querySelector<HTMLButtonElement>("#next")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

let matchCount = 0;
let currentIndex = -1;
let searching = false;
// Ignores results of an older search when the user starts a new one.
let latestSearch = 0;

function updateCount(): void {
  if (searching) {
    count.textContent = "…";
  } else {
    count.textContent = matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : input.value ? "0/0" : "";
  }
  prevButton.disabled = matchCount === 0;
  nextButton.disabled = matchCount === 0;
}

function setStatus(message: string): void {
  status.textContent = message;
  status.hidden = message === "";
}

async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Result> {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result as Result;
}

async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function searchActivePage(rawQuery: string): Promise<void> {
  const search = ++latestSearch;
  const query = rawQuery.trim();
  const tabId = await getActiveTabId();

  if (tabId === undefined) {
    setStatus("No active tab.");
    return;
  }

  matchCount = 0;
  currentIndex = -1;
  searching = query !== "";
  setStatus("");
  updateCount();

  try {
    await runInPage(tabId, clearHighlights, []);
    if (!query) return;

    const pageText = await runInPage(tabId, getPageText, [MAX_PAGE_CHARS]);
    if (!pageText.trim()) {
      setStatus("This page has no text.");
      return;
    }

    const citations = await findCitations(query, pageText);
    if (search !== latestSearch) return;

    const { found, missing } = await runInPage(tabId, highlightCitations, [citations]);
    if (missing.length > 0) {
      console.warn("coreText: citations not found on the page", missing);
    }

    matchCount = found;
    searching = false;
    if (found === 0) {
      setStatus("Not found on this page.");
      return;
    }
    await goToMatch(tabId, 0);
  } catch (error) {
    if (search !== latestSearch) return;
    matchCount = 0;
    // Chrome blocks injection on chrome:// pages and the Web Store.
    setStatus(error instanceof Error ? error.message : "Could not search this page.");
  } finally {
    if (search === latestSearch) {
      searching = false;
      updateCount();
    }
  }
}

async function goToMatch(tabId: number, index: number): Promise<void> {
  currentIndex = await runInPage(tabId, setActiveMatch, [index]);
  updateCount();
}

async function step(delta: number): Promise<void> {
  if (matchCount === 0) return;
  const tabId = await getActiveTabId();
  if (tabId !== undefined) await goToMatch(tabId, currentIndex + delta);
}

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void searchActivePage(input.value);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    void step(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    void step(-1);
  }
});

prevButton.addEventListener("click", () => void step(-1));
nextButton.addEventListener("click", () => void step(1));

function pasteFromClipboard(): void {
  navigator.clipboard
    .readText()
    .then((text) => {
      input.value = text;
      input.select();
    })
    .catch(() => {
      // Clipboard unavailable (empty, permission denied, or non-text content).
    });
}

if (document.hasFocus()) {
  pasteFromClipboard();
} else {
  // Right after Alt+G the popup document isn't focused yet, so readText()
  // rejects with NotAllowedError. Retry once focus actually lands.
  window.addEventListener("focus", pasteFromClipboard, { once: true });
}

updateCount();

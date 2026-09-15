import {
  clearHighlights,
  getPageText,
  highlightCitations,
  reorderPageMatches,
  setActiveMatch,
} from "./pageScripts.js";
import { MAX_PAGE_CHARS, SearchOrder, findCitations } from "./semanticSearch.js";
import {
  clearYoutubeMoments,
  fetchYoutubeTranscript,
  reorderYoutubeMoments,
  setActiveYoutubeMoment,
  setYoutubeMoments,
} from "./youtubeScripts.js";
import { findMomentIndices } from "./youtubeSearch.js";

type Mode = "page" | "youtube";

const input = document.querySelector<HTMLInputElement>("#search")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear-btn")!;
const count = document.querySelector<HTMLSpanElement>("#count")!;
const prevButton = document.querySelector<HTMLButtonElement>("#prev")!;
const nextButton = document.querySelector<HTMLButtonElement>("#next")!;
const orderAppearanceBtn = document.querySelector<HTMLButtonElement>("#order-appearance")!;
const orderImportanceBtn = document.querySelector<HTMLButtonElement>("#order-importance")!;
const loader = document.querySelector<HTMLDivElement>("#loader")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const resultsContainer = document.querySelector<HTMLDivElement>("#results-container")!;
const resultsHeaderTitle = document.querySelector<HTMLSpanElement>("#results-header-title")!;
const resultsHeaderMode = document.querySelector<HTMLSpanElement>("#results-header-mode")!;
const resultsList = document.querySelector<HTMLUListElement>("#results-list")!;

let currentOrder: SearchOrder =
  (localStorage.getItem("coretext_search_order") as SearchOrder) || "appearance";
let currentMode: Mode = "page";
let matchCount = 0;
let currentIndex = -1;
let currentCitations: string[] = [];
let searching = false;
let lastSearchedQuery = "";
// Ignores results of an older search when the user starts a new one.
let latestSearch = 0;

function updateOrderButtons(): void {
  const isAppearance = currentOrder === "appearance";
  orderAppearanceBtn.classList.toggle("active", isAppearance);
  orderAppearanceBtn.setAttribute("aria-checked", String(isAppearance));
  orderImportanceBtn.classList.toggle("active", !isAppearance);
  orderImportanceBtn.setAttribute("aria-checked", String(!isAppearance));

  resultsHeaderMode.textContent = isAppearance ? "Appearance order" : "Importance order";
}

function updateActiveItemInList(): void {
  const items = resultsList.querySelectorAll<HTMLLIElement>(".result-item");
  items.forEach((item, idx) => {
    const isActive = idx === currentIndex;
    item.classList.toggle("active", isActive);
    if (isActive) {
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

function updateCount(): void {
  if (searching) {
    count.textContent = "…";
  } else {
    count.textContent = matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : input.value ? "0/0" : "";
  }
  prevButton.disabled = matchCount === 0 || searching;
  nextButton.disabled = matchCount === 0 || searching;
  updateActiveItemInList();
}

function setStatus(message: string, isError = true): void {
  status.textContent = message;
  status.style.display = message ? "block" : "none";
  status.classList.toggle("status-error", isError && !!message);
  status.classList.toggle("status-success", !isError && !!message);
}

function setSearching(isSearching: boolean): void {
  searching = isSearching;
  loader.style.display = isSearching ? "block" : "none";
  updateCount();
}

async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Result> {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result as Result;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getActiveTabId(): Promise<number | undefined> {
  return (await getActiveTab())?.id;
}

function isYoutubeWatchUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname === "/watch" && parsed.searchParams.has("v");
  } catch {
    return false;
  }
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderResultsList(tabId?: number): void {
  resultsList.innerHTML = "";
  if (matchCount === 0) {
    resultsContainer.style.display = "none";
    return;
  }

  resultsContainer.style.display = "flex";
  resultsHeaderTitle.textContent = `Matches (${matchCount})`;
  resultsHeaderMode.textContent = currentOrder === "appearance" ? "Appearance order" : "Importance order";

  currentCitations.forEach((citation, idx) => {
    const li = document.createElement("li");
    li.className = `result-item${idx === currentIndex ? " active" : ""}`;

    const badge = document.createElement("span");
    badge.className = "result-badge";
    badge.textContent = String(idx + 1);

    const content = document.createElement("div");
    content.className = "result-content";

    if (currentOrder === "importance" && idx === 0) {
      const tag = document.createElement("span");
      tag.className = "result-tag";
      tag.textContent = "★ Best match";
      content.appendChild(tag);
    }

    const snippet = document.createElement("span");
    snippet.className = "result-snippet";
    snippet.textContent = `"${citation}"`;
    content.appendChild(snippet);

    li.appendChild(badge);
    li.appendChild(content);

    li.addEventListener("click", () => {
      if (tabId !== undefined) {
        void goToMatch(tabId, idx);
      } else {
        void getActiveTabId().then((activeId) => {
          if (activeId !== undefined) void goToMatch(activeId, idx);
        });
      }
    });

    resultsList.appendChild(li);
  });
}

async function switchOrder(newOrder: SearchOrder): Promise<void> {
  if (currentOrder === newOrder) return;
  currentOrder = newOrder;
  localStorage.setItem("coretext_search_order", newOrder);
  updateOrderButtons();

  if (matchCount > 0) {
    const tabId = await getActiveTabId();
    if (tabId !== undefined) {
      if (currentMode === "youtube") {
        const result = await runInPage(tabId, reorderYoutubeMoments, [currentOrder]);
        currentCitations = result.moments.map((m) => `${formatTime(m.start)} — ${m.text}`);
        matchCount = result.found;
        renderResultsList(tabId);
        await goToMatch(tabId, 0);
      } else {
        const result = await runInPage(tabId, reorderPageMatches, [currentOrder]);
        if (result && result.citationsInOrder) {
          currentCitations = result.citationsInOrder;
          matchCount = result.found;
          renderResultsList(tabId);
          await goToMatch(tabId, 0);
        }
      }
    }
  }
}

async function searchActivePage(rawQuery: string): Promise<void> {
  const search = ++latestSearch;
  const query = rawQuery.trim();
  const tab = await getActiveTab();
  const tabId = tab?.id;

  if (tabId === undefined) {
    setStatus("No active tab.");
    return;
  }

  currentMode = isYoutubeWatchUrl(tab?.url) ? "youtube" : "page";
  matchCount = 0;
  currentIndex = -1;
  currentCitations = [];
  lastSearchedQuery = query;
  setStatus("");
  setSearching(query !== "");
  renderResultsList();

  try {
    if (currentMode === "youtube") {
      if (!query) return;

      const segments = await runInPage(tabId, fetchYoutubeTranscript, []);
      if (search !== latestSearch) return;
      if (!segments || segments.length === 0) {
        setStatus("This video has no transcript available.");
        return;
      }

      const indices = await findMomentIndices(query, segments, currentOrder);
      if (search !== latestSearch) return;

      const chosenSegments = indices.map((i) => segments[i]);
      const { found, moments } = await runInPage(tabId, setYoutubeMoments, [chosenSegments, currentOrder]);

      matchCount = found;
      currentCitations = moments.map((m) => `${formatTime(m.start)} — ${m.text}`);
      setSearching(false);

      if (found === 0) {
        setStatus("Not found in this video.");
        renderResultsList();
        return;
      }

      renderResultsList(tabId);
      await goToMatch(tabId, 0);
      return;
    }

    await runInPage(tabId, clearHighlights, []);
    if (!query) return;

    const pageText = await runInPage(tabId, getPageText, [MAX_PAGE_CHARS]);
    if (!pageText.trim()) {
      setStatus("This page has no text.");
      return;
    }

    const citations = await findCitations(query, pageText, currentOrder);
    if (search !== latestSearch) return;

    const { found, missing, citationsInOrder } = await runInPage(tabId, highlightCitations, [
      citations,
      currentOrder,
    ]);

    if (missing.length > 0) {
      console.warn("coreText: citations not found on the page", missing);
    }

    matchCount = found;
    currentCitations = citationsInOrder || [];
    setSearching(false);

    if (found === 0) {
      setStatus("Not found on this page.");
      renderResultsList();
      return;
    }

    renderResultsList(tabId);
    await goToMatch(tabId, 0);
  } catch (error) {
    if (search !== latestSearch) return;
    matchCount = 0;
    currentCitations = [];
    renderResultsList();
    // Chrome blocks injection on chrome:// pages and the Web Store.
    setStatus(error instanceof Error ? error.message : `Could not search this ${currentMode === "youtube" ? "video" : "page"}.`);
  } finally {
    if (search === latestSearch) {
      setSearching(false);
    }
  }
}

async function goToMatch(tabId: number, index: number): Promise<void> {
  currentIndex = await runInPage(tabId, currentMode === "youtube" ? setActiveYoutubeMoment : setActiveMatch, [index]);
  updateCount();
}

async function step(delta: number): Promise<void> {
  if (matchCount === 0) return;
  const tabId = await getActiveTabId();
  if (tabId !== undefined) await goToMatch(tabId, currentIndex + delta);
}

function clearSearch(): void {
  input.value = "";
  clearBtn.style.display = "none";
  matchCount = 0;
  currentIndex = -1;
  currentCitations = [];
  lastSearchedQuery = "";
  setStatus("");
  updateCount();
  renderResultsList();
  void getActiveTabId().then((tabId) => {
    if (tabId !== undefined) void runInPage(tabId, currentMode === "youtube" ? clearYoutubeMoments : clearHighlights, []);
  });
  input.focus();
}

input.addEventListener("input", () => {
  clearBtn.style.display = input.value ? "flex" : "none";
});

clearBtn.addEventListener("click", clearSearch);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const trimmed = input.value.trim();
    if (trimmed && trimmed === lastSearchedQuery && matchCount > 0) {
      // If pressing Enter again on the same search, jump to the next match like standard Ctrl+F!
      void step(1);
    } else {
      void searchActivePage(input.value);
    }
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

orderAppearanceBtn.addEventListener("click", () => void switchOrder("appearance"));
orderImportanceBtn.addEventListener("click", () => void switchOrder("importance"));

function pasteFromClipboard(): void {
  navigator.clipboard
    .readText()
    .then((text) => {
      input.value = text;
      clearBtn.style.display = text ? "flex" : "none";
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

void getActiveTab().then((tab) => {
  if (isYoutubeWatchUrl(tab?.url)) {
    input.placeholder = "Find a moment in this video...";
  }
});

updateOrderButtons();
updateCount();

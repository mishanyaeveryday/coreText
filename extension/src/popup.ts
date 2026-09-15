export {};

const input = document.querySelector<HTMLInputElement>("#search")!;
const prevButton = document.querySelector<HTMLButtonElement>("#prev")!;
const nextButton = document.querySelector<HTMLButtonElement>("#next")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

function highlightMatches(query: string): number {
  const markClass = "__coretext_highlight__";

  document.querySelectorAll(`mark.${markClass}`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  });

  if (!query) return 0;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT", "STYLE", "MARK"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  const lowerQuery = query.toLowerCase();
  let count = 0;

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    const lowerText = text.toLowerCase();
    let index = lowerText.indexOf(lowerQuery);
    if (index === -1) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    while (index !== -1) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
      const mark = document.createElement("mark");
      mark.className = markClass;
      mark.textContent = text.slice(index, index + query.length);
      fragment.appendChild(mark);
      count++;
      lastIndex = index + query.length;
      index = lowerText.indexOf(lowerQuery, lastIndex);
    }
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.parentNode?.replaceChild(fragment, textNode);
  }

  return count;
}

function setActiveMatch(index: number): number {
  const markClass = "__coretext_highlight__";
  const marks = Array.from(document.querySelectorAll<HTMLElement>(`mark.${markClass}`));
  if (marks.length === 0) return -1;

  marks.forEach((mark) => {
    mark.style.backgroundColor = "";
  });

  const clamped = ((index % marks.length) + marks.length) % marks.length;
  const active = marks[clamped];
  active.style.backgroundColor = "orange";
  active.scrollIntoView({ behavior: "smooth", block: "center" });

  return clamped;
}

let matchCount = 0;
let currentIndex = -1;

async function searchActivePage(query: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id === undefined) {
    status.textContent = "No active tab.";
    return;
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightMatches,
      args: [query],
    });
    matchCount = result?.result ?? 0;
    currentIndex = -1;

    if (matchCount > 0) {
      await goToMatch(tab.id, 0);
    } else {
      status.textContent = query ? "0 matches" : "";
    }
  } catch (error) {
    matchCount = 0;
    currentIndex = -1;
    status.textContent = error instanceof Error ? error.message : "Could not read this page.";
  }
}

async function goToMatch(tabId: number, index: number): Promise<void> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: setActiveMatch,
    args: [index],
  });
  currentIndex = result?.result ?? -1;
  status.textContent = matchCount > 0 ? `${currentIndex + 1} / ${matchCount}` : "0 matches";
}

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void searchActivePage(input.value);
    return;
  }

  if (matchCount === 0) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    void withActiveTab((tabId) => goToMatch(tabId, currentIndex + 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    void withActiveTab((tabId) => goToMatch(tabId, currentIndex - 1));
  }
});

async function withActiveTab(callback: (tabId: number) => Promise<void>): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  await callback(tab.id);
}

prevButton.addEventListener("click", () => {
  if (matchCount === 0) return;
  void withActiveTab((tabId) => goToMatch(tabId, currentIndex - 1));
});

nextButton.addEventListener("click", () => {
  if (matchCount === 0) return;
  void withActiveTab((tabId) => goToMatch(tabId, currentIndex + 1));
});

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

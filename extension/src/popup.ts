export {};

const button = document.querySelector<HTMLButtonElement>("#print")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

async function printActivePage(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id === undefined) {
    status.textContent = "No active tab.";
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["dist/printPage.js"],
    });
    status.textContent = "Printed to the page console.";
  } catch (error) {
    // Chrome blocks injection on chrome:// pages and the Web Store.
    status.textContent =
      error instanceof Error ? error.message : "Could not read this page.";
  }
}

button.addEventListener("click", () => {
  void printActivePage();
});

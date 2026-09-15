// Service worker: deletes File Search indexes that are no longer needed.
import { deleteUnusedStores, releaseTabStore } from "./fileSearch.js";

// The index of a page lives as long as its tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseTabStore(tabId);
});

// Tabs from the last session are gone, so their indexes are unused now.
chrome.runtime.onStartup.addListener(() => {
  deleteUnusedStores().catch((error) => {
    console.warn("coreText: could not clean up File Search stores", error);
  });
});

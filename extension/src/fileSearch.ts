// Gemini File Search for pages that are too long to send in one request.
// The page text is uploaded straight from memory (never written to disk) and
// indexed in a File Search store. The store is kept while the tab is open, so
// repeated searches on the same page skip indexing, and deleted when the tab
// closes (see background.ts) or the page text changes.
import { DEFAULT_MODEL } from "./gemini.js";
import { GEMINI_API_KEY } from "./env.js";

const API = "https://generativelanguage.googleapis.com";
/** Every store we create starts with this, so leftovers can be found and removed. */
const STORE_PREFIX = "coretext-temp";
/** Unused stores older than this are leftovers (closed popup, crashed browser) and get deleted. */
const LEFTOVER_AGE_MS = 15 * 60 * 1000;
/** chrome.storage.session key: tab id → the store indexed for that tab. Kept in memory only. */
const CACHE_KEY = "coretext.fileSearchStores";
const POLL_INTERVAL_MS = 2000;
const INDEX_TIMEOUT_MS = 5 * 60 * 1000;

type Operation = { name: string; done?: boolean; error?: { message?: string } };
type Store = { name: string; displayName?: string; createTime?: string };
type InteractionStep = { type: string; content?: { type?: string; text?: string }[] };
type CachedStore = { storeName: string; textHash: string; ready: boolean };
type StoreCache = Record<string, CachedStore>;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is empty. Put it in .env and rebuild.");
  }
  return { "x-goog-api-key": GEMINI_API_KEY, ...extra };
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gemini File Search ${response.status}: ${data?.error?.message ?? response.statusText}`);
  }
  return data as T;
}

async function createStore(): Promise<string> {
  const store = await request<Store>(`${API}/v1beta/fileSearchStores`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ displayName: `${STORE_PREFIX}-${Date.now()}` }),
  });
  return store.name;
}

export async function deleteStore(storeName: string): Promise<void> {
  // force=true also deletes the documents inside the store.
  await request(`${API}/v1beta/${storeName}?force=true`, { method: "DELETE", headers: headers() });
}

/** Uploads text with a resumable upload and waits until it is indexed. */
async function uploadText(storeName: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);

  const start = await fetch(`${API}/upload/v1beta/${storeName}:uploadToFileSearchStore`, {
    method: "POST",
    headers: headers({
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": "text/plain",
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      displayName: "page.txt",
      mimeType: "text/plain",
      // Small chunks map more tightly onto passages we can highlight.
      chunkingConfig: { whiteSpaceConfig: { maxTokensPerChunk: 200, maxOverlapTokens: 20 } },
    }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) {
    throw new Error(`Gemini File Search upload failed: ${start.status} ${await start.text()}`);
  }

  let operation = await request<Operation>(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
  });

  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  while (!operation.done) {
    if (Date.now() > deadline) throw new Error("Indexing the page took too long.");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    operation = await request<Operation>(`${API}/v1beta/${operation.name}`, { headers: headers() });
  }
  if (operation.error) {
    throw new Error(`Indexing the page failed: ${operation.error.message ?? "unknown error"}`);
  }
}

async function searchStore(
  storeName: string,
  options: { system: string; input: string; schema: Record<string, unknown> },
): Promise<string> {
  const interaction = await request<{ steps?: InteractionStep[] }>(`${API}/v1beta/interactions`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      system_instruction: options.system,
      input: options.input,
      tools: [{ type: "file_search", file_search_store_names: [storeName] }],
      response_format: { type: "text", mime_type: "application/json", schema: options.schema },
      generation_config: { thinking_level: "low" },
    }),
  });

  const text = (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .map((content) => content.text ?? "")
    .join("");
  if (!text) throw new Error("Gemini File Search returned no answer.");
  return text;
}

export type FileSearchStage = "indexing" | "searching";

function sessionStorage(): chrome.storage.SessionStorageArea {
  // Undefined when Chrome still runs an old manifest without the "storage" permission.
  if (!chrome.storage?.session) {
    throw new Error("The extension was updated: reload it in chrome://extensions (↻), then try again.");
  }
  return chrome.storage.session;
}

async function readCache(): Promise<StoreCache> {
  const { [CACHE_KEY]: cache = {} } = await sessionStorage().get(CACHE_KEY);
  return cache as StoreCache;
}

async function updateCache(change: (cache: StoreCache) => void): Promise<void> {
  const cache = await readCache();
  change(cache);
  await sessionStorage().set({ [CACHE_KEY]: cache });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function warnDelete(storeName: string) {
  return (error: unknown) => console.warn("coreText: could not delete File Search store", storeName, error);
}

/** Deletes the store of a tab, e.g. when the tab is closed. */
export async function releaseTabStore(tabId: number): Promise<void> {
  const entry = (await readCache())[tabId];
  if (!entry) return;
  await updateCache((cache) => delete cache[tabId]);
  await deleteStore(entry.storeName).catch(warnDelete(entry.storeName));
}

/** Returns a ready store with `text` indexed for this tab, indexing it only when needed. */
async function getTabStore(tabId: number, text: string, onStage: (stage: FileSearchStage) => void): Promise<string> {
  const textHash = await sha256(text);
  const cached = (await readCache())[tabId];
  if (cached?.ready && cached.textHash === textHash) return cached.storeName;

  // Different page text, or indexing never finished (popup closed mid-upload).
  if (cached) await releaseTabStore(tabId);

  onStage("indexing");
  const storeName = await createStore();
  // Remember the store before uploading, so closing the tab still deletes it.
  await updateCache((cache) => (cache[tabId] = { storeName, textHash, ready: false }));
  try {
    await uploadText(storeName, text);
  } catch (error) {
    await releaseTabStore(tabId);
    throw error;
  }
  await updateCache((cache) => (cache[tabId] = { storeName, textHash, ready: true }));
  return storeName;
}

/**
 * Searches a long page with File Search. The index is reused for the same tab
 * and page text; the first search on a page also indexes it (~25 s for 1.4M chars).
 */
export async function searchLargeText(
  tabId: number,
  text: string,
  options: { system: string; input: string; schema: Record<string, unknown> },
  onStage: (stage: FileSearchStage) => void = () => {},
): Promise<string> {
  const storeName = await getTabStore(tabId, text, onStage);
  onStage("searching");
  try {
    return await searchStore(storeName, options);
  } catch (error) {
    // The store may be gone (deleted elsewhere): forget it so the next search re-indexes.
    await releaseTabStore(tabId);
    throw error;
  }
}

/**
 * Deletes coreText stores that no open tab uses: leftovers from a browser that was
 * closed with tabs open, or from a failed cleanup. Recent stores are kept because
 * another popup may be indexing them right now.
 */
export async function deleteUnusedStores(): Promise<void> {
  const { fileSearchStores = [] } = await request<{ fileSearchStores?: Store[] }>(
    `${API}/v1beta/fileSearchStores?pageSize=20`,
    { headers: headers() },
  );
  const inUse = new Set(Object.values(await readCache()).map((entry) => entry.storeName));
  const now = Date.now();
  const unused = fileSearchStores.filter(
    (store) =>
      store.displayName?.startsWith(STORE_PREFIX) &&
      !inUse.has(store.name) &&
      now - Date.parse(store.createTime ?? "") > LEFTOVER_AGE_MS,
  );
  await Promise.all(unused.map((store) => deleteStore(store.name).catch(warnDelete(store.name))));
}

# coreText

**Ctrl+F by meaning.** A Chrome extension that finds passages on a page by meaning, not by exact words.

Type `romeo dies` and it jumps to *"Thus with a kiss I die."* If nothing on the page matches, it says **Not found on this page**.

## What you need
- [Node.js](https://nodejs.org) 24 (or 22.18+): scripts are TypeScript run directly by Node
- Google Chrome
- A Gemini API key: get one for free in [Google AI Studio](https://aistudio.google.com/apikey)

## Run it

**1. Install dependencies**
```bash
npm install
```

**2. Add your API key**
```bash
cp .env.example .env
```
Open `.env` and paste your key:
```
GEMINI_API_KEY=your-key-here
```

**3. Build**
```bash
npm run build
```

**4. Load the extension in Chrome**
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension` folder

## Use it
1. Open any page with text, e.g. [Romeo and Juliet](https://shakespeare.mit.edu/romeo_juliet/full.html)
2. Press **Alt+G** (or click the coreText icon)
3. Select your preferred order:
   - **Appearance**: Results ordered from top to bottom as they appear on the page (Ctrl+F style)
   - **Importance**: Results ordered by semantic relevance (best match first)
4. Type what you are looking for and press **Enter**
5. Use **↑ / ↓** to jump between matches, or click any card in the results list to jump directly to it

## After changing code
Run `npm run build` again, then click **↻ Reload** on the extension in `chrome://extensions`.

Tip: `npm run watch` rebuilds automatically on every change.

## Commands
| Command | What it does |
| --- | --- |
| `npm run build` | Build the extension |
| `npm run watch` | Rebuild on every change |
| `npm run gemini` | Check that your API key works |

## Troubleshooting
- **Nothing happens / error about the key**: check `.env`, then run `npm run build` and reload the extension.
- **Doesn't work on some pages**: Chrome doesn't allow extensions on `chrome://` pages and the Web Store.
- **Search stopped**: the popup was closed. Keep it open until results appear.

> ⚠️ Never commit `.env` or share the `extension/dist` folder: your API key is inside.

More details: [docs/stack.md](docs/stack.md) · [docs/use-case.md](docs/use-case.md)
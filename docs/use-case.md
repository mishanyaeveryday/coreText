# Use Case: Find meaning in long documentation

## Actor
A developer reading technical documentation for a library they are new to.

## Situation
Their HTTP requests sometimes hang forever. They open the library's docs: one very long page with hundreds of paragraphs.

## Problem
Ctrl+F only finds exact words. They search for "hangs" or "stop waiting" and get 0 results. They don't know that the docs call it a **timeout**.

## Solution
The developer opens the extension and describes the problem in their own words:

> "how to stop a request if the server doesn't answer"

## Main flow
1. The extension reads the text on the page.
2. It finds the sentences closest in meaning to the query.
3. It highlights the best matches and scrolls to the first one.
4. The user presses Enter to jump to the next match.

## Result
In a few seconds the page scrolls to:

> *"You can tell Requests to stop waiting for a response after a given number of seconds with the `timeout` parameter."*

The developer finds the answer without knowing the right keyword.

## Alternative flow: no answer on the page
The user asks "how to upload files over FTP", and the docs don't cover it. The extension shows **"Not found on this page"** and highlights nothing, so there are no false answers.

## Bonus: any language
The same works when the query and the page are in different languages. You can ask in your native language and still get the highlight in English docs.

## Another example: a book
A student reads a long novel online and asks:

> "where does the main character decide to leave home"

The extension highlights the passage, even though the text never uses the words "decide" or "leave home".

## One-liner
> **Ctrl+F by meaning.** Describe what you need and see it highlighted on the page.

## Minimal flow
```
User query → extension collects numbered sentences from the page
           → backend: whole page + query → Gemini → ids of matching sentences
           → extension highlights sentences by id + scrolls
```

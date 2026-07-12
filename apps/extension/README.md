# @jargonslayer/extension — JargonSlayer Lite (Chrome MV3)

Chrome side-panel extension: paste English business text, get instant Chinese
explanations for idioms/jargon and business/tech terms (from
`@jargonslayer/core`'s built-in dictionary), plus — when Chrome's on-device
Translator API is available — a full translation of the pasted text. No
login, no API key, no cost.

Part of [PLAN-v0.4](../../docs/PLAN-v0.4.md) session S6 ("extension scaffold
+ side panel + dictionary + Translator API"). Mic capture (Web Speech) lands
in S7 — this build only accepts pasted/typed text.

## Load unpacked (development)

From the repo root:

```
npm ci
npm run build:extension
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `apps/extension/dist`
5. Click the JargonSlayer toolbar icon — the side panel opens

For active development, run `npm run dev -w apps/extension` instead of
`build:extension` (CRXJS's Vite plugin rebuilds `dist/` on save with HMR);
load-unpacked the same `apps/extension/dist` folder once, and it keeps
picking up saved changes.

## What works in S6

- Side panel opens via the toolbar action
  (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`,
  set once in the service worker on install)
- Paste/type English text → **检测 · Scan** → dictionary-detected cards:
  - **Expression cards** — headword + zh explanation + the source sentence
    it matched in, color-coded by category (idiom/slang/phrase/metaphor/
    indirect/other), mirroring `apps/web`'s `CardsPanel.tsx` color
    convention
  - **Term cards** — term + zh gloss (acronyms, metrics, etc.)
  - Uses `@jargonslayer/core`'s **built-in packs only** (428 expressions /
    11 packs). Remote/community pack loading
    (`detect/remotePacksRegistry.ts`) is `apps/web`-only machinery (fetch +
    idb-keyval) this app never calls — see the comment at the top of
    `src/sidepanel/main.ts`. Personal-glossary shadowing is a no-op for the
    same reason.
- **收藏** (save) any card → `chrome.storage.local`, real persistence that
  survives panel close/reopen (`src/storage/savedLookups.ts`); an
  already-saved card's button greys out on the next scan
- **Chrome's built-in Translator API** (Chrome 138+, on-device, free)
  translates the pasted text to Simplified Chinese on click. Feature-detected
  (`typeof Translator !== "undefined"`); when the API doesn't exist at all,
  the whole translate section is hidden — dictionary zh glosses need no
  translation regardless, so nothing is lost. When it exists but the model
  needs a first-use download, the status line shows live download progress
  (`downloadable` → `downloading NN%` → `available`)
- **Chrome's built-in LanguageDetector API** gives a soft, non-blocking hint
  in the scan-status line when the pasted text doesn't look like English
  (dictionary matching itself doesn't care — this is advisory only)

## What's deferred (S7/S8)

- **S7**: Web Speech mic capture (port of the shipped `webSpeechSession` +
  VAD-supervisor hardening) — the biggest remaining piece; S6 is
  paste/type-only. A real history/glossary surface beyond the raw
  `chrome.storage.local` stub here. Copy/export.
- **S8**: Chrome Web Store packaging + submission, zh copy polish pass.

## Permissions

- `sidePanel` — required to open/configure the side panel
- `storage` — `chrome.storage.local`, backing the 收藏 stub above

No `host_permissions`, no content scripts, no remote code — matches
PLAN-v0.4 §1C's "side panel is the app, the service worker is a stateless
coordinator" decision, and PRODUCT.md's "not a word-by-word lookup
extension" stance (content-script select→explain on arbitrary pages is v2,
out of scope here). The manifest carries no `content_security_policy`
override, so MV3's default (no remote code, no eval) applies as-is.

## Architecture notes

- **Vanilla TypeScript + DOM, not React** for the panel UI (`src/sidepanel/
  render.ts` + `main.ts`): the S6 UI is a straightforward paste → scan →
  render-a-card-list loop with no complex client state, so a thin
  `document.createElement`-based render layer avoids pulling in React +
  `@vitejs/plugin-react` + the CRXJS/React-refresh integration surface for
  very little payoff at this scope. Each `render*Card` function maps 1:1 to
  what would become a component if a later session (S7's mic-streaming
  state is a much better fit for real component reactivity) moves this to
  React — that's the "keep it swappable" ask.
- **Translator/LanguageDetector availability** is split pure/impure, the
  same pattern `packages/core` already uses for its own browser-dependent
  registries (e.g. `detect/remotePacksRegistry.ts`'s in-memory cache vs
  `apps/web`'s impure fetch loader): `src/translate/availability.ts` is a
  pure, fully unit-tested reducer (`reduceCapabilityState`) around a 6-state
  `CapabilityAvailability` (`unsupported | unavailable | downloadable |
  downloading | available | error`); `src/translate/translator.ts` and
  `languageDetector.ts` are thin, untested adapters that call the real
  `self.Translator` / `self.LanguageDetector` globals and drive the reducer.
- **Saved-lookup shape** (`src/storage/savedLookups.ts`) is its own local
  type, not core's `CustomEntry` — see that file's header comment for why
  (avoids pulling in web-app/SRS-specific bookkeeping fields that don't
  apply to a one-shot paste-and-scan yet), while still mirroring
  `CustomEntry`'s field naming so a future shared-shape unification is a
  mapping, not a redesign. Saves are **local-only** (`chrome.storage.local`
  on this device/profile, never synced anywhere) and intentionally store
  the verbatim example sentence a card was matched in — correct product
  behavior, matching the web app's own local-first history/glossary, not
  something to strip on a future pass.
- Styling (`src/sidepanel/panel.css`) hand-copies `apps/web`'s terminal
  theme's hex tokens and its expression/term card color-bar convention, but
  does **not** port the CSS-variable theme engine, Tailwind, or the
  self-hosted JetBrains Mono font (no network font fetch inside an
  extension) — system monospace fallback stack only.

## A note on the Translator/LanguageDetector API shape

Chrome's built-in AI APIs are new and still evolving. The adapters here were
written against `developer.chrome.com/docs/ai/translator-api` /
`.../language-detection` and the DefinitelyTyped `@types/dom-chromium-ai`
package's ambient types at the time of writing, including a defensive
`normalizeDownloadProgress` that handles Chrome's real (non-spec) behavior of
putting a 0–1 fraction directly in the `downloadprogress` event's `.loaded`.
This has **not** been exercised against a real Chrome 138+ browser (no such
environment is available in this dev sandbox) — re-verify the translate
button's behavior specifically during your first load-unpacked pass.

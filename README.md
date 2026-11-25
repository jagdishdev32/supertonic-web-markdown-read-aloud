# Read Aloud — standalone app

The reader from the [markdown-read-aloud](https://github.com/Robin-Reiche/markdown-read-aloud)
VS Code extension as a standalone web app: paste Markdown, it renders and reads
it aloud through a local [Supertonic](https://github.com/supertone-inc/supertonic)
server (or Edge / system voices). Same UI, same engines, nothing leaves the
machine in Supertonic mode. MIT licensed, like the extension.

## Run with Docker (recommended)

Default — Supertonic installed fresh inside Docker (first start downloads the
~260 MB model once, into a named volume):

```sh
docker compose up --build -d
# UI   → http://127.0.0.1:7789
# API  → 127.0.0.1:7788 (also usable by the VS Code extension)
```

Use a Supertonic server already running on this machine instead (Linux):

```sh
docker compose -f compose.local.yml up --build -d
```

(On Docker Desktop for Mac/Windows, use the default compose file plus `.env`
with `SUPERTONIC_ENDPOINT=http://host.docker.internal:7788`.)

## Run without Docker

Requires Node ≥ 18. `host.cjs` is prebuilt and committed, so `npm install` is
only needed to rebuild it.

```sh
npm install --ignore-scripts   # only when rebuilding (msedge-tts gates scripts to pnpm)
node server.mjs                # → http://127.0.0.1:7789
```

Desktop-style window, no browser chrome:

```sh
google-chrome --app=http://127.0.0.1:7789   # or chromium --app=…
```

## Use

- Paste box opens on start (✎ button or Ctrl+Shift+V) → paste Markdown →
  **Render & read**.
- Right-click ✎ (or Ctrl+,) → app settings: engine (Supertonic / Edge /
  system voices), Supertonic endpoint, voice overrides.
- Supertonic voice styles are `F1–F5` / `M1–M5`, e.g. `{"de-DE": "F2"}`;
  Edge names in the same map are ignored in Supertonic mode and vice versa.
- Speed, volume, gender, language live in the reader UI itself.
- **Smart pauses** (app settings): appends a sentence gap scaled by 1/√speed —
  ~350 ms at 1×, ~250 ms at 2× — so faster speed doesn't squash the pauses that
  keep fast speech intelligible. Supertonic (WAV) only.

## Layout

- `server.mjs` — zero-dependency HTTP server (render + synth API, static UI)
- `host.ts` → `host.cjs` — the extension's engines bundled with esbuild
  (`npm run build` to regenerate; a `vscode` stub stands in for the one
  `vscode.env.language` read in `src/voices.ts`)
- `src/` — the subset of extension sources the bundle needs
- `media/` — reader UI (JS/CSS) and the Inter, Literata, Atkinson Hyperlegible
  and IBM Plex Mono fonts
- `supertonic-server-requirements.lock.txt` — pinned Python deps for the
  Supertonic server image (supertonic 1.3.1)
- Settings persist in `settings.json` (bare) or `data/settings.json` (Docker);
  point `SUPERTONIC_ENDPOINT` at any loopback server via env

## Not available (yet)

Audio export, live document-follow, resume positions, pronunciations editor
(pronunciations from `settings.json` are honored, just not editable in the UI).

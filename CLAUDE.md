# chess-puzzle-breaks

A published VS Code extension (publisher `HumphreyUno`) that shows Lichess chess puzzles in a webview. The command `chess-puzzle-breaks.showPuzzle` opens an interactive board; solves are tracked in `globalState`.

## Layout

- `src/extension.ts` — activation; only registers the command. Everything else is lazy.
- `src/commands/` — command handlers.
- `src/db/` — puzzle database download (`ensure-database.ts`), lazy open with retry (`database-service.ts`), queries (`queries.ts`).
- `src/webview/` — `puzzle-panel.ts` is the extension-host side and owns the chess.js game state; `main.ts` is the browser-side renderer; `protocol.ts` is the message contract between them.
- `src/tracking/` — solve statistics.
- `scripts/` — `build-db.mjs` (CSV → SQLite), `copy-native-deps.mjs` (packaging), `release-notes.mjs`.

## Package manager: pnpm only

Use `pnpm` for everything. Never run `npm install`, `npm ci`, `yarn add` or similar: mixing package managers has broken this repo before. `npm run` is not needed either; use `pnpm run`.

## Commands

- `pnpm install` — install dependencies.
- `pnpm run compile` — type-check, lint, and bundle with esbuild into `dist/`.
- `pnpm run watch` — esbuild and tsc in watch mode.
- `pnpm run test` — run the extension tests (compiles and lints first).
- `pnpm run package` — production bundle, then copies `better-sqlite3` into `dist/node_modules`. This is what `vsce package` / `vsce publish` run through `vscode:prepublish`.
- `pnpm run build-db` — build `puzzles.sqlite` from the Lichess CSV.
- `pnpm release-notes` — draft release notes to stdout from commits since the last `v*` tag.

## Puzzle database design

The puzzle database is not in the repo or the VSIX. It is a gzipped SQLite file published as a GitHub Release asset (`puzzles.sqlite.gz` under a `db-v*` tag) and downloaded the first time the user runs the command.

- `DB_VERSION` in `src/db/ensure-database.ts` names the release tag. Changing it makes every installed copy download the new database.
- The file is cached in `context.globalStorageUri` next to a `db-version.txt` marker.
- If the download or the open fails, the user gets an error with a Retry action; a file that fails to open is deleted so the retry downloads it again.
- Never delete or replace a `db-v*` release or its asset: every installed copy of the extension that points at it would break.
- Data files (`*.csv`, `*.csv.zst`, `*.sqlite`, `*.sqlite.gz`) are gitignored and must stay out of git.

## Packaging

- esbuild produces two bundles: `dist/extension.js` (Node, CommonJS) and `dist/webview.js` (browser, IIFE).
- `better-sqlite3` is a native module and stays external to the bundle. `scripts/copy-native-deps.mjs` copies it into `dist/node_modules` because vsce does not follow pnpm's symlinks.
- `.vscodeignore` controls what ships. Anything new at the repo root that is not needed at runtime must be added there.

## Review focus

When reviewing changes, look for these first:

1. **VS Code extension API misuse**
   - Activation events broader than needed (the extension should activate only on its command).
   - Disposables (commands, listeners, webview panels, timers) that are not disposed or not pushed to `context.subscriptions`.
   - Work that blocks the extension host: synchronous file or database work on hot paths, long loops, unawaited promises that swallow errors.
2. **The puzzle database flow**
   - Download on first use: redirects, non-200 responses, partial or interrupted downloads leaving a bad file behind.
   - Offline and failure handling: every failure must reach the Retry prompt, not an unhandled rejection.
   - File paths that break on Windows: build paths with `path.join` / `Uri.fsPath`, never string concatenation or hard-coded separators.
3. **VSIX size**
   - New runtime dependencies, bundled assets, or files not covered by `.vscodeignore`.
   - Anything that pulls data files or dev-only code into `dist/`.

Keep review comments concise. Skip style points that ESLint or `tsc` already report.

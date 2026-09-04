# chess-puzzle-breaks

Solve chess puzzles from the [Lichess puzzle dataset](https://database.lichess.org/#puzzles) without leaving VS Code — pull up a tactic during a build, a compile, or a coffee break.

## Features

- **Puzzle board in an editor tab.** Run `Chess Puzzle: Show a Puzzle` to open an interactive board rendered as a native VS Code webview, styled to match your current theme.
- **Click or drag to move.** Both interaction styles are supported for entering the solving side's moves.
- **Two-level hints.** First hint highlights the piece to move; second hint reveals the full move.
- **Progress tracking.** Puzzles solved and average puzzle rating are tracked locally and shown in the panel header.
- **Solved-puzzle detail panel.** Once a puzzle is solved, a sidebar reveals its themes and a link to the original Lichess game.
- **Offline after first launch.** The puzzle database (a random ~1200–1600 rated sample from Lichess) downloads once from a GitHub Release on first activation and is cached locally — no network access needed after that.

## Requirements

None beyond VS Code itself. An internet connection is required the first time the extension activates, to download the puzzle database.

## Extension Settings

This extension contributes the following settings:

* `chessPuzzleBreaks.minRating`: Minimum Lichess puzzle rating to select from (default `1200`).
* `chessPuzzleBreaks.maxRating`: Maximum Lichess puzzle rating to select from (default `1600`).

## Known Issues

- If the puzzle database fails to download (no internet, GitHub rate-limiting, a corrupted release asset), an error notification with a **Retry** action is shown — the extension will keep retrying on demand rather than requiring a reload.

## Release Notes

### 0.0.1

Initial release: puzzle board with click/drag input, two-level hints, solve tracking, and themed solved-puzzle detail panel.

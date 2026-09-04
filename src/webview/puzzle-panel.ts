import * as vscode from "vscode";
import { Chess, type Square as ChessSquare } from "chess.js";
import { getPuzzleThemes, getRandomPuzzle, type Puzzle } from "../db/queries";
import { getStats, recordSolve } from "../tracking/stats";
import type { HostToWebviewMessage, RenderState, WebviewToHostMessage } from "./protocol";

// Fallbacks matching the defaults declared for chessPuzzleBreaks.minRating /
// maxRating in package.json — used only if those settings are unset.
const DEFAULT_MIN_RATING = 1200;
const DEFAULT_MAX_RATING = 1600;

// How long the opponent's auto-played reply "thinks" before appearing.
const OPPONENT_REPLY_DELAY_MS = 450;
// How long an incorrect attempt stays flashed red before clearing.
const INCORRECT_FLASH_MS = 400;

export interface UciMove {
  from: string;
  to: string;
  promotion?: string;
}

export function parseUci(uci: string): UciMove {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Single reusable webview panel that hosts the puzzle board.
 *
 * All chess rules — legal move generation, move validation, and the
 * puzzle's solution sequence — live here in the extension host via
 * chess.js. The webview (main.ts) is a dumb renderer: it draws whatever
 * RenderState it's given and reports clicks, nothing more. This keeps
 * validation authoritative on the host side as required, and also means
 * the webview bundle never needs chess.js at all.
 */
export class PuzzlePanel {
  private static current: PuzzlePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  private chess = new Chess();
  private puzzle!: Puzzle;
  private setupMove!: UciMove;
  private remainingMoves: UciMove[] = [];
  private nextMoveIndex = 0;
  // Furthest point in remainingMoves the solver has legitimately reached by
  // playing correct moves — caps Redo so it can only restore progress
  // already earned, not skip ahead through moves never actually played.
  private furthestIndex = 0;
  private solverColor: "w" | "b" = "w";

  private selectedSquare: string | null = null;
  private legalTargets: string[] = [];
  private lastMove: { from: string; to: string } | null = null;
  private flashSquare: string | null = null;
  private status: "playing" | "solved" = "playing";
  private interactive = true;
  private themes: string[] | null = null;

  // 0 = no hint requested for the current solver move; 1 = source square
  // revealed; 2 = full move (source + destination) revealed. Reset
  // whenever a new solver move becomes current.
  private hintLevel: 0 | 1 | 2 = 0;

  private webviewReady = false;
  private pendingState: RenderState | null = null;

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (PuzzlePanel.current) {
      PuzzlePanel.current.panel.reveal(column);
      PuzzlePanel.current.loadNewPuzzle();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "chessPuzzleBreaks",
      "Chess Puzzle",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );

    PuzzlePanel.current = new PuzzlePanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToHostMessage) => this.handleMessage(message),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.loadNewPuzzle();
  }

  private dispose(): void {
    PuzzlePanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private handleMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case "ready":
        this.webviewReady = true;
        if (this.pendingState) {
          void this.panel.webview.postMessage({
            type: "state",
            state: this.pendingState,
          } satisfies HostToWebviewMessage);
          this.pendingState = null;
        }
        break;
      case "squareClick":
        this.handleSquareClick(message.square);
        break;
      case "nextPuzzle":
        this.loadNewPuzzle();
        break;
      case "hint":
        this.requestHint();
        break;
      case "undo":
        this.requestUndo();
        break;
      case "redo":
        this.requestRedo();
        break;
    }
  }

  private requestHint(): void {
    if (!this.hintAvailable()) {
      return;
    }
    if (this.hintLevel < 2) {
      this.hintLevel++;
    }
    this.postCurrentState();
  }

  // Hints only make sense for a move not yet solved. Once Undo has moved
  // the current position behind furthestIndex, remainingMoves[nextMoveIndex]
  // is a move the solver already played correctly before undoing — no
  // point "hinting" something they already know.
  private hintAvailable(): boolean {
    return this.status === "playing" && this.interactive && this.nextMoveIndex >= this.furthestIndex;
  }

  private loadNewPuzzle(): void {
    const config = vscode.workspace.getConfiguration("chessPuzzleBreaks");
    const configuredMin = config.get<number>("minRating", DEFAULT_MIN_RATING);
    const configuredMax = config.get<number>("maxRating", DEFAULT_MAX_RATING);
    // Guard against a user setting minRating > maxRating rather than
    // silently returning zero puzzles.
    const minRating = Math.min(configuredMin, configuredMax);
    const maxRating = Math.max(configuredMin, configuredMax);

    const puzzle = getRandomPuzzle({ minRating, maxRating });
    if (!puzzle) {
      void vscode.window.showErrorMessage(
        "Chess Puzzle Breaks: no puzzle found in the database.",
      );
      return;
    }

    this.puzzle = puzzle;
    this.chess = new Chess(puzzle.fen);

    const uciMoves = puzzle.moves.trim().split(/\s+/).map(parseUci);
    this.setupMove = uciMoves[0];
    this.remainingMoves = uciMoves.slice(1);
    this.nextMoveIndex = 0;
    this.furthestIndex = 0;

    // The FEN is the position BEFORE the opponent's setup move — apply it
    // so the solver sees the position they're actually meant to solve.
    this.applyMove(this.setupMove);
    this.solverColor = this.chess.turn();
    this.lastMove = { from: this.setupMove.from, to: this.setupMove.to };

    this.selectedSquare = null;
    this.legalTargets = [];
    this.flashSquare = null;
    this.status = "playing";
    this.interactive = true;
    this.themes = null;
    this.hintLevel = 0;

    this.postCurrentState();
  }

  private applyMove(move: UciMove): void {
    this.chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  }

  private handleSquareClick(square: string): void {
    if (this.status !== "playing" || !this.interactive) {
      return;
    }

    if (this.selectedSquare === null) {
      this.trySelect(square);
      return;
    }

    if (square === this.selectedSquare) {
      this.selectedSquare = null;
      this.legalTargets = [];
      this.postCurrentState();
      return;
    }

    if (!this.legalTargets.includes(square)) {
      // Clicking another one of the solver's own pieces re-selects
      // instead of counting as a failed attempt.
      this.trySelect(square);
      return;
    }

    const expected = this.remainingMoves[this.nextMoveIndex];
    const from = this.selectedSquare;
    this.selectedSquare = null;
    this.legalTargets = [];

    if (from === expected.from && square === expected.to) {
      void this.playCorrectMove(expected);
    } else {
      this.flashIncorrect(square);
    }
  }

  private trySelect(square: string): void {
    const piece = this.chess.get(square as ChessSquare);
    if (!piece || piece.color !== this.solverColor || this.chess.turn() !== this.solverColor) {
      // Not the solver's piece, or not their turn — ignore (also covers
      // clicks during the opponent's auto-played reply).
      if (this.selectedSquare !== null) {
        this.selectedSquare = null;
        this.legalTargets = [];
        this.postCurrentState();
      }
      return;
    }

    const legal = this.chess.moves({ square: square as ChessSquare, verbose: true });
    if (legal.length === 0) {
      return;
    }

    this.selectedSquare = square;
    this.legalTargets = [...new Set(legal.map((m) => m.to))];
    this.postCurrentState();
  }

  private async playCorrectMove(move: UciMove): Promise<void> {
    this.applyMove(move);
    this.lastMove = { from: move.from, to: move.to };
    const playedIndex = this.nextMoveIndex;
    this.nextMoveIndex++;
    this.furthestIndex = Math.max(this.furthestIndex, this.nextMoveIndex);

    // Lichess puzzles always end on the solver's move, so reaching the
    // end of the sequence here means the puzzle is solved.
    if (playedIndex === this.remainingMoves.length - 1) {
      await this.finishSolved();
      return;
    }

    this.interactive = false;
    this.postCurrentState();

    await delay(OPPONENT_REPLY_DELAY_MS);

    const reply = this.remainingMoves[this.nextMoveIndex];
    this.applyMove(reply);
    this.lastMove = { from: reply.from, to: reply.to };
    this.nextMoveIndex++;
    this.furthestIndex = Math.max(this.furthestIndex, this.nextMoveIndex);
    this.interactive = true;
    this.hintLevel = 0;
    this.postCurrentState();
  }

  private async finishSolved(): Promise<void> {
    this.status = "solved";
    this.interactive = false;
    this.themes = getPuzzleThemes(this.puzzle.id);
    await recordSolve(this.context, this.puzzle.rating);
    this.postCurrentState();
  }

  // Rebuilds the board at an arbitrary point in the known solution sequence
  // by replaying from the FEN + setup move — used by undo/redo instead of
  // juggling chess.js's own undo stack, since the full solution is already
  // known up front and replaying is simpler to reason about correctly.
  private goToIndex(targetIndex: number): void {
    const index = Math.max(0, Math.min(targetIndex, this.remainingMoves.length));

    this.chess = new Chess(this.puzzle.fen);
    this.applyMove(this.setupMove);
    for (let i = 0; i < index; i++) {
      this.applyMove(this.remainingMoves[i]);
    }

    this.nextMoveIndex = index;
    this.lastMove =
      index === 0
        ? { from: this.setupMove.from, to: this.setupMove.to }
        : { from: this.remainingMoves[index - 1].from, to: this.remainingMoves[index - 1].to };

    this.selectedSquare = null;
    this.legalTargets = [];
    this.flashSquare = null;
    this.hintLevel = 0;

    if (index === this.remainingMoves.length) {
      this.status = "solved";
      this.interactive = false;
      this.themes = getPuzzleThemes(this.puzzle.id);
    } else {
      this.status = "playing";
      this.interactive = true;
      this.themes = null;
    }

    this.postCurrentState();
  }

  private requestUndo(): void {
    if (this.nextMoveIndex === 0) {
      return;
    }
    if (this.status === "playing" && !this.interactive) {
      return; // mid opponent-reply animation
    }
    // From "solved" there's no trailing opponent reply to undo alongside
    // the final move, so step back 1; otherwise each solver move is
    // paired with the opponent's reply, so step back 2 to return to the
    // solver's previous turn.
    const step = this.status === "solved" ? 1 : 2;
    this.goToIndex(this.nextMoveIndex - step);
  }

  private requestRedo(): void {
    if (this.nextMoveIndex >= this.furthestIndex) {
      return;
    }
    if (this.status === "playing" && !this.interactive) {
      return;
    }
    const remaining = this.furthestIndex - this.nextMoveIndex;
    const step = remaining === 1 ? 1 : 2;
    this.goToIndex(this.nextMoveIndex + step);
  }

  private flashIncorrect(square: string): void {
    this.flashSquare = square;
    this.postCurrentState();
    setTimeout(() => {
      if (this.flashSquare === square) {
        this.flashSquare = null;
        this.postCurrentState();
      }
    }, INCORRECT_FLASH_MS);
  }

  private postCurrentState(): void {
    const expected =
      this.status === "playing" ? this.remainingMoves[this.nextMoveIndex] : undefined;

    const state: RenderState = {
      puzzleId: this.puzzle.id,
      fen: this.chess.fen(),
      orientation: this.solverColor === "w" ? "white" : "black",
      rating: this.puzzle.rating,
      stats: getStats(this.context),
      selectedSquare: this.selectedSquare,
      legalTargets: this.legalTargets,
      lastMove: this.lastMove,
      flashSquare: this.flashSquare,
      hintSquare: this.hintLevel >= 1 && expected ? expected.from : null,
      hintTargetSquare: this.hintLevel >= 2 && expected ? expected.to : null,
      status: this.status,
      interactive: this.interactive,
      themes: this.themes,
      gameUrl: this.status === "solved" ? this.puzzle.game_url : null,
      canUndo: this.nextMoveIndex > 0 && (this.status !== "playing" || this.interactive),
      canRedo:
        this.nextMoveIndex < this.furthestIndex && (this.status !== "playing" || this.interactive),
      hintAvailable: this.hintAvailable(),
    };

    if (!this.webviewReady) {
      this.pendingState = state;
      return;
    }
    void this.panel.webview.postMessage({ type: "state", state } satisfies HostToWebviewMessage);
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Chess Puzzle</title>
<style nonce="${nonce}">
  :root {
    color-scheme: light dark;
    --board-size: min(80vmin, 640px);
  }
  body {
    margin: 0;
    padding: 28px;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 15px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 18px;
  }
  #header {
    display: flex;
    flex-direction: column;
    width: var(--board-size);
    gap: 6px;
  }
  #header-row-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  #header-row-bottom {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  #header h2 { margin: 0; font-size: 1.35em; font-weight: 600; }
  #status,
  #stats { opacity: 0.8; font-size: 1em; white-space: nowrap; }
  #header-actions { display: flex; gap: 8px; flex-shrink: 0; }
  #hint-btn {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  #hint-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2)); }
  #undo-btn,
  #redo-btn {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  #undo-btn:hover,
  #redo-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2)); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button:disabled:hover { background: var(--vscode-button-secondaryBackground, transparent); }
  #main-row {
    display: flex;
    align-items: flex-start;
    gap: 20px;
  }
  #board {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    grid-template-rows: repeat(8, 1fr);
    width: var(--board-size);
    height: var(--board-size);
    flex-shrink: 0;
    border: 2px solid var(--vscode-panel-border, #444);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  }
  .square {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: min(8vmin, 52px);
    line-height: 1;
    cursor: pointer;
    user-select: none;
    touch-action: none;
  }
  .square.dragging-from .piece { opacity: 0.25; }
  .drag-clone {
    position: fixed;
    top: 0;
    left: 0;
    transform: translate(-50%, -50%);
    font-size: min(8vmin, 52px);
    line-height: 1;
    pointer-events: none;
    z-index: 1000;
  }
  /* Board squares use a fixed classic palette rather than editor theme
     colors — a chessboard's own light/dark squares are a convention
     independent of the surrounding editor theme (same as lichess's
     boards look the same in every site theme). Only the panel chrome
     (background, text, buttons, links) follows --vscode-* variables so
     it still reads as native VS Code UI. */
  .square.light { background: #f0d9b5; }
  .square.dark { background: #b58863; }
  .square.selected { box-shadow: inset 0 0 0 4px var(--vscode-focusBorder, #4aa3ff); }
  .square.last-move { box-shadow: inset 0 0 0 4px rgba(255, 215, 0, 0.65); }
  .square.selected.last-move {
    box-shadow:
      inset 0 0 0 4px var(--vscode-focusBorder, #4aa3ff),
      inset 0 0 0 8px rgba(255, 215, 0, 0.65);
  }
  .square.legal-target::after {
    content: "";
    position: absolute;
    width: 28%;
    height: 28%;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.28);
    pointer-events: none;
  }
  .square.legal-target.capture::after {
    width: 88%;
    height: 88%;
    border-radius: 50%;
    background: transparent;
    border: 4px solid rgba(180, 0, 0, 0.55);
  }
  .square.flash-incorrect { background: #e34b4b !important; }
  .square.hint-source { animation: hintPulse 1s ease-in-out infinite; }
  .square.hint-target { box-shadow: inset 0 0 0 4px rgba(60, 179, 113, 0.9); }
  @keyframes hintPulse {
    0%, 100% { box-shadow: inset 0 0 0 4px rgba(255, 196, 0, 0.15); }
    50% { box-shadow: inset 0 0 0 4px rgba(255, 196, 0, 0.95); }
  }
  .piece { pointer-events: none; }
  .piece-white { color: #fbfbfb; text-shadow: 0 0 1px #000, 0 0 2px rgba(0, 0, 0, 0.8); }
  .piece-black { color: #161512; text-shadow: 0 0 1px rgba(255, 255, 255, 0.5); }
  #solved-panel {
    border: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    padding: 16px 20px;
    border-radius: 6px;
    width: 260px;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  #solved-panel-empty {
    margin: 0;
    opacity: 0.7;
    font-style: italic;
  }
  #solved-panel-content { display: none; }
  #solved-panel.visible #solved-panel-empty { display: none; }
  #solved-panel.visible #solved-panel-content { display: block; }
  #solved-panel h3 { margin: 0 0 8px 0; font-size: 1.15em; }
  #themes { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .theme-tag {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 3px 10px;
    border-radius: 10px;
    font-size: 0.85em;
  }
  a { color: var(--vscode-textLink-foreground); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 8px 16px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 1em;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #confetti-canvas {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 1000;
  }
</style>
</head>
<body>
  <canvas id="confetti-canvas"></canvas>
  <div id="header">
    <div id="header-row-top">
      <h2>Chess Puzzle</h2>
      <div id="header-actions">
        <button id="hint-btn">Hint</button>
        <button id="undo-btn" title="Undo">↶ Undo</button>
        <button id="redo-btn" title="Redo">↷ Redo</button>
        <button id="next-btn">Next puzzle</button>
      </div>
    </div>
    <div id="header-row-bottom">
      <span id="status"></span>
      <span id="stats"></span>
    </div>
  </div>
  <div id="main-row">
    <div id="board"></div>
    <div id="solved-panel">
      <p id="solved-panel-empty">Solve the puzzle to see the themes and source game.</p>
      <div id="solved-panel-content">
        <h3>Solved! 🎉</h3>
        <p id="solved-rating"></p>
        <div id="themes"></div>
        <p><a id="game-link" href="#" target="_blank" rel="noopener noreferrer">View original game on Lichess</a></p>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

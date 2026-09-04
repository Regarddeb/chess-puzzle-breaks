import type { HostToWebviewMessage, RenderState, WebviewToHostMessage } from "./protocol";

// This script is bundled separately (browser target) and injected into
// the webview by puzzle-panel.ts. It holds NO chess rules — it just
// renders whatever RenderState the host sends and forwards clicks back.
// Board rendering is a hand-rolled grid of unicode chess glyphs rather
// than an image-based board (e.g. chessground): unicode glyphs need no
// image/font assets to load through the webview's CSP/localResourceRoots
// machinery, and both click-to-move and drag-and-drop reduce to the same
// two messages (select origin, then attempt destination) driven off
// host-pushed state — see the pointer handlers below.
//
// Dragging is done with the Pointer Events API + setPointerCapture rather
// than native HTML5 drag-and-drop, since native DnD's ghost image and
// drop-target model are awkward to restyle inside a webview; a captured
// pointer plus a fixed-position clone that follows the cursor is simpler
// and gives full control over the visuals.

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const PIECE_GLYPHS: Record<string, string> = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

function fenToPieceMap(fen: string): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = fen.split(" ")[0].split("/");
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let file = 0;
    for (const ch of rows[r]) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
      } else {
        const square = String.fromCharCode(97 + file) + String(rank);
        map[square] = ch;
        file += 1;
      }
    }
  }
  return map;
}

function displaySquares(orientation: "white" | "black"): string[] {
  const files =
    orientation === "white"
      ? ["a", "b", "c", "d", "e", "f", "g", "h"]
      : ["h", "g", "f", "e", "d", "c", "b", "a"];
  const ranks = orientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];

  const squares: string[] = [];
  for (const rank of ranks) {
    for (const file of files) {
      squares.push(file + String(rank));
    }
  }
  return squares;
}

const confettiCanvas = document.getElementById("confetti-canvas") as HTMLCanvasElement;
const confettiCtx = confettiCanvas.getContext("2d")!;

interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  width: number;
  height: number;
}

const CONFETTI_COLORS = ["#e34b4b", "#f7c948", "#4aa3ff", "#3cb371", "#f0d9b5", "#b58863"];
const CONFETTI_DURATION_MS = 3000;

let confettiAnimationFrame: number | null = null;

function resizeConfettiCanvas(): void {
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeConfettiCanvas);
resizeConfettiCanvas();

function launchConfetti(): void {
  resizeConfettiCanvas();

  const particles: ConfettiParticle[] = Array.from({ length: 140 }, () => ({
    x: Math.random() * confettiCanvas.width,
    y: -20 - Math.random() * confettiCanvas.height * 0.4,
    vx: (Math.random() - 0.5) * 4,
    vy: 2 + Math.random() * 3,
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 0.3,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    width: 6 + Math.random() * 5,
    height: 10 + Math.random() * 6,
  }));

  const startTime = performance.now();

  if (confettiAnimationFrame !== null) {
    cancelAnimationFrame(confettiAnimationFrame);
  }

  const tick = (now: number): void => {
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);

    for (const p of particles) {
      p.vy += 0.05;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotationSpeed;

      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rotation);
      confettiCtx.fillStyle = p.color;
      confettiCtx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
      confettiCtx.restore();
    }

    if (now - startTime < CONFETTI_DURATION_MS) {
      confettiAnimationFrame = requestAnimationFrame(tick);
    } else {
      confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
      confettiAnimationFrame = null;
    }
  };

  confettiAnimationFrame = requestAnimationFrame(tick);
}

const boardEl = document.getElementById("board") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const statsEl = document.getElementById("stats") as HTMLSpanElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const hintBtn = document.getElementById("hint-btn") as HTMLButtonElement;
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
const solvedPanelEl = document.getElementById("solved-panel") as HTMLDivElement;
const solvedRatingEl = document.getElementById("solved-rating") as HTMLParagraphElement;
const themesEl = document.getElementById("themes") as HTMLDivElement;
const gameLinkEl = document.getElementById("game-link") as HTMLAnchorElement;

let currentState: RenderState | null = null;
let previousStatus: RenderState["status"] | null = null;

// Drag gesture state — set on pointerdown, read/cleared on pointerup.
let dragOrigin: string | null = null;
let wasSelectedAtDragStart = false;
let dragClone: HTMLDivElement | null = null;

function squareFromPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const squareEl = el?.closest(".square");
  return squareEl?.getAttribute("data-square") ?? null;
}

function positionDragClone(x: number, y: number): void {
  if (!dragClone) {
    return;
  }
  dragClone.style.left = `${x}px`;
  dragClone.style.top = `${y}px`;
}

function beginDrag(square: string, glyph: string, isWhite: boolean, x: number, y: number): void {
  boardEl.querySelector(`[data-square="${square}"]`)?.classList.add("dragging-from");

  dragClone = document.createElement("div");
  dragClone.className = `drag-clone piece ${isWhite ? "piece-white" : "piece-black"}`;
  dragClone.textContent = glyph;
  document.body.appendChild(dragClone);
  positionDragClone(x, y);
}

function cleanupDrag(): void {
  dragClone?.remove();
  dragClone = null;
  dragOrigin = null;
  boardEl
    .querySelectorAll(".dragging-from")
    .forEach((el) => el.classList.remove("dragging-from"));
}

function finishDrag(x: number, y: number): void {
  const origin = dragOrigin;
  const dropSquare = squareFromPoint(x, y);
  cleanupDrag();

  if (!origin) {
    return;
  }

  if (dropSquare === origin) {
    // Picked up and put back down — only toggle deselect if it was
    // already selected *before* this gesture started (a plain click on
    // an already-selected square). A fresh pick-up-then-drop-in-place
    // should leave it selected, matching normal click-to-select.
    if (wasSelectedAtDragStart) {
      vscode.postMessage({ type: "squareClick", square: origin });
    }
    return;
  }

  if (dropSquare) {
    vscode.postMessage({ type: "squareClick", square: dropSquare });
  }
  // Dropped outside the board entirely — snap back, nothing to send.
}

function render(state: RenderState): void {
  currentState = state;
  boardEl.innerHTML = "";

  const pieceMap = fenToPieceMap(state.fen);
  const squares = displaySquares(state.orientation);
  const legalSet = new Set(state.legalTargets);

  for (const square of squares) {
    const div = document.createElement("div");
    const fileIndex = square.charCodeAt(0) - 97;
    const rank = Number(square[1]);
    const light = (fileIndex + rank) % 2 === 0;

    div.className = `square ${light ? "light" : "dark"}`;
    div.dataset.square = square;

    if (state.selectedSquare === square) {
      div.classList.add("selected");
    }
    if (state.lastMove && (state.lastMove.from === square || state.lastMove.to === square)) {
      div.classList.add("last-move");
    }

    const pieceCode = pieceMap[square];

    if (legalSet.has(square)) {
      div.classList.add("legal-target");
      if (pieceCode) {
        div.classList.add("capture");
      }
    }
    if (state.flashSquare === square) {
      div.classList.add("flash-incorrect");
    }
    if (state.hintSquare === square) {
      div.classList.add("hint-source");
    }
    if (state.hintTargetSquare === square) {
      div.classList.add("hint-target");
    }

    if (pieceCode) {
      const isWhite = pieceCode === pieceCode.toUpperCase();
      const span = document.createElement("span");
      span.className = `piece ${isWhite ? "piece-white" : "piece-black"}`;
      span.textContent = PIECE_GLYPHS[(isWhite ? "w" : "b") + pieceCode.toLowerCase()];
      div.appendChild(span);
    }

    const solverIsWhite = state.orientation === "white";
    const isOwnPiece = pieceCode ? pieceCode === pieceCode.toUpperCase() === solverIsWhite : false;

    div.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (!currentState?.interactive) {
        return;
      }
      ev.preventDefault();
      div.setPointerCapture(ev.pointerId);

      dragOrigin = square;
      wasSelectedAtDragStart = currentState.selectedSquare === square;

      if (currentState.selectedSquare !== square) {
        vscode.postMessage({ type: "squareClick", square });
      }

      if (pieceCode && isOwnPiece) {
        const isWhite = pieceCode === pieceCode.toUpperCase();
        const glyph = PIECE_GLYPHS[(isWhite ? "w" : "b") + pieceCode.toLowerCase()];
        beginDrag(square, glyph, isWhite, ev.clientX, ev.clientY);
      }
    });

    div.addEventListener("pointermove", (ev: PointerEvent) => {
      if (dragOrigin === null) {
        return;
      }
      positionDragClone(ev.clientX, ev.clientY);
    });

    div.addEventListener("pointerup", (ev: PointerEvent) => {
      if (dragOrigin === null) {
        return;
      }
      finishDrag(ev.clientX, ev.clientY);
    });

    div.addEventListener("pointercancel", () => {
      if (dragOrigin === null) {
        return;
      }
      cleanupDrag();
    });

    boardEl.appendChild(div);
  }

  statusEl.textContent = `Puzzle ${state.puzzleId} · Rating ${state.rating}`;
  statsEl.textContent = `Solved: ${state.stats.solvedCount} · Avg rating: ${
    state.stats.solvedCount > 0 ? state.stats.averageRating : "–"
  }`;
  hintBtn.style.display = state.hintAvailable ? "" : "none";
  undoBtn.disabled = !state.canUndo;
  redoBtn.disabled = !state.canRedo;

  if (state.status === "solved" && previousStatus !== "solved") {
    launchConfetti();
  }
  previousStatus = state.status;

  if (state.status === "solved") {
    solvedPanelEl.classList.add("visible");
    solvedRatingEl.textContent = `Rating: ${state.rating}`;

    themesEl.innerHTML = "";
    for (const theme of state.themes ?? []) {
      const tag = document.createElement("span");
      tag.className = "theme-tag";
      tag.textContent = theme;
      themesEl.appendChild(tag);
    }

    if (state.gameUrl) {
      gameLinkEl.href = state.gameUrl;
      gameLinkEl.style.display = "";
    } else {
      gameLinkEl.style.display = "none";
    }
  } else {
    solvedPanelEl.classList.remove("visible");
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data.type === "state") {
    render(event.data.state);
  }
});

nextBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "nextPuzzle" });
});

hintBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "hint" });
});

undoBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "undo" });
});

redoBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "redo" });
});

vscode.postMessage({ type: "ready" });

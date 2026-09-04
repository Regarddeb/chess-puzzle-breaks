// Message contract between the extension host (puzzle-panel.ts) and the
// webview script (main.ts). Plain data only — no chess logic lives here,
// and none of it should leak into the webview (see main.ts).

export type Square = string;

export interface LastMove {
  from: Square;
  to: Square;
}

export interface PuzzleStats {
  solvedCount: number;
  averageRating: number;
}

export interface RenderState {
  puzzleId: string;
  fen: string;
  orientation: "white" | "black";
  rating: number;
  stats: PuzzleStats;
  selectedSquare: Square | null;
  legalTargets: Square[];
  lastMove: LastMove | null;
  flashSquare: Square | null;
  hintSquare: Square | null;
  hintTargetSquare: Square | null;
  status: "playing" | "solved";
  interactive: boolean;
  themes: string[] | null;
  gameUrl: string | null;
  canUndo: boolean;
  canRedo: boolean;
  hintAvailable: boolean;
}

export type HostToWebviewMessage = { type: "state"; state: RenderState };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "squareClick"; square: Square }
  | { type: "nextPuzzle" }
  | { type: "hint" }
  | { type: "undo" }
  | { type: "redo" };

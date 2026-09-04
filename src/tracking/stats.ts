import * as vscode from "vscode";

// Solve-tracking data. Deliberately kept out of src/db/ — it's user
// progress, not part of the read-only, redownloadable puzzle dataset, so
// it lives in globalState instead of the SQLite file and survives DB
// version bumps / re-downloads untouched.

const STATS_KEY = "chessPuzzleBreaks.stats";

interface StoredStats {
  solvedCount: number;
  ratingSum: number;
}

export interface PuzzleStats {
  solvedCount: number;
  averageRating: number;
}

function readStored(context: vscode.ExtensionContext): StoredStats {
  return context.globalState.get<StoredStats>(STATS_KEY) ?? { solvedCount: 0, ratingSum: 0 };
}

export function getStats(context: vscode.ExtensionContext): PuzzleStats {
  const stored = readStored(context);
  return {
    solvedCount: stored.solvedCount,
    averageRating:
      stored.solvedCount === 0 ? 0 : Math.round(stored.ratingSum / stored.solvedCount),
  };
}

export async function recordSolve(
  context: vscode.ExtensionContext,
  rating: number,
): Promise<void> {
  const stored = readStored(context);
  const updated: StoredStats = {
    solvedCount: stored.solvedCount + 1,
    ratingSum: stored.ratingSum + rating,
  };
  await context.globalState.update(STATS_KEY, updated);
}

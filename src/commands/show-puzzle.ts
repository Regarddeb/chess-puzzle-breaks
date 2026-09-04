import * as vscode from "vscode";
import { ensureDatabaseReady } from "../db/database-service";
import { PuzzlePanel } from "../webview/puzzle-panel";

export function registerShowPuzzleCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand("chess-puzzle-breaks.showPuzzle", async () => {
    const dbReady = await ensureDatabaseReady(context);
    if (!dbReady) {
      return;
    }
    PuzzlePanel.createOrShow(context);
  });
}

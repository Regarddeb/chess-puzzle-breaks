import * as vscode from "vscode";
import { closeDatabase } from "./db/queries";
import { registerShowPuzzleCommand } from "./commands/show-puzzle";

// Activation is triggered by onCommand:chess-puzzle-breaks.showPuzzle (see
// package.json), so this only runs once the user actually opens a puzzle —
// the database itself is brought up lazily inside the command handler
// (see ensureDatabaseReady in db/database-service.ts), which also gives it
// somewhere to retry from on failure instead of a one-shot startup attempt.
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(registerShowPuzzleCommand(context));
}

export function deactivate() {
  closeDatabase();
}

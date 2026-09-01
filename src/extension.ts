import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  console.log("Storage path:", context.globalStorageUri.fsPath);

  const disposable = vscode.commands.registerCommand(
    "chess-puzzle-breaks.showPuzzle",
    () => {
      vscode.window.showInformationMessage("Puzzle command fired!");
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

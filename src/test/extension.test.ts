import * as assert from "assert";
import * as vscode from "vscode";

// Activation itself must stay network-free (see extension.ts) — it only
// registers the command, deferring the puzzle DB download to when the
// command actually runs. That's what makes this safe to assert here.
suite("Extension activation", () => {
  test("activates and registers the show-puzzle command", async () => {
    const extension = vscode.extensions.getExtension("HumphreyUno.chess-puzzle-breaks");
    assert.ok(extension, "extension should be discoverable by the test host");

    await extension!.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("chess-puzzle-breaks.showPuzzle"),
      "chess-puzzle-breaks.showPuzzle should be registered after activation",
    );
  });
});

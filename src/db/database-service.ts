import * as vscode from "vscode";
import { ensureDatabase, resetDatabaseCache } from "./ensure-database";
import { openDatabase } from "./queries";

// Lazily brings the puzzle database up: downloads/caches it via
// ensureDatabase, then opens it. Cheap to call repeatedly — once the DB is
// open in this session it's a no-op — so command handlers can call it on
// every invocation instead of relying on a one-shot activation-time init.
let ready = false;

export async function ensureDatabaseReady(context: vscode.ExtensionContext): Promise<boolean> {
  if (ready) {
    return true;
  }

  let dbPath: string;
  try {
    dbPath = await ensureDatabase(context);
  } catch (err) {
    return promptRetry(context, err);
  }

  try {
    openDatabase(dbPath);
    ready = true;
    return true;
  } catch (err) {
    // The cached file didn't open as a valid database (e.g. a corrupted
    // release asset) — wipe it so the next attempt re-downloads instead of
    // repeatedly failing to open the same bad file.
    resetDatabaseCache(context);
    return promptRetry(context, err);
  }
}

async function promptRetry(context: vscode.ExtensionContext, err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  const choice = await vscode.window.showErrorMessage(
    `Chess Puzzle Breaks: failed to load the puzzle database — ${message}`,
    "Retry",
  );
  if (choice === "Retry") {
    return ensureDatabaseReady(context);
  }
  return false;
}

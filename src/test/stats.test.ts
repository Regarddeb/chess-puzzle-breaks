import * as assert from "assert";
import type * as vscode from "vscode";
import { getStats, recordSolve } from "../tracking/stats";

// A minimal stand-in for ExtensionContext.globalState — stats.ts only ever
// calls get()/update() on it, so a Map-backed fake avoids needing a real
// extension host state store for these pure logic tests.
function createFakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const globalState = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : (defaultValue as T),
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
  };
  return { globalState } as unknown as vscode.ExtensionContext;
}

suite("tracking/stats", () => {
  test("getStats reports zero state before any solve is recorded", () => {
    const context = createFakeContext();

    const stats = getStats(context);

    assert.strictEqual(stats.solvedCount, 0);
    assert.strictEqual(stats.averageRating, 0);
  });

  test("recordSolve accumulates count and rounds the average rating", async () => {
    const context = createFakeContext();

    await recordSolve(context, 1500);
    await recordSolve(context, 1600);
    await recordSolve(context, 1551);

    const stats = getStats(context);

    assert.strictEqual(stats.solvedCount, 3);
    assert.strictEqual(stats.averageRating, Math.round((1500 + 1600 + 1551) / 3));
  });
});

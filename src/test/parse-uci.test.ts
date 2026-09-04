import * as assert from "assert";
import { parseUci } from "../webview/puzzle-panel";

suite("parseUci", () => {
  test("parses a plain move with no promotion", () => {
    assert.deepStrictEqual(parseUci("e2e4"), { from: "e2", to: "e4", promotion: undefined });
  });

  test("parses a promotion move's trailing piece letter", () => {
    assert.deepStrictEqual(parseUci("a7a8q"), { from: "a7", to: "a8", promotion: "q" });
  });
});

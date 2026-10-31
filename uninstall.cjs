// Runs through the vscode:uninstall hook, with no access to the VS Code API, so
// the storage path has to be rebuilt by hand. Removes only the cached puzzle
// database: it can always be downloaded again, and it holds no user data.
// Lives at the repo root because this file has to ship in the VSIX.
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXTENSION_ID = "humphreyuno.chess-puzzle-breaks";
const CACHE_FILES = ["puzzles.sqlite", "puzzles.sqlite.gz", "db-version.txt"];

function userDataDir() {
  const app = __dirname.includes(".vscode-insiders") ? "Code - Insiders" : "Code";
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), app);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", app);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), app);
}

const storageDir = path.join(userDataDir(), "User", "globalStorage", EXTENSION_ID);

for (const file of CACHE_FILES) {
  try {
    fs.rmSync(path.join(storageDir, file), { force: true });
  } catch {
    // Best effort: a failed cleanup must never get in the way of the uninstall.
  }
}

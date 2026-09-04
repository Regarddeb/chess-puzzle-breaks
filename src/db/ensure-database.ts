import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as zlib from "zlib";

// Bump this whenever you cut a new DB release on GitHub
const DB_VERSION = "db-v2026.09b";
const DB_URL = `https://github.com/Regarddeb/chess-puzzle-breaks/releases/download/${DB_VERSION}/puzzles.sqlite.gz`;

export async function ensureDatabase(
  context: vscode.ExtensionContext,
): Promise<string> {
  const storageDir = context.globalStorageUri.fsPath;
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const versionFile = path.join(storageDir, "db-version.txt");
  const dbPath = path.join(storageDir, "puzzles.sqlite");

  const currentVersion = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : null;

  if (currentVersion === DB_VERSION && fs.existsSync(dbPath)) {
    return dbPath; // already up to date, nothing to do
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Chess Puzzle Breaks: downloading puzzle set…",
      cancellable: false,
    },
    async (progress) => {
      const gzPath = dbPath + ".gz";
      await downloadFile(DB_URL, gzPath, progress);
      await decompressGz(gzPath, dbPath);
      fs.unlinkSync(gzPath);
      fs.writeFileSync(versionFile, DB_VERSION);
    },
  );

  return dbPath;
}

// Deletes the cached DB file and its version marker so the next
// ensureDatabase() call re-downloads from scratch, rather than trusting a
// file that failed to open as a valid database.
export function resetDatabaseCache(context: vscode.ExtensionContext): void {
  const storageDir = context.globalStorageUri.fsPath;
  const versionFile = path.join(storageDir, "db-version.txt");
  const dbPath = path.join(storageDir, "puzzles.sqlite");

  for (const filePath of [versionFile, dbPath]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

function downloadFile(
  url: string,
  destPath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (currentUrl: string) => {
      https
        .get(currentUrl, (response) => {
          // GitHub Releases redirects to S3 — follow it
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            request(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }

          const total = parseInt(response.headers["content-length"] ?? "0", 10);
          let downloaded = 0;
          let lastReportedPct = 0;

          const fileStream = fs.createWriteStream(destPath);

          response.on("data", (chunk: Buffer) => {
            downloaded += chunk.length;
            if (total > 0) {
              const pct = Math.floor((downloaded / total) * 100);
              if (pct > lastReportedPct) {
                progress.report({ increment: pct - lastReportedPct });
                lastReportedPct = pct;
              }
            }
          });

          response.pipe(fileStream);

          fileStream.on("finish", () => {
            fileStream.close();
            resolve();
          });

          fileStream.on("error", reject);
        })
        .on("error", reject);
    };

    request(url);
  });
}

function decompressGz(srcPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = fs.createReadStream(srcPath);
    const dest = fs.createWriteStream(destPath);
    const gunzip = zlib.createGunzip();

    src.pipe(gunzip).pipe(dest);

    dest.on("finish", () => resolve());
    src.on("error", reject);
    gunzip.on("error", reject);
    dest.on("error", reject);
  });
}

// pnpm links node_modules/better-sqlite3 as an NTFS junction/symlink into its
// virtual store. vsce's file walker doesn't follow those, so a packaged VSIX
// would silently ship without the native module the extension host requires
// at runtime. This copies the real files into dist/node_modules so vsce sees
// a plain directory, and Node's own module resolution picks it up from there
// automatically (it looks in dist/node_modules before walking up to the repo
// root) — no changes needed to how the extension requires "better-sqlite3".
import { createRequire } from "module";
import { cpSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const srcDir = dirname(require.resolve("better-sqlite3/package.json"));
const destDir = join(process.cwd(), "dist", "node_modules", "better-sqlite3");

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
cpSync(join(srcDir, "package.json"), join(destDir, "package.json"));
cpSync(join(srcDir, "lib"), join(destDir, "lib"), { recursive: true });
cpSync(join(srcDir, "prebuilds"), join(destDir, "prebuilds"), { recursive: true });

console.log(`Copied better-sqlite3 runtime files to ${destDir}`);

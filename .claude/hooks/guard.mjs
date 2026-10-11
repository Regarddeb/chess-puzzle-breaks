// PreToolUse guard for chess-puzzle-breaks. Reads the tool call as JSON on stdin and
// prints a deny/ask decision. Printing nothing leaves the normal permission flow in charge.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const { tool_name, tool_input = {} } = input;

const SECRET_VARS = /VSCE_PAT|OVSX_PAT|GH_TOKEN/;
const ENV_FILE = /^\.env(\..*)?$/i;
const SECRET_FILE = /^\.env(\..*)?$|\.pat$|token/i;
const DATA_FILE = /\.(db|sqlite|csv|zst)$/i;
const PUBLISH = /\b(vsce|ovsx)\s+publish\b/;
const PRINTERS = ['echo', 'printf', 'printenv'];
const READERS = ['cat', 'head', 'tail', 'less', 'more', 'type', 'bat', 'grep', 'source', '.'];

const deny = (reason) => ['deny', reason];
const ask = (reason) => ['ask', reason];
const base = (p) => path.win32.basename(p ?? '');
const prog = (word) => base(word).toLowerCase().replace(/\.(exe|cmd)$/, '');

// Split on shell separators so `cd x && npm i` is checked piece by piece. Not quote-aware:
// a separator inside a quoted string also splits, which errs on the side of checking more.
const split = (command) => command.split(/&&|\|\||[;|&\n]|\$\(|[()`]/).map((s) => s.trim()).filter(Boolean);

function words(sub) {
  const w = sub.replace(/["'<>]/g, ' ').split(/\s+/).filter(Boolean);
  while (/^\w+=/.test(w[0] ?? '')) w.shift(); // leading VAR=value
  return w;
}

// Drop git's global options (`git -C dir push`) so the first word left is the subcommand.
function gitArgs(w) {
  let i = 1;
  while (w[i]?.startsWith('-')) i += /^-[Cc]$/.test(w[i]) ? 2 : 1;
  return w.slice(i);
}

let scripts = {};
try {
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? '.';
  scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
} catch {}

// True for `vsce publish` / `ovsx publish`, or a pnpm script whose body (transitively) runs one.
function publishes(sub, depth = 0) {
  if (PUBLISH.test(sub)) return true;
  const w = words(sub);
  if (prog(w[0]) !== 'pnpm' || depth > 3) return false;
  const body = scripts[w[1] === 'run' ? w[2] : w[1]];
  return !!body && split(body).some((s) => publishes(s, depth + 1));
}

function checkCommand(sub) {
  const w = words(sub);
  const p = prog(w[0]);
  const a = w.slice(1);

  // 1. Mixing package managers broke this repo before; pnpm owns the lockfile.
  if ((p === 'npm' && ['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'un'].includes(a[0])) ||
      (p === 'yarn' && ['add', 'install', 'remove'].includes(a[0]))) {
    return deny('This project uses pnpm only. Use the pnpm equivalent.');
  }

  if (p === 'git') {
    const [verb, ...rest] = gitArgs(w);
    if (verb === 'push') {
      // 2. A plain force push can silently destroy commits on the remote.
      if (rest.some((x) => x === '--force' || /^-[a-z]*f[a-z]*$/i.test(x) || x.startsWith('+'))) {
        return deny('Force push is blocked. Use --force-with-lease if you really need to overwrite the remote.');
      }
      // 7. --force-with-lease is safer but still rewrites remote history, so a human confirms.
      if (rest.some((x) => x.startsWith('--force-with-lease'))) {
        return ask('Force push (with lease) rewrites remote history. Confirm?');
      }
    }
    // 8. The puzzle database belongs on GitHub Releases, not in the repo.
    if (verb === 'add' && rest.some((x) => DATA_FILE.test(x))) {
      return ask('Staging a large data file. The puzzle database belongs on GitHub Releases, not in git. Confirm?');
    }
  }

  if (p === 'gh') {
    // 3. Installed extensions download the puzzle DB from Releases on first activation;
    //    deleting a release or its assets breaks the extension for every user.
    if ((a[0] === 'release' && /^delete/.test(a[1] ?? '')) ||
        (a[0] === 'api' && /\bDELETE\b/i.test(sub) && /releases/.test(sub))) {
      return deny('Deleting a release or its assets is blocked: installed extensions download the puzzle database from GitHub Releases.');
    }
    // 6. Releases are what users download, so creating or changing one needs a human.
    if (a[0] === 'release' && ['create', 'edit', 'upload'].includes(a[1])) {
      return ask(`gh release ${a[1]} changes what installed extensions download. Confirm?`);
    }
  }

  // 4. Publish tokens and .env contents must never land in the transcript.
  if (PRINTERS.includes(p) && SECRET_VARS.test(sub)) {
    return deny('Printing VSCE_PAT / OVSX_PAT / GH_TOKEN is blocked.');
  }
  if (READERS.includes(p) && a.some((x) => ENV_FILE.test(base(x)))) {
    return deny('Reading .env files is blocked.');
  }

  // 5. Publishing to the Marketplace / Open VSX is public and cannot be undone.
  if (publishes(sub)) {
    return ask('This publishes the extension to the Marketplace / Open VSX. Confirm?');
  }
}

let hits = [];
if (tool_name === 'Bash' || tool_name === 'PowerShell') {
  hits = split(tool_input.command ?? '').map(checkCommand).filter(Boolean);
} else if (['Read', 'Edit', 'Write'].includes(tool_name)) {
  // 9. Secret files (.env, *.pat, *token*) are off limits to the file tools too.
  if (SECRET_FILE.test(base(tool_input.file_path))) {
    hits = [deny('Access to .env, *.pat and *token* files is blocked.')];
  }
}

const hit = hits.find(([decision]) => decision === 'deny') ?? hits[0];
if (hit) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: hit[0],
      permissionDecisionReason: hit[1],
    },
  }));
}

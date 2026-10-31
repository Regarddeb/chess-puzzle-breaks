// Drafts user-facing release notes from the commits since the last extension
// release and prints them to stdout. Nothing is written to disk — review the
// output and paste it into CHANGELOG.md yourself.
//
// Usage: pnpm release-notes
import { execFileSync, spawnSync } from "child_process";
import { readFileSync } from "fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// Extension releases are tagged v*. The db-v* tags mark puzzle database
// releases, so they're ignored; with no v* tag yet, the whole history is used.
let lastTag = null;
try {
  lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
} catch {}

const range = lastTag ? [`${lastTag}..HEAD`] : [];
const commits = git("log", ...range, "--no-merges", "--format=%h%x1f%an%x1f%s")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [hash, author, subject] = line.split("\x1f");
    return { hash, author, subject };
  })
  .filter((c) => !/dependabot/i.test(c.author));

if (commits.length === 0) {
  console.error(`No non-Dependabot commits since ${lastTag ?? "the start of history"}.`);
  process.exit(0);
}

const groups = { Added: [], Fixed: [], Changed: [] };
for (const c of commits) {
  const group = /^fix/i.test(c.subject) ? "Fixed" : /^(add|feat|set up)/i.test(c.subject) ? "Added" : "Changed";
  groups[group].push(`- ${c.hash} ${c.subject}`);
}
const grouped = Object.entries(groups)
  .filter(([, lines]) => lines.length > 0)
  .map(([name, lines]) => `${name}:\n${lines.join("\n")}`)
  .join("\n\n");

const input = `Current CHANGELOG.md (match its style):

${readFileSync("CHANGELOG.md", "utf8")}

Commits since ${lastTag ?? "the start of the project"}, roughly grouped:

${grouped}
`;

const prompt =
  "Write user-facing release notes for this VS Code extension from the commits on stdin. " +
  "Follow Keep a Changelog: a version heading, then Added / Changed / Fixed sections with short bullets. " +
  "Describe what users will notice; leave out CI, tooling and internal refactors, and drop empty sections. " +
  "Do not use any tools. Output only the markdown, with no preamble.";

const result = spawnSync("claude", ["-p", prompt], { input, stdio: ["pipe", "inherit", "inherit"] });
if (result.error) {
  console.error(`Could not run claude: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

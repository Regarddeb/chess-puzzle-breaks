// Run with: node --test .claude/hooks/guard.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const guard = path.join(import.meta.dirname, 'guard.mjs');

// Fixture project so the "pnpm script that publishes" rule doesn't depend on the real package.json.
const project = mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
writeFileSync(path.join(project, 'package.json'), JSON.stringify({
  scripts: {
    package: 'node esbuild.js --production',
    release: 'pnpm run package && vsce publish',
    ship: 'pnpm run release',
  },
}));
after(() => rmSync(project, { recursive: true, force: true }));

function decide(tool_name, tool_input) {
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout === '') return 'none';
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.ok(out.permissionDecisionReason);
  return out.permissionDecision;
}

const bash = {
  deny: [
    // 1. npm / yarn
    'npm install', 'npm i', 'npm add chess.js', 'npm ci', 'npm uninstall chess.js',
    'yarn add chess.js', 'yarn install', 'yarn remove chess.js',
    'cd src && npm i', 'git status; yarn add x',
    // 2. force push
    'git push --force', 'git push -f origin main', 'git -C . push origin +main',
    'git push --force --force-with-lease',
    // 3. release deletion
    'gh release delete v0.0.1', 'gh release delete-asset v0.0.1 puzzles.sqlite.gz',
    'gh api -X DELETE repos/Regarddeb/chess-puzzle-breaks/releases/assets/1',
    'gh release create v2 && gh release delete v1',
    // 4. secrets
    'echo $VSCE_PAT', 'echo "$OVSX_PAT"', 'printenv GH_TOKEN', 'cat .env', 'cat config/.env.local',
  ],
  ask: [
    // 5. publishing
    'vsce publish', 'npx ovsx publish -p x', 'pnpm run release', 'pnpm ship',
    // 6. releases
    'gh release create v0.0.2', 'gh release edit v0.0.2 --draft=false',
    'gh release upload v0.0.2 puzzles.sqlite.gz',
    // 7. force with lease
    'git push --force-with-lease', 'git push --force-with-lease=main origin main',
    // 8. large data files
    'git add puzzles.db', 'git add data/puzzles.sqlite', 'git add lichess.csv', 'git add lichess.csv.zst',
  ],
  none: [
    'pnpm install', 'pnpm run compile', 'pnpm run package', 'git status', 'npm run compile',
    'gh release view', 'gh release list', 'git push', 'git push origin main',
    'git add src/extension.ts', 'cat README.md', 'vsce package',
  ],
};

for (const [expected, commands] of Object.entries(bash)) {
  for (const command of commands) {
    test(`Bash ${expected}: ${command}`, () => assert.equal(decide('Bash', { command }), expected));
  }
}

const files = {
  deny: ['.env', 'C:\\repo\\.env.production', 'secrets/vsce.pat', '/home/me/github_token.txt'],
  none: ['package.json', 'src/extension.ts', '.gitignore'],
};

for (const [expected, paths] of Object.entries(files)) {
  for (const file_path of paths) {
    for (const tool of ['Read', 'Edit', 'Write']) {
      test(`${tool} ${expected}: ${file_path}`, () => assert.equal(decide(tool, { file_path }), expected));
    }
  }
}

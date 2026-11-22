#!/usr/bin/env node
// SessionStart: print the core rules in ../rules/*.md as session context. Claude Code and Codex both read
// `hookSpecificOutput.additionalContext` from a SessionStart hook's stdout and add it to the session. These are the
// rules every coding agent follows in every project. No network, no writes, and it never fails the session: a
// missing or unreadable rule prints nothing and exits 0.
// Edit this file in core/hooks/ and the rules in core/rules/; `npm run sync` copies both into every plugin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules');
  const rules = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort().map((name) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim()).filter(Boolean);
  if (rules.length) {
    const additionalContext = `gam3stack core rules. Follow them in every task in this session.\n\n${rules.join('\n\n')}\n`;
    // writeSync: nothing is left pending on the pipe when the process exits.
    fs.writeSync(1, `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
  }
} catch {
  /* a hook never disturbs the session */
}
process.exit(0);

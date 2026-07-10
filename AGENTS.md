# AGENTS.md — link-generator (project)

Core operating rules: `~/.codex/AGENTS.md` (loaded globally, applies here too).

## Deploy target: Vercel + ESM
- Relative imports need explicit `.js` extensions. `tsx` runs fine locally
  without them, but the Vercel build ships broken modules —
  `FUNCTION_INVOCATION_FAILED` on a route is a module-load crash, not a logic bug.
- Truthful repro before trusting a fix: `vercel build`, then `node`-import the
  built artifact — and probe a MATCHED route, not only unmatched 500s.

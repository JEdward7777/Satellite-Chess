# Satellite-Chess

Chess played on a real field, with GPS deciding what you can reach. See
`README.md` for what the game is.

## Read this first

The working agreement for every assistant on this project lives in
**[`harness/AGENTS.md`](harness/AGENTS.md)**. Read it before doing anything else.
It is deliberately the only copy — this file is a pointer so that Claude Code,
Codex, Cursor and anything else all follow the same rules.

Then orient yourself:

1. `harness/STATE.md` — where the project is right now.
2. The newest file in `harness/sessions/` — what the last thread did and what it
   left for you.
3. `npm run plan` — the stage tree with statuses.
4. `harness/observations/open.md` — known problems not yet scoped into a stage.

A SessionStart hook prints a summary of these. **If you did not see that summary,
the hook did not fire — read the files yourself.** Do not assume the project is
empty or start planning from scratch.

## Quick reference

```bash
npm run dev          # wrangler dev + client build watch
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run plan         # stage tree with statuses
npm run plan:check   # validate stage numbering and parentage
npm run deploy       # build client, wrangler deploy
```

Development branch: `claude/satellite-chess-game-bigkb8`. Commit and push at the
end of every session, rebasing if the remote moved — the container is ephemeral.
See section 8 of `harness/AGENTS.md`.

## Three things that will bite you

- **No timing state in memory.** The Durable Object hibernates. The clock is pure
  functions over stored timestamps (`src/shared/clock.ts`). No `setTimeout`.
- **Inbound WebSocket messages cost requests.** Never stream GPS to the server.
- **A move is two acts separated by a walk** — lift near the origin, carry, place
  near the destination. Requiring both ends at one instant makes long moves
  physically impossible. See `harness/decisions/0001-two-phase-carry.md`.

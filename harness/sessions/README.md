# Sessions

One file per working session, named `YYYY-MM-DD-NN.md` where `NN` increments within
a day. **Immutable once written** — a later session writes a new file rather than
editing an old one.

The newest file is the second thing a new thread should read, after
[`../STATE.md`](../STATE.md). `STATE.md` says where the project is; the newest
session file says how it got there and what the previous thread would do next.

Be honest about dead ends and half-finished work. They are the most valuable part
of the record: a summary of what worked is reconstructible from the code, but the
three approaches that failed are not, and the next thread will otherwise try them
again.

## Template

```markdown
# YYYY-MM-DD-NN

**Stages touched:** 1.2, 1.3.1
**Left at:** one line — the exact next action.

## What was done
Terse. Point at commits and files rather than re-describing them.

## What was learned
Anything that changes how the next person should approach this. Measurements,
platform surprises, ideas that turned out not to work and why.

## Half-finished
Anything committed but incomplete, and anything deliberately stubbed. Be specific
about what "incomplete" means for each.

## Next
What the next thread should pick up, in order. First item should match "Left at".

## Loose ends not worth a stage
Anything logged to `observations/open.md` this session, or ideas parked in
conversation that are not written down anywhere else.
```

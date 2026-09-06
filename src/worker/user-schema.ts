/**
 * UserDO's SQLite schema.
 *
 * Same approach as `schema.ts`: idempotent DDL applied on every construction
 * rather than a migration framework, because the object is single-tenant and
 * wakes far more often than the schema changes. When a column needs adding, add
 * it here *and* handle the upgrade in {@link applyUserSchema}.
 *
 * ## The asymmetry in `fields` is deliberate — do not "fix" it
 *
 * There is **no player column on a field, and no field→players table anywhere**.
 * Play history is indexed player → fields and never the reverse (decision 0017).
 * A field row lives inside the account that owns it and that is the only edge:
 * ask "which grounds does this player know?" and you get an answer; ask "who
 * plays on this common?" and there is nothing to join against.
 *
 * That reads as a missing index, and the obvious tidy-up — one shared `fields`
 * table with an `owner_sub` column — would restore the reverse lookup for free.
 * Which is exactly the problem: a shared field is a place people repeatedly and
 * predictably stand, so a field→players edge is a list of where somebody can be
 * found on a Sunday morning. It is left un-buildable rather than merely unbuilt.
 */

/**
 * Bumped when the shape changes. Stored in `meta`, so a woken object can tell
 * whether its tables predate the code now running.
 */
export const USER_SCHEMA_VERSION = 1;

const STATEMENTS = [
  // A single row, `id = 1`. One Durable Object is one account, and the CHECK
  // makes a second row impossible rather than merely unlikely — the same shape
  // as GameDO's `game` table and for the same reason.
  `CREATE TABLE IF NOT EXISTS account (
     id            INTEGER PRIMARY KEY CHECK (id = 1),
     -- The Google sub claim, never the email: email changes and sub does
     -- not (decision 0014). Stored even though it is also this object's name,
     -- because ctx.id.name is only populated for a name-derived id and a row
     -- that can be read back is worth more than an invariant that is merely
     -- true.
     sub           TEXT    NOT NULL,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,

  // Saved fields (stage 2.3.3.2). Mirrors FieldSpec column-for-column rather
  // than storing it as a JSON blob, because unlike GameDO's immutable field
  // snapshot these rows are queried: listed by recency, fetched by id, and
  // matched by lineage.
  `CREATE TABLE IF NOT EXISTS fields (
     id            TEXT    PRIMARY KEY,
     name          TEXT    NOT NULL,
     -- Raw tapped corners only, never the derived projection, so the geometry
     -- can be revised without invalidating a saved field (AGENTS.md section 6).
     a1_lat        REAL    NOT NULL,
     a1_lng        REAL    NOT NULL,
     h8_lat        REAL    NOT NULL,
     h8_lng        REAL    NOT NULL,
     -- Nullable, and permanently so. Every field calibrated before decision 0028
     -- has only the diagonal and must keep reading as the square board it was
     -- calibrated as; deriveGeometry branches on whether these are present.
     h1_lat        REAL,
     h1_lng        REAL,
     a8_lat        REAL,
     a8_lng        REAL,
     -- Reported accuracy at each tap, in metres. Diagnostics only.
     a1_accuracy   REAL,
     h8_accuracy   REAL,
     h1_accuracy   REAL,
     a8_accuracy   REAL,
     -- Bumped on every re-calibration. Belongs to the lineage rather than to a
     -- phone, which is why a copy takes the sender's number rather than one more
     -- than its own.
     version       INTEGER NOT NULL,
     -- Provenance for a copy: the lineage key and version, and how it arrived.
     -- Ground and a name and nothing about people (decision 0017) — there is
     -- deliberately no column here for who shared it.
     origin_key    TEXT,
     origin_version INTEGER,
     origin_via    TEXT,
     -- fieldKey(): origin_key when this is a copy, a digest of the field's
     -- own id when it is not. Materialised because de-duplication looks fields up
     -- by it (offerFor), and because the fallback makes it un-indexable as an
     -- expression. Written by the DO, never by a client.
     lineage_key   TEXT    NOT NULL,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,

  // Not unique: two fields on the same grass tapped by two people are genuinely
  // different fields, and a lineage collision is a de-duplication question to be
  // answered rather than a constraint to be enforced. FNV-1a is an eight-byte
  // digest chosen for size, not for collision resistance.
  `CREATE INDEX IF NOT EXISTS fields_lineage_key ON fields (lineage_key)`,
  `CREATE INDEX IF NOT EXISTS fields_updated_at ON fields (updated_at DESC)`,

  // The game index (stage 2.3.4): one row per game this account has a seat in,
  // so a resumable game can be found from a second phone.
  //
  // Load-bearing rather than bookkeeping. Since decision 0025 a game may sit
  // suspended for a month, and until this is populated **the join code is the
  // only handle on it** — a player who closes the tab has lost the game.
  `CREATE TABLE IF NOT EXISTS game_index (
     -- The join code is the GameDO's address (decision 0007), so it is the
     -- natural key here and no separate game id is needed.
     join_code      TEXT    PRIMARY KEY,
     -- Which side this account plays. The opponent is deliberately not named:
     -- the index answers "which of my games is this?", and anything more about
     -- the other player belongs to the game, which is the only authority on it.
     color          TEXT    NOT NULL,
     status         TEXT    NOT NULL,
     -- Denormalised so a list reads without opening every game — a cross-device
     -- game list that had to wake five Durable Objects to render would be one
     -- request per row against a 100k/day budget.
     field_name     TEXT,
     last_move_at   INTEGER,
     -- Decision 0025, and the reason suspended_by is carried here rather than
     -- recomputed: after thirty days *nobody* is connected, so "claim if your
     -- opponent is absent" inverts the rule and lets whoever walked off claim the
     -- win. 2.3.4.1 shows the countdown; 2.3.4.2 must never offer to remove a row
     -- that is still claimable.
     suspended_at   INTEGER,
     suspended_by   TEXT,
     result_outcome TEXT,
     result_reason  TEXT,
     result_at      INTEGER,
     joined_at      INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS game_index_updated_at ON game_index (updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

export function applyUserSchema(sql: SqlStorage): void {
  for (const statement of STATEMENTS) sql.exec(statement);
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    String(USER_SCHEMA_VERSION),
  );
}

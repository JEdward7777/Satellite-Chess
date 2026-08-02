/**
 * GameDO's SQLite schema.
 *
 * Applied on every construction rather than through a migration framework. The
 * statements are all `IF NOT EXISTS`, the object is single-tenant, and a DO wakes
 * far more often than the schema changes — so idempotent DDL is cheaper and
 * harder to get wrong than versioned migrations would be. When a column does need
 * adding, add it here *and* handle the upgrade in {@link applySchema}.
 */

/**
 * Bumped when the shape changes. Stored in `meta`, so a woken object can tell
 * whether its tables predate the code now running.
 */
export const SCHEMA_VERSION = 1;

const STATEMENTS = [
  // A single row, `id = 1`. One Durable Object is one game, and the CHECK makes a
  // second row impossible rather than merely unlikely.
  `CREATE TABLE IF NOT EXISTS game (
     id                  INTEGER PRIMARY KEY CHECK (id = 1),
     join_code           TEXT    NOT NULL,
     status              TEXT    NOT NULL,
     fen                 TEXT    NOT NULL,
     -- The field is snapshotted at creation so a re-calibration elsewhere cannot
     -- reshape a game in progress. Raw corners are the source of truth.
     field_snapshot_json TEXT    NOT NULL,
     white_player_id     TEXT,
     black_player_id     TEXT,
     -- The clock. Never held in memory: an object that hibernates has to
     -- reconstruct it from these three columns on every wake.
     white_ms_remaining  INTEGER NOT NULL,
     black_ms_remaining  INTEGER NOT NULL,
     increment_ms        INTEGER NOT NULL,
     active_color        TEXT    NOT NULL,
     last_clock_start_at INTEGER,
     -- Handicap, in metres of extra reach (decision 0004).
     white_reach_bonus_m REAL    NOT NULL DEFAULT 0,
     black_reach_bonus_m REAL    NOT NULL DEFAULT 0,
     draw_offer_from     TEXT,
     -- Who stopped the game, and when. Decision 0025: after CLAIM_AFTER_MS the
     -- *other* player may claim the win, so the player responsible has to be
     -- recorded at the moment of suspension. Without this, "claim if your
     -- opponent is offline" would let whoever walked off claim the win, since
     -- after a month nobody is connected.
     suspended_at        INTEGER,
     suspended_by        TEXT,
     result_outcome      TEXT,
     result_reason       TEXT,
     result_at           INTEGER,
     -- Incremented on every change, so a client can tell a stale snapshot from a
     -- current one after a reconnect.
     rev                 INTEGER NOT NULL DEFAULT 0,
     created_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL
   )`,

  // One row per completed move. Both position fixes are stored: a move is a lift
  // and a place separated by a walk (decision 0001), so there is no single
  // "position of the move". Costs almost nothing and pays for post-game review,
  // the distance statistic, and the only cheat forensics worth having.
  `CREATE TABLE IF NOT EXISTS moves (
     seq            INTEGER PRIMARY KEY,
     color          TEXT    NOT NULL,
     uci            TEXT    NOT NULL,
     san            TEXT    NOT NULL,
     fen_after      TEXT    NOT NULL,
     from_sq        TEXT    NOT NULL,
     to_sq          TEXT    NOT NULL,
     lift_lat       REAL,
     lift_lng       REAL,
     lift_acc       REAL,
     lift_at        INTEGER,
     place_lat      REAL,
     place_lng      REAL,
     place_acc      REAL,
     place_at       INTEGER,
     carried_m      REAL    NOT NULL DEFAULT 0,
     carried_ms     INTEGER NOT NULL DEFAULT 0,
     server_ms      INTEGER NOT NULL,
     clock_ms_after INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS presence (
     player_id      TEXT PRIMARY KEY,
     color          TEXT    NOT NULL,
     connected      INTEGER NOT NULL DEFAULT 0,
     last_seen_at   INTEGER,
     last_lat       REAL,
     last_lng       REAL,
     last_acc       REAL,
     last_pos_at    INTEGER,
     -- Client-reported, and client-trusted by design: it is a statistic, not a
     -- rule (decision 0019, observation O-03).
     travel_m       REAL    NOT NULL DEFAULT 0,
     -- Whether the server last saw this player inside their own back rank, for
     -- the start and resume handshakes (decision 0005).
     in_start_zone  INTEGER NOT NULL DEFAULT 0
   )`,

  // A piece in someone's hand, mid-walk. This is game state, not session state:
  // it has to survive hibernation, so it cannot live in memory. At most one
  // exists, because only the player to move may be carrying.
  `CREATE TABLE IF NOT EXISTS carry (
     id       INTEGER PRIMARY KEY CHECK (id = 1),
     color    TEXT    NOT NULL,
     from_sq  TEXT    NOT NULL,
     piece    TEXT    NOT NULL,
     lift_lat REAL    NOT NULL,
     lift_lng REAL    NOT NULL,
     lift_acc REAL    NOT NULL,
     lift_at  INTEGER NOT NULL
   )`,

  // A Durable Object has exactly one alarm and this design needs several
  // deadlines, so they are multiplexed here and the alarm is always set to the
  // earliest. See `timers.ts` and decision 0006.
  `CREATE TABLE IF NOT EXISTS timers (
     kind   TEXT    PRIMARY KEY,
     due_at INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS timers_due_at ON timers (due_at)`,

  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

export function applySchema(sql: SqlStorage): void {
  for (const statement of STATEMENTS) sql.exec(statement);
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    String(SCHEMA_VERSION),
  );
}

/** True once {@link initGame} has run — i.e. this join code names a real game. */
export function isInitialised(sql: SqlStorage): boolean {
  const [row] = [...sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM game`)];
  return (row?.n ?? 0) > 0;
}

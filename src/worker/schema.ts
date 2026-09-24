/**
 * GameDO's SQLite schema.
 *
 * Applied when a game is created, and on every wake of an object that already
 * holds one, rather than through a migration framework. The statements are all
 * `IF NOT EXISTS`, the object is single-tenant, and a DO wakes far more often
 * than the schema changes — so idempotent DDL is cheaper and harder to get
 * wrong than versioned migrations would be. When a column does need adding,
 * add it here *and* handle the upgrade in {@link applySchema}.
 *
 * **Never on the wake of an empty object** (decision 0042). Creating the tables
 * writes to storage, and a Durable Object with anything in storage exists. Any
 * request can address any code — a typo, a stranger, a phone re-opening a game
 * that has been archived and deleted — and until stage 8.4 every one of them
 * left a set of empty tables behind, so a deleted game came straight back as an
 * object that would never go away. {@link hasGameTables} is the check.
 */

/**
 * Bumped when the shape changes. Stored in `meta`, so a woken object can tell
 * whether its tables predate the code now running.
 */
export const SCHEMA_VERSION = 5;

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
     -- The account each seat accrues to, or NULL for a seat held by a phone
     -- that is not signed in. Schema 3, stage 2.3.4.
     --
     -- Today, for a signed-in seat, this holds the same string as the matching
     -- *_player_id: since stage 3.5.2 the seat key IS the Google sub when the
     -- request carried a session. They are nevertheless two different questions,
     -- and collapsing them would lose the one that matters here. A player id is
     -- "who holds this seat", which every game has; this is "which account this
     -- game accrues to", which a game played before stage 2.5.1 lands may
     -- perfectly well not have. It is the only thing that tells the game whether
     -- it has a UserDO to write an index row into — a seat key that is really a
     -- phone's UUID addresses an account that does not exist, and writing to it
     -- would invent one.
     white_account       TEXT,
     black_account       TEXT,
     -- The clock. Never held in memory: an object that hibernates has to
     -- reconstruct it from these three columns on every wake.
     white_ms_remaining  INTEGER NOT NULL,
     black_ms_remaining  INTEGER NOT NULL,
     increment_ms        INTEGER NOT NULL,
     -- What each clock started at. The two columns above are what is *left*,
     -- so once a move has been played nothing else remembers the time control
     -- the game was created with — and the PGN has a tag for it (schema 5,
     -- stage 8.1). NULL reads as "not known", which is what the standard's
     -- TimeControl "?" says, and is honest for a game that predates this.
     initial_ms          INTEGER,
     active_color        TEXT    NOT NULL,
     last_clock_start_at INTEGER,
     -- Handicap, in squares of extra reach (decisions 0004, 0031).
     white_reach_bonus_sq REAL   NOT NULL DEFAULT 0,
     black_reach_bonus_sq REAL   NOT NULL DEFAULT 0,
     -- The reach rule, chosen at creation and fixed for the life of the game.
     -- Snapshotted for the same reason the field is: a game must not change
     -- shape under the players. NULL means "whatever the code defaults to",
     -- which is how games created before schema 2 read.
     reach_json          TEXT,
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
     -- Metres walked *while this game was active*. Client-measured, and
     -- client-trusted by design: it is a statistic, not a rule (decision 0019,
     -- observation O-03). Since schema 4 it is credited by difference rather
     -- than taken as reported — see travel_leg below and decision 0040.
     travel_m       REAL    NOT NULL DEFAULT 0,
     -- Which of the phone's distance counters the last report came from, and
     -- the largest value that counter has reported. Schema 4.
     --
     -- The phone's counter runs for the life of the page, not the game: it
     -- includes calibrating, the walk to the park, and every earlier game in
     -- the same sitting, and it restarts at zero on a reload. Taking its value
     -- as this game's distance (the rule until schema 4) credited all of that
     -- to whichever game happened to be open. So the game credits only what a
     -- counter adds *between two of its own reports*, and only while active; a
     -- counter it has not seen before (a reload, a second game) sets a baseline
     -- and is credited nothing on its first report.
     travel_leg     TEXT,
     travel_seen_m  REAL    NOT NULL DEFAULT 0,
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

/**
 * Columns added or renamed after a version of this code was already deployed.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so a
 * DO that predates a column never gets it from {@link STATEMENTS} alone. These
 * run after the DDL, are driven by what `table_info` actually reports, and are
 * therefore no-ops on a freshly created object.
 */
function upgradeGameTable(sql: SqlStorage): void {
  const columns = new Set(
    [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('game')`)].map(
      (row) => row.name,
    ),
  );
  // Nothing to upgrade until the table exists at all.
  if (columns.size === 0) return;

  // Schema 2: the handicap became squares rather than metres (decision 0031).
  // The stored numbers are metres and cannot be converted here — the square
  // size lives in the field snapshot, and a bonus of "2" meant 2 m before and
  // means 2 squares now. Renaming without converting would silently multiply
  // every live handicap by the square size, so the value is reset to 0 instead:
  // a handicap is a courtesy agreed out loud, and losing it mid-game is far
  // better than inflating it eightfold.
  for (const [oldName, newName] of [
    ['white_reach_bonus_m', 'white_reach_bonus_sq'],
    ['black_reach_bonus_m', 'black_reach_bonus_sq'],
  ]) {
    if (columns.has(oldName!) && !columns.has(newName!)) {
      sql.exec(`ALTER TABLE game RENAME COLUMN ${oldName} TO ${newName}`);
      sql.exec(`UPDATE game SET ${newName} = 0`);
    }
  }

  // Schema 2: the reach rule is snapshotted per game. NULL reads as "the code's
  // default", which is what a pre-schema-2 game was played by anyway.
  if (!columns.has('reach_json')) {
    sql.exec(`ALTER TABLE game ADD COLUMN reach_json TEXT`);
  }

  // Schema 5: the time control the game started with (stage 8.1). A game with
  // no move played yet still has it, untouched, in Black's remaining clock; one
  // already under way does not, and NULL is the honest answer there rather
  // than whatever is left on somebody's clock. Black's and not White's: White's
  // clock runs from the start, and a pause before the first move banks what it
  // spent into White's column, so White's can be short while nothing has been
  // played. Black's cannot run until White has moved.
  if (!columns.has('initial_ms')) {
    sql.exec(`ALTER TABLE game ADD COLUMN initial_ms INTEGER`);
    const [played] = [...sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM moves`)];
    if ((played?.n ?? 0) === 0) {
      sql.exec(`UPDATE game SET initial_ms = black_ms_remaining WHERE initial_ms IS NULL`);
    }
  }

  // Schema 3: which account each seat accrues to (stage 2.3.4). NULL for every
  // game that predates it, which is the correct answer rather than a missing
  // one — those seats were taken by a phone with no session behind it, so there
  // is no account whose index they belong in. A game in progress when this
  // deploys keeps working and simply never appears in anybody's list.
  for (const column of ['white_account', 'black_account']) {
    if (!columns.has(column)) sql.exec(`ALTER TABLE game ADD COLUMN ${column} TEXT`);
  }
}

/**
 * Schema 4: the presence columns that let distance be credited per game rather
 * than taken from a counter that runs for the life of the page.
 *
 * **A game still in play starts again from zero.** Whatever it had been given
 * under the old rule is the page's whole counter — the calibration walk, the
 * walk to the park, the last game — and stage 2.3.5 turns that number into a
 * permanent row the moment this game ends. Keeping it would put one knowingly
 * wrong figure into a record that is never rewritten; dropping it costs the
 * part of this game walked before the deploy, which is the cheaper of the two
 * losses. What it leaves behind is a game that reads as honestly measured and
 * is short by that much — the accepted caveat in decision 0040.
 *
 * A **finished** game is left exactly as it is, and not because its line has
 * already been pushed — the record ships in the same deploy as these columns,
 * so no game has ever pushed one. It is left alone because zeroing it would
 * look like "walked nowhere" when the truth is "nobody measured it", and
 * `GameDO.recordLine` already tells those apart: a row with distance credited
 * under the old rule and never reported under the new one is recorded as
 * **unmeasured**, and sits outside every total.
 */
function upgradePresenceTable(sql: SqlStorage): void {
  const columns = new Set(
    [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('presence')`)].map(
      (row) => row.name,
    ),
  );
  if (columns.size === 0) return;
  const adding = !columns.has('travel_leg') || !columns.has('travel_seen_m');
  if (!columns.has('travel_leg')) sql.exec(`ALTER TABLE presence ADD COLUMN travel_leg TEXT`);
  if (!columns.has('travel_seen_m')) {
    sql.exec(`ALTER TABLE presence ADD COLUMN travel_seen_m REAL NOT NULL DEFAULT 0`);
  }
  if (!adding) return;
  const [game] = [...sql.exec<{ status: string }>(`SELECT status FROM game WHERE id = 1`)];
  if (game !== undefined && game.status !== 'finished') {
    sql.exec(`UPDATE presence SET travel_m = 0`);
  }
}

export function applySchema(sql: SqlStorage): void {
  for (const statement of STATEMENTS) sql.exec(statement);
  upgradeGameTable(sql);
  upgradePresenceTable(sql);
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    String(SCHEMA_VERSION),
  );
}

/**
 * Whether this object has ever been given the schema — i.e. whether it is a
 * game, or was one that has not been collected.
 *
 * A read of `sqlite_master` and nothing else, so asking it of an empty object
 * leaves the object empty. Every path into `GameDO` that could arrive at a code
 * holding nothing asks this before it touches a table (decision 0042).
 */
export function hasGameTables(sql: SqlStorage): boolean {
  const [row] = [
    ...sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'game'`,
    ),
  ];
  return (row?.n ?? 0) > 0;
}

/** True once a game has been created here — i.e. this join code names a real game. */
export function isInitialised(sql: SqlStorage): boolean {
  if (!hasGameTables(sql)) return false;
  const [row] = [...sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM game`)];
  return (row?.n ?? 0) > 0;
}

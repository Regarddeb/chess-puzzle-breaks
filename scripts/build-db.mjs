import Database from "better-sqlite3";
import { createReadStream, existsSync, unlinkSync } from "fs";
import { parse } from "csv-parse";

const CSV_PATH = "./lichess_db_puzzle.csv";
const DB_PATH = "./puzzles.sqlite";

// Optional filter — set to 0 to keep everything (all 6M rows)
const MIN_NB_PLAYS = 1000;

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH); // start fresh each run
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = OFF"); // faster bulk insert, safe since this is a one-off build

db.exec(`
  CREATE TABLE puzzles (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    moves TEXT NOT NULL,
    rating INTEGER NOT NULL,
    rating_deviation INTEGER,
    popularity INTEGER,
    nb_plays INTEGER,
    game_url TEXT,
    opening_tags TEXT
  );

  CREATE TABLE puzzle_themes (
    puzzle_id TEXT,
    theme TEXT
  );
`);

const insertPuzzle = db.prepare(`
  INSERT INTO puzzles (id, fen, moves, rating, rating_deviation, popularity, nb_plays, game_url, opening_tags)
  VALUES (@id, @fen, @moves, @rating, @rating_deviation, @popularity, @nb_plays, @game_url, @opening_tags)
`);

const insertTheme = db.prepare(`
  INSERT INTO puzzle_themes (puzzle_id, theme) VALUES (?, ?)
`);

const insertBatch = db.transaction((rows) => {
  for (const row of rows) {
    insertPuzzle.run(row);
    if (row._themes) {
      for (const theme of row._themes) {
        insertTheme.run(row.id, theme);
      }
    }
  }
});

let batch = [];
const BATCH_SIZE = 5000;
let totalRows = 0;
let insertedRows = 0;
let startTime = Date.now();

console.log("Starting import...");

const parser = createReadStream(CSV_PATH).pipe(
  parse({
    columns: [
      "PuzzleId",
      "FEN",
      "Moves",
      "Rating",
      "RatingDeviation",
      "Popularity",
      "NbPlays",
      "Themes",
      "GameUrl",
      "OpeningTags",
      "DailyDate",
    ],
    from_line: 2, // skip header row
  }),
);

for await (const record of parser) {
  totalRows++;

  const nbPlays = parseInt(record.NbPlays, 10);
  if (nbPlays < MIN_NB_PLAYS) continue;

  batch.push({
    id: record.PuzzleId,
    fen: record.FEN,
    moves: record.Moves,
    rating: parseInt(record.Rating, 10),
    rating_deviation: parseInt(record.RatingDeviation, 10),
    popularity: parseInt(record.Popularity, 10),
    nb_plays: nbPlays,
    game_url: record.GameUrl,
    opening_tags: record.OpeningTags || null,
    _themes: record.Themes ? record.Themes.split(" ") : [],
  });

  if (batch.length >= BATCH_SIZE) {
    insertBatch(batch);
    insertedRows += batch.length;
    batch = [];

    if (totalRows % 100000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `Processed ${totalRows.toLocaleString()} rows (${insertedRows.toLocaleString()} kept) — ${elapsed}s`,
      );
    }
  }
}

// insert any remaining rows
if (batch.length > 0) {
  insertBatch(batch);
  insertedRows += batch.length;
}

console.log("Building indexes...");
db.exec(`
  CREATE INDEX idx_rating ON puzzles(rating);
  CREATE INDEX idx_popularity ON puzzles(popularity);
  CREATE INDEX idx_theme ON puzzle_themes(theme);
  CREATE INDEX idx_puzzle_theme ON puzzle_themes(puzzle_id, theme);
`);

console.log("Vacuuming...");
db.exec("VACUUM;");

db.close();

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(
  `Done. ${insertedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows kept. Total time: ${elapsed}s`,
);

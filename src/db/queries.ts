import Database from "better-sqlite3";

export interface Puzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  rating_deviation: number;
  popularity: number;
  nb_plays: number;
  game_url: string;
  opening_tags: string;
}

let db: Database.Database | null = null;

export function openDatabase(dbPath: string): void {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

function requireDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized — call openDatabase() first");
  }
  return db;
}

export function getRandomPuzzle(options: {
  minRating?: number;
  maxRating?: number;
  theme?: string;
}): Puzzle | undefined {
  const database = requireDb();
  const { minRating = 0, maxRating = 3500, theme } = options;

  if (theme) {
    return database
      .prepare(
        `
        SELECT p.* FROM puzzles p
        JOIN puzzle_themes pt ON pt.puzzle_id = p.id
        WHERE pt.theme = ? AND p.rating BETWEEN ? AND ?
        ORDER BY RANDOM()
        LIMIT 1
      `,
      )
      .get(theme, minRating, maxRating) as Puzzle | undefined;
  }

  return database
    .prepare(
      `
      SELECT * FROM puzzles
      WHERE rating BETWEEN ? AND ?
      ORDER BY RANDOM()
      LIMIT 1
    `,
    )
    .get(minRating, maxRating) as Puzzle | undefined;
}

export function getPuzzleThemes(puzzleId: string): string[] {
  const database = requireDb();
  const rows = database
    .prepare(`SELECT theme FROM puzzle_themes WHERE puzzle_id = ?`)
    .all(puzzleId) as { theme: string }[];
  return rows.map((r) => r.theme);
}

export function getAllThemes(): string[] {
  const database = requireDb();
  const rows = database
    .prepare(`SELECT DISTINCT theme FROM puzzle_themes ORDER BY theme`)
    .all() as { theme: string }[];
  return rows.map((r) => r.theme);
}

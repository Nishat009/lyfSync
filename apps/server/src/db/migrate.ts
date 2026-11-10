import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Works from src/db (tsx) and from dist (bundled): look for a sibling migrations folder. */
async function findMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(here, "../../migrations"),
    path.resolve(here, "../migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  for (const dir of candidates) {
    try {
      await readdir(dir);
      return dir;
    } catch {
      // try the next one
    }
  }
  throw new Error("migrations directory not found");
}

export async function runMigrations(connectionString: string, log = console.log): Promise<string[]> {
  const dir = await findMigrationsDir();
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // One migration run at a time, even if several instances boot together.
    await client.query("select pg_advisory_lock(727001)");
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      log(`applying ${file}`);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const isBundledMain = process.argv[1] && /migrate\.(js|mjs)$/.test(process.argv[1]);

if (isMain || isBundledMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy apps/server/.env.example to apps/server/.env.");
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

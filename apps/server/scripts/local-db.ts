// Starts a throwaway-free local PostgreSQL (embedded) so you can run LifeSync without installing
// Postgres or Docker. Data lives in <repo>/.data/postgres and survives restarts.
//   npm run db:local
// Leave it running, then in another terminal: npm run db:migrate && npm run dev
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseDir = path.join(root, ".data", "postgres");
const port = Number(process.env.LOCAL_DB_PORT ?? 54329);
const dbName = "lifesync";

const server = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
});

if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
  await server.initialise();
}
await server.start();

const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/postgres` });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
if (exists.rowCount === 0) await admin.query(`create database ${dbName}`);
await admin.end();

console.log(`\nLocal PostgreSQL is running.\nDATABASE_URL=postgres://postgres:postgres@localhost:${port}/${dbName}\nPress Ctrl+C to stop.\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => undefined, 1 << 30);

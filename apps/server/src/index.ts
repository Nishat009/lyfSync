import { createApp } from "./app";
import { loadConfig } from "./config";
import { closePool, createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { createMailer } from "./services/mailer";
import { createPushSender } from "./services/push";
import { startScheduler } from "./services/scheduler";

const config = loadConfig();
const log = (msg: string, err?: unknown) =>
  err ? console.error(`[api] ${msg}`, err instanceof Error ? err.stack : err) : console.log(`[api] ${msg}`);

// Migrations are idempotent and guarded by an advisory lock, so every boot can run them.
await runMigrations(config.DATABASE_URL, (m) => log(m));
createPool(config.DATABASE_URL);

const mailer = createMailer(config, log);
const push = createPushSender(config);
const app = createApp({ config, mailer, push, log });
const stopScheduler = startScheduler({ config, mailer, push, log });
const server = app.listen(config.PORT, () => log(`listening on :${config.PORT}`));

async function shutdown() {
  stopScheduler();
  server.close();
  await closePool();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import pg from "pg";

export type Db = pg.PoolClient;

let pool: pg.Pool | undefined;

export function createPool(connectionString: string): pg.Pool {
  pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client erroring (e.g. the database restarting) must not crash the process.
  pool.on("error", (err) => console.error("idle database client error:", err.message));
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("database pool is not initialised");
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

async function transaction<T>(setup: (db: Db) => Promise<void>, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("begin");
    await setup(db);
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

/**
 * Runs `fn` as the given user. The transaction switches to the restricted lifesync_app role, so
 * row-level security filters every query. This is the ONLY way route handlers touch user data.
 */
export function withUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return transaction(async (db) => {
    await db.query("set local role lifesync_app");
    await db.query("select set_config('app.user_id', $1, true)", [userId]);
  }, fn);
}

/**
 * Runs `fn` as the database owner, bypassing RLS. Reserved for flows that have no user yet or act
 * across users: registration, login, token redemption, invitation acceptance, the scheduler.
 * Every call site must do its own explicit authorization.
 */
export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return transaction(async () => undefined, fn);
}

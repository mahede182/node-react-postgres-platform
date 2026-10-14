import pg from "pg";

const { Pool } = pg;

function buildConnectionString() {
  const {
    DB_USER = "appuser",
    DB_PASSWORD = "apppass",
    DB_HOST = "localhost",
    DB_PORT = "5432",
    DB_NAME = "appdb",
  } = process.env;

  return `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

const writePool = new Pool({
  connectionString: process.env.DB_WRITE_URL || buildConnectionString(),
});

const readPool = new Pool({
  connectionString:
    process.env.DB_READ_URL ||
    process.env.DB_WRITE_URL ||
    buildConnectionString(),
});

export async function initSchema() {
  await writePool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export function write(query, params) {
  return writePool.query(query, params);
}

export function read(query, params) {
  return readPool.query(query, params);
}

export async function pingWrite() {
  await writePool.query("SELECT 1");
}

export async function pingRead() {
  await readPool.query("SELECT 1");
}

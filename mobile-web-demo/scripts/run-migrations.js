const fs = require('fs');
const path = require('path');
const { databaseConfigured, pool } = require('../database');

async function main() {
  if (!databaseConfigured) throw new Error('DATABASE_URL is required');
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  await pool.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
    alter table schema_migrations enable row level security;
    revoke all on table schema_migrations from anon, authenticated;
  `);

  for (const file of files) {
    const applied = await pool.query(
      'select 1 from schema_migrations where filename = $1',
      [file]
    );
    if (applied.rowCount) {
      console.log(`Skipped migration already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      .replace(/^\s*begin\s*;\s*/i, '')
      .replace(/\s*commit\s*;\s*$/i, '');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        'insert into schema_migrations (filename) values ($1)',
        [file]
      );
      await client.query('commit');
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    if (pool) await pool.end().catch(() => {});
    process.exitCode = 1;
  });

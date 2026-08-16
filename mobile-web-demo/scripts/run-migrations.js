const fs = require('fs');
const path = require('path');
const { databaseConfigured, pool } = require('../database');

async function main() {
  if (!databaseConfigured) throw new Error('DATABASE_URL is required');
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`Applied migration: ${file}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    if (pool) await pool.end().catch(() => {});
    process.exitCode = 1;
  });

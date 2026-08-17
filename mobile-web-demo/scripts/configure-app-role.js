const { Pool } = require('pg');

function poolFor(connectionString) {
  const parsed = new URL(connectionString);
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('uselibpqcompat');
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/i.test(connectionString);
  return new Pool({
    connectionString: parsed.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10_000
  });
}

async function main() {
  const migrationUrl = String(process.env.MIGRATION_DATABASE_URL || '').trim();
  const appUrl = String(process.env.APP_DATABASE_URL || '').trim();
  if (!migrationUrl) throw new Error('MIGRATION_DATABASE_URL is required');
  if (!appUrl) throw new Error('APP_DATABASE_URL is required');

  const parsedAppUrl = new URL(appUrl);
  const appUsername = decodeURIComponent(parsedAppUrl.username);
  const appPassword = decodeURIComponent(parsedAppUrl.password);
  if (appUsername !== 'yanxiaobei_app' && !appUsername.startsWith('yanxiaobei_app.')) {
    throw new Error('APP_DATABASE_URL must use the yanxiaobei_app database role');
  }
  if (appPassword.length < 32) throw new Error('APP_DATABASE_URL must contain a strong role password');

  const adminPool = poolFor(migrationUrl);
  try {
    const statement = await adminPool.query(
      "select format('alter role yanxiaobei_app with login password %L', $1::text) as sql",
      [appPassword]
    );
    await adminPool.query(statement.rows[0].sql);
  } finally {
    await adminPool.end();
  }

  let verified = false;
  let lastError;
  for (let attempt = 1; attempt <= 15 && !verified; attempt += 1) {
    const appPool = poolFor(appUrl);
    try {
      const result = await appPool.query('select current_user as current_user');
      verified = result.rows[0]?.current_user === 'yanxiaobei_app';
    } catch (error) {
      lastError = error;
    } finally {
      await appPool.end().catch(() => {});
    }
    if (!verified && attempt < 15) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  if (!verified) throw lastError || new Error('Application role verification failed');
  console.log('Application database role configured and verified');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

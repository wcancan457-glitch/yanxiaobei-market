const db = require('../database');

async function main() {
  const health = await db.healthcheck();
  const tables = await db.query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
       and table_name in (
         'users', 'sessions', 'products', 'tasks', 'purchase_intents', 'messages',
         'auth_tokens', 'task_applications', 'notifications', 'user_blocks', 'reports'
       )
     order by table_name`
  );
  const counts = await db.query(
    `select
      (select count(*)::int from users) as users,
      (select count(*)::int from products) as products,
      (select count(*)::int from tasks) as tasks,
      (select count(*)::int from purchase_intents) as intents,
      (select count(*)::int from messages) as messages,
      (select count(*)::int from task_applications) as task_applications,
      (select count(*)::int from notifications) as notifications,
      (select count(*)::int from user_blocks) as blocks,
      (select count(*)::int from reports) as reports`
  );
  console.log(JSON.stringify({
    ok: true,
    database: health.database,
    tables: tables.rows.map((row) => row.table_name),
    counts: counts.rows[0]
  }, null, 2));
}

main()
  .then(() => db.pool.end())
  .catch(async (error) => {
    console.error(error);
    if (db.pool) await db.pool.end().catch(() => {});
    process.exitCode = 1;
  });

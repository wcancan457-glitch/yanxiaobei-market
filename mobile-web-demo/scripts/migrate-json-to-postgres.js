const fs = require('fs');
const path = require('path');
const { databaseConfigured, pool, transaction } = require('../database');
const { normalizeStudentId, validStudentId } = require('../student-id');
const { sanitizeStoredProductImage, sanitizeImageClass } = require('../content-security');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const authFile = path.join(dataDir, 'auth.json');
const stateFile = path.join(dataDir, 'db.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function asDate(value) {
  const date = new Date(Number(value) || value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function makeBackup() {
  if (!fs.existsSync(authFile) && !fs.existsSync(stateFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, 'backups', `pre-postgres-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(authFile)) fs.copyFileSync(authFile, path.join(backupDir, 'auth.json'));
  if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, path.join(backupDir, 'db.json'));
  return backupDir;
}

function collectUsers(auth, state) {
  const users = new Map();
  const ensure = (studentId, source = {}) => {
    const id = normalizeStudentId(studentId);
    if (!validStudentId(id)) return;
    const existing = users.get(id) || {};
    users.set(id, {
      studentId: id,
      name: source.name || existing.name || '校园用户',
      campus: source.campus || existing.campus || '平乐园校区',
      passwordHash: source.passwordHash || existing.passwordHash || '!disabled'
    });
  };

  Object.entries(state.users || {}).forEach(([id, user]) => ensure(id, user));
  Object.entries(auth.users || {}).forEach(([id, user]) => ensure(id, user));
  (state.products || []).forEach((item) => {
    ensure(item.sellerId, { name: item.sellerName });
    ensure(item.buyerId);
  });
  (state.tasks || []).forEach((item) => {
    ensure(item.publisherId);
    ensure(item.takerId);
  });
  (state.intents || []).forEach((item) => ensure(item.buyerId));
  (state.chats || []).forEach((item) => {
    ensure(item.from);
    ensure(item.to);
  });
  return users;
}

async function main() {
  if (!databaseConfigured) throw new Error('DATABASE_URL is required');
  const auth = readJson(authFile, { users: {} });
  const state = readJson(stateFile, {});
  const backupDir = makeBackup();
  const users = collectUsers(auth, state);

  const counts = await transaction(async (client) => {
    const userIds = new Map();
    for (const user of users.values()) {
      const result = await client.query(
        `insert into users
          (student_id, name, campus, password_hash, email_verified_at, verification_method,
           nickname_change_required)
         values ($1, case when $5 then '昵称待设置' else $2 end, $3, $4, now(), 'legacy', $5)
         on conflict (student_id) do update set
           campus = excluded.campus,
           password_hash = case
             when users.password_hash = '!disabled' then excluded.password_hash
             else users.password_hash
           end
         returning id`,
        [
          user.studentId,
          user.name,
          user.campus,
          user.passwordHash,
          user.name === '校园用户' || /^同学\d{4}$/.test(user.name)
        ]
      );
      userIds.set(user.studentId, String(result.rows[0].id));
    }

    let products = 0;
    for (const item of state.products || []) {
      const sellerId = userIds.get(String(item.sellerId));
      if (!sellerId) continue;
      let safeImage = null;
      let safeImageClass = 'img-guitar';
      try {
        safeImage = sanitizeStoredProductImage(item.image) || null;
      } catch {
        safeImage = null;
      }
      try {
        safeImageClass = sanitizeImageClass(item.imgClass);
      } catch {
        safeImageClass = 'img-guitar';
      }
      await client.query(
        `insert into products
          (id, title, category, item_condition, campus, campus_text, price, location, description,
           status, seller_id, buyer_id, image_url, image_class, symbol, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         on conflict (id) do update set
           title = excluded.title,
           category = excluded.category,
           item_condition = excluded.item_condition,
           campus = excluded.campus,
           campus_text = excluded.campus_text,
           price = excluded.price,
           location = excluded.location,
           description = excluded.description,
           status = excluded.status,
           seller_id = excluded.seller_id,
           buyer_id = excluded.buyer_id,
           image_url = excluded.image_url,
           image_class = excluded.image_class,
           symbol = excluded.symbol`,
        [
          item.id,
          item.title,
          item.category || '其他',
          item.condition || '未填写',
          item.campus || 'pingleyuan',
          item.campusText || '平乐园校区',
          Number(item.price) || 0.01,
          item.location || '校内公共地点',
          item.desc || '',
          ['available', 'trading', 'sold', 'down'].includes(item.status) ? item.status : 'available',
          sellerId,
          userIds.get(String(item.buyerId)) || null,
          safeImage,
          safeImageClass,
          item.symbol || null,
          asDate(item.createdAt)
        ]
      );
      products += 1;
    }

    let tasks = 0;
    for (const item of state.tasks || []) {
      const publisherId = userIds.get(String(item.publisherId));
      if (!publisherId) continue;
      const taskCreatedAt = asDate(item.createdAt);
      const taskDeadlineAt = item.deadlineAt ? asDate(item.deadlineAt) : null;
      const taskEstimatedMinutes = Number.isInteger(Number(item.estimatedMinutes))
        ? Number(item.estimatedMinutes)
        : null;
      const terminalStatus = ['done', 'cancelled', 'expired'].includes(item.status);
      const activeStatusIsValid = ['open', 'in_progress'].includes(item.status)
        && taskDeadlineAt
        && taskEstimatedMinutes
        && taskDeadlineAt > taskCreatedAt;
      const taskStatus = terminalStatus || activeStatusIsValid ? item.status : 'expired';
      await client.query(
        `insert into tasks
          (id, title, task_type, campus, campus_text, reward, location, description,
           deadline_at, estimated_minutes, status, publisher_id, taker_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (id) do update set
           title = excluded.title,
           task_type = excluded.task_type,
           campus = excluded.campus,
           campus_text = excluded.campus_text,
           reward = excluded.reward,
           location = excluded.location,
           description = excluded.description,
           deadline_at = excluded.deadline_at,
           estimated_minutes = excluded.estimated_minutes,
           status = excluded.status,
           publisher_id = excluded.publisher_id,
           taker_id = excluded.taker_id`,
        [
          item.id,
          item.title,
          ['pickup', 'errand', 'part_time', 'skill', 'other'].includes(item.taskType) ? item.taskType : 'other',
          item.campus || 'pingleyuan',
          item.campusText || '平乐园校区',
          Number(item.reward) || 0.01,
          item.location || '校内公共地点',
          item.desc || '',
          taskDeadlineAt,
          taskEstimatedMinutes,
          taskStatus,
          publisherId,
          userIds.get(String(item.takerId)) || null,
          taskCreatedAt
        ]
      );
      tasks += 1;
    }

    let intents = 0;
    for (const item of state.intents || []) {
      const buyerId = userIds.get(String(item.buyerId));
      if (!buyerId) continue;
      await client.query(
        `insert into purchase_intents (id, product_id, buyer_id, status, created_at)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set status = excluded.status`,
        [
          item.id,
          item.productId,
          buyerId,
          ['pending', 'accepted', 'rejected', 'canceled', 'sold'].includes(item.status) ? item.status : 'pending',
          asDate(item.createdAt)
        ]
      );
      intents += 1;
    }

    let messages = 0;
    for (const item of state.chats || []) {
      const senderId = userIds.get(String(item.from));
      const recipientId = userIds.get(String(item.to));
      if (!senderId || !recipientId) continue;
      await client.query(
        `insert into messages (id, product_id, sender_id, recipient_id, body, created_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do nothing`,
        [item.id, item.productId, senderId, recipientId, String(item.text || '').slice(0, 2000), asDate(item.createdAt)]
      );
      messages += 1;
    }

    return { users: users.size, products, tasks, intents, messages };
  });

  console.log(JSON.stringify({ ok: true, backupDir, imported: counts }, null, 2));
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    if (pool) await pool.end().catch(() => {});
    process.exitCode = 1;
  });

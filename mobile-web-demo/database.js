const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();

class AppError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createPool() {
  if (!databaseUrl) return null;
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/i.test(databaseUrl);
  return new Pool({
    connectionString: databaseUrl,
    ssl: local ? false : { rejectUnauthorized: true },
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
}

const pool = createPool();

if (pool) {
  pool.on('error', (error) => {
    console.error('PostgreSQL connection pool error:', error.message);
  });
}

function requirePool() {
  if (!pool) {
    throw new AppError(503, '数据库尚未配置，请设置 DATABASE_URL', 'database_not_configured');
  }
  return pool;
}

async function query(text, params = []) {
  return requirePool().query(text, params);
}

async function transaction(work) {
  const client = await requirePool().connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function timestamp(value) {
  return value ? new Date(value).getTime() : 0;
}

function money(value) {
  return Number(value);
}

function publicUser(row, includeStudentId = false) {
  if (!row) return null;
  const user = { id: String(row.id), name: row.name, campus: row.campus };
  if (includeStudentId) user.studentId = row.student_id;
  return user;
}

function productFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    campus: row.campus,
    campusText: row.campus_text,
    price: money(row.price),
    location: row.location,
    desc: row.description,
    status: row.status,
    sellerId: String(row.seller_id),
    sellerName: row.seller_name,
    buyerId: row.buyer_id ? String(row.buyer_id) : undefined,
    image: row.image_url || '',
    imgClass: row.image_class || '',
    symbol: row.symbol || '',
    createdAt: timestamp(row.created_at)
  };
}

function taskFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    campus: row.campus,
    campusText: row.campus_text,
    reward: money(row.reward),
    location: row.location,
    desc: row.description,
    status: row.status,
    publisherId: String(row.publisher_id),
    takerId: row.taker_id ? String(row.taker_id) : '',
    createdAt: timestamp(row.created_at)
  };
}

function intentFromRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    buyerId: String(row.buyer_id),
    status: row.status,
    createdAt: timestamp(row.created_at)
  };
}

function messageFromRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    from: String(row.sender_id),
    to: String(row.recipient_id),
    text: row.body,
    createdAt: timestamp(row.created_at)
  };
}

async function healthcheck() {
  const result = await query('select current_database() as database, now() as now');
  return result.rows[0];
}

async function findUserByStudentId(studentId) {
  const result = await query(
    'select id, student_id, name, campus, password_hash from users where student_id = $1',
    [studentId]
  );
  return result.rows[0] || null;
}

async function createUser({ studentId, name, campus, passwordHash }) {
  try {
    const result = await query(
      `insert into users (student_id, name, campus, password_hash)
       values ($1, $2, $3, $4)
       returning id, student_id, name, campus`,
      [studentId, name, campus, passwordHash]
    );
    return publicUser(result.rows[0], true);
  } catch (error) {
    if (error.code === '23505') {
      throw new AppError(409, '该学号已注册，请直接登录', 'student_id_exists');
    }
    throw error;
  }
}

async function createSession({ tokenHash, userId, expiresAt }) {
  await transaction(async (client) => {
    await client.query('delete from sessions where expires_at <= now()');
    await client.query(
      `insert into sessions (token_hash, user_id, expires_at)
       values ($1, $2, $3)`,
      [tokenHash, userId, expiresAt]
    );
  });
}

async function getSessionUser(tokenHash) {
  if (!tokenHash) return null;
  const result = await query(
    `select u.id, u.student_id, u.name, u.campus
     from sessions s
     join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash]
  );
  return result.rows[0] ? publicUser(result.rows[0], true) : null;
}

async function deleteSession(tokenHash) {
  if (tokenHash) await query('delete from sessions where token_hash = $1', [tokenHash]);
}

async function getBootstrap(userId = null) {
  const usersPromise = query('select id, name, campus from users order by created_at');
  const productsPromise = userId
    ? query(
        `select p.*, u.name as seller_name
         from products p join users u on u.id = p.seller_id
         where p.status in ('available', 'trading') or p.seller_id = $1 or p.buyer_id = $1
         order by p.created_at desc`,
        [userId]
      )
    : query(
        `select p.*, u.name as seller_name
         from products p join users u on u.id = p.seller_id
         where p.status in ('available', 'trading')
         order by p.created_at desc`
      );
  const tasksPromise = userId
    ? query(
        `select * from tasks
         where status in ('open', 'in_progress') or publisher_id = $1 or taker_id = $1
         order by created_at desc`,
        [userId]
      )
    : query(
        `select * from tasks
         where status in ('open', 'in_progress')
         order by created_at desc`
      );
  const intentsPromise = userId
    ? query(
        `select i.* from purchase_intents i
         join products p on p.id = i.product_id
         where i.buyer_id = $1 or p.seller_id = $1
         order by i.created_at`,
        [userId]
      )
    : Promise.resolve({ rows: [] });
  const messagesPromise = userId
    ? query(
        `select * from messages
         where sender_id = $1 or recipient_id = $1
         order by created_at`,
        [userId]
      )
    : Promise.resolve({ rows: [] });

  const [users, products, tasks, intents, messages] = await Promise.all([
    usersPromise,
    productsPromise,
    tasksPromise,
    intentsPromise,
    messagesPromise
  ]);

  return {
    users: Object.fromEntries(users.rows.map((row) => [String(row.id), publicUser(row)])),
    products: products.rows.map(productFromRow),
    tasks: tasks.rows.map(taskFromRow),
    intents: intents.rows.map(intentFromRow),
    chats: messages.rows.map(messageFromRow)
  };
}

async function createProduct(userId, input) {
  const id = `p_${randomUUID()}`;
  const result = await query(
    `insert into products
      (id, title, category, campus, campus_text, price, location, description,
       seller_id, image_url, image_class, symbol)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning *, (select name from users where id = seller_id) as seller_name`,
    [
      id,
      input.title,
      input.category,
      input.campus,
      input.campusText,
      input.price,
      input.location,
      input.desc,
      userId,
      input.image || null,
      input.imgClass || null,
      input.symbol || null
    ]
  );
  return productFromRow(result.rows[0]);
}

async function setProductAvailability(userId, productId, status) {
  if (!['available', 'down'].includes(status)) {
    throw new AppError(400, '商品状态不合法');
  }
  const result = await query(
    `update products set status = $3
     where id = $1 and seller_id = $2 and status not in ('trading', 'sold')
     returning *, (select name from users where id = seller_id) as seller_name`,
    [productId, userId, status]
  );
  if (!result.rows[0]) throw new AppError(403, '无权修改该商品或商品状态不允许修改');
  return productFromRow(result.rows[0]);
}

async function deleteProduct(userId, productId) {
  const result = await query(
    `delete from products
     where id = $1 and seller_id = $2 and status not in ('trading', 'sold')
     returning id`,
    [productId, userId]
  );
  if (!result.rows[0]) throw new AppError(403, '无权删除该商品或商品正在交易');
}

async function createTask(userId, input) {
  const id = `t_${randomUUID()}`;
  const result = await query(
    `insert into tasks
      (id, title, campus, campus_text, reward, location, description, publisher_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [id, input.title, input.campus, input.campusText, input.reward, input.location, input.desc, userId]
  );
  return taskFromRow(result.rows[0]);
}

async function updateTask(userId, taskId, action) {
  return transaction(async (client) => {
    const current = await client.query('select * from tasks where id = $1 for update', [taskId]);
    const task = current.rows[0];
    if (!task) throw new AppError(404, '任务不存在');

    if (action === 'take') {
      if (task.status !== 'open') throw new AppError(409, '任务已被接取');
      if (String(task.publisher_id) === userId) throw new AppError(400, '不能接自己发布的任务');
      task.status = 'in_progress';
      task.taker_id = userId;
    } else if (action === 'done') {
      if (String(task.publisher_id) !== userId || task.status !== 'in_progress') {
        throw new AppError(403, '只有发布者可以确认完成');
      }
      task.status = 'done';
    } else if (action === 'cancel') {
      if (String(task.publisher_id) !== userId || task.status === 'done') {
        throw new AppError(403, '只有发布者可以取消任务');
      }
      task.status = 'cancelled';
      task.taker_id = null;
    } else {
      throw new AppError(400, '任务操作不合法');
    }

    const updated = await client.query(
      'update tasks set status = $2, taker_id = $3 where id = $1 returning *',
      [taskId, task.status, task.taker_id]
    );
    return taskFromRow(updated.rows[0]);
  });
}

async function createIntent(userId, productId) {
  return transaction(async (client) => {
    const productResult = await client.query('select * from products where id = $1 for update', [productId]);
    const product = productResult.rows[0];
    if (!product) throw new AppError(404, '商品不存在');
    if (product.status !== 'available') throw new AppError(409, '商品当前不可咨询');
    if (String(product.seller_id) === userId) throw new AppError(400, '不能购买自己的商品');

    const id = `i_${randomUUID()}`;
    let intent;
    try {
      const inserted = await client.query(
        `insert into purchase_intents (id, product_id, buyer_id)
         values ($1, $2, $3) returning *`,
        [id, productId, userId]
      );
      intent = inserted.rows[0];
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, '你已经发送过我想要');
      throw error;
    }

    const messageResult = await client.query(
      `insert into messages (id, product_id, sender_id, recipient_id, body)
       values ($1, $2, $3, $4, $5) returning *`,
      [`m_${randomUUID()}`, productId, userId, product.seller_id, '你好，我想要这个商品，可以聊一下吗？']
    );
    return { intent: intentFromRow(intent), message: messageFromRow(messageResult.rows[0]) };
  });
}

async function updateIntent(userId, intentId, action) {
  return transaction(async (client) => {
    const result = await client.query(
      `select i.*, p.seller_id, p.status as product_status
       from purchase_intents i join products p on p.id = i.product_id
       where i.id = $1 for update of i, p`,
      [intentId]
    );
    const intent = result.rows[0];
    if (!intent) throw new AppError(404, '购买意向不存在');
    if (String(intent.seller_id) !== userId) throw new AppError(403, '只有卖家可以处理购买意向');
    if (intent.status !== 'pending') throw new AppError(409, '该购买意向已经处理');

    if (action === 'reject') {
      const updated = await client.query(
        "update purchase_intents set status = 'rejected' where id = $1 returning *",
        [intentId]
      );
      return { intent: intentFromRow(updated.rows[0]) };
    }
    if (action !== 'accept') throw new AppError(400, '购买意向操作不合法');
    if (intent.product_status !== 'available') throw new AppError(409, '商品已经不处于在售状态');

    const updatedIntent = await client.query(
      "update purchase_intents set status = 'accepted' where id = $1 returning *",
      [intentId]
    );
    await client.query(
      `update purchase_intents set status = 'rejected'
       where product_id = $1 and id <> $2 and status = 'pending'`,
      [intent.product_id, intentId]
    );
    await client.query(
      "update products set status = 'trading', buyer_id = $2 where id = $1",
      [intent.product_id, intent.buyer_id]
    );
    const messageResult = await client.query(
      `insert into messages (id, product_id, sender_id, recipient_id, body)
       values ($1, $2, $3, $4, $5) returning *`,
      [`m_${randomUUID()}`, intent.product_id, userId, intent.buyer_id, '我接受你的我想要了，我们可以约线下面交。']
    );
    return { intent: intentFromRow(updatedIntent.rows[0]), message: messageFromRow(messageResult.rows[0]) };
  });
}

async function updateTrade(userId, productId, action) {
  return transaction(async (client) => {
    const productResult = await client.query('select * from products where id = $1 for update', [productId]);
    const product = productResult.rows[0];
    if (!product) throw new AppError(404, '商品不存在');
    if (String(product.seller_id) !== userId) throw new AppError(403, '只有卖家可以处理交易');
    if (product.status !== 'trading') throw new AppError(409, '商品不在交易中');

    const nextProductStatus = action === 'sold' ? 'sold' : action === 'cancel' ? 'available' : null;
    const nextIntentStatus = action === 'sold' ? 'sold' : action === 'cancel' ? 'canceled' : null;
    if (!nextProductStatus) throw new AppError(400, '交易操作不合法');

    const intentResult = await client.query(
      `update purchase_intents set status = $2
       where product_id = $1 and status = 'accepted'
       returning *`,
      [productId, nextIntentStatus]
    );
    const updatedProduct = await client.query(
      `update products set status = $2, buyer_id = case when $2 = 'available' then null else buyer_id end
       where id = $1
       returning *, (select name from users where id = seller_id) as seller_name`,
      [productId, nextProductStatus]
    );
    return {
      product: productFromRow(updatedProduct.rows[0]),
      intent: intentResult.rows[0] ? intentFromRow(intentResult.rows[0]) : null
    };
  });
}

async function createMessage(userId, input) {
  return transaction(async (client) => {
    const access = await client.query(
      `select p.seller_id, i.buyer_id
       from products p
       left join purchase_intents i
         on i.product_id = p.id and i.buyer_id in ($2, $3)
       where p.id = $1`,
      [input.productId, userId, input.peerId]
    );
    const row = access.rows[0];
    if (!row) throw new AppError(404, '商品不存在');
    const sellerId = String(row.seller_id);
    const buyerId = row.buyer_id ? String(row.buyer_id) : null;
    const allowed =
      (userId === sellerId && input.peerId === buyerId) ||
      (userId === buyerId && input.peerId === sellerId);
    if (!allowed) throw new AppError(403, '无权在该会话中发送消息');

    const result = await client.query(
      `insert into messages (id, product_id, sender_id, recipient_id, body)
       values ($1, $2, $3, $4, $5) returning *`,
      [`m_${randomUUID()}`, input.productId, userId, input.peerId, input.text]
    );
    return messageFromRow(result.rows[0]);
  });
}

module.exports = {
  AppError,
  databaseConfigured: Boolean(pool),
  pool,
  query,
  transaction,
  healthcheck,
  publicUser,
  findUserByStudentId,
  createUser,
  createSession,
  getSessionUser,
  deleteSession,
  getBootstrap,
  createProduct,
  setProductAvailability,
  deleteProduct,
  createTask,
  updateTask,
  createIntent,
  updateIntent,
  updateTrade,
  createMessage
};

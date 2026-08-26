const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const NICKNAME_CHANGE_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

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
  const connectionUrl = new URL(databaseUrl);
  // node-postgres lets sslmode from the URL replace the explicit ssl object.
  // Keep TLS policy in one place so proxy-compatible settings are respected.
  connectionUrl.searchParams.delete('sslmode');
  connectionUrl.searchParams.delete('uselibpqcompat');
  return new Pool({
    connectionString: connectionUrl.toString(),
    // Supabase's shared pooler requires TLS. Certificate-chain verification can
    // be enabled later by installing the project's CA certificate on the host.
    ssl: local ? false : { rejectUnauthorized: false },
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

function messageCursorTime(value) {
  if (!value) return '1970-01-01T00:00:00.000000Z';
  return new Date(value).toISOString().replace(/Z$/, '000Z');
}

function money(value) {
  return Number(value);
}

function publicUser(row, includeStudentId = false, includeRole = false) {
  if (!row) return null;
  const user = { id: String(row.id), name: row.name, campus: row.campus };
  if (includeStudentId) user.studentId = row.student_id;
  if (includeRole) {
    user.isAdmin = Boolean(row.is_admin);
    user.isVerified = Boolean(row.email_verified_at);
    user.schoolEmail = row.school_email || '';
    user.verificationMethod = row.verification_method || '';
    user.nicknameRequired = Boolean(row.nickname_change_required);
    user.nicknameUpdatedAt = timestamp(row.nickname_updated_at);
    user.nicknameNextChangeAt = row.nickname_updated_at
      ? timestamp(row.nickname_updated_at) + NICKNAME_CHANGE_COOLDOWN_MS
      : 0;
  }
  return user;
}

function productFromRow(row) {
  const moderationStatus = row.moderation_status || 'clear';
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    condition: row.item_condition || '未填写',
    campus: row.campus,
    campusText: row.campus_text,
    price: money(row.price),
    location: row.location,
    desc: row.description,
    status: moderationStatus === 'down' ? 'down' : row.status,
    businessStatus: row.status,
    moderationStatus,
    moderationReason: row.moderation_reason || '',
    moderatedAt: timestamp(row.moderated_at),
    sellerId: String(row.seller_id),
    sellerName: row.seller_name,
    buyerId: row.buyer_id ? String(row.buyer_id) : undefined,
    image: row.image_url || '',
    imgClass: row.image_class || '',
    symbol: row.symbol || '',
    interestCount: Number(row.interest_count || 0),
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
    taskType: row.task_type || 'other',
    deadlineAt: timestamp(row.deadline_at),
    estimatedMinutes: row.estimated_minutes ? Number(row.estimated_minutes) : null,
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
    createdAt: timestamp(row.created_at),
    cursor: `${row.cursor_time || messageCursorTime(row.created_at)}|${row.id}`,
    requestId: row.request_id || ''
  };
}

function taskApplicationFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    applicantId: String(row.applicant_id),
    applicantName: row.applicant_name || '',
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function notificationFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entity_type || '',
    entityId: row.entity_id || '',
    isRead: Boolean(row.is_read),
    createdAt: timestamp(row.created_at)
  };
}

function blockFromRow(row) {
  return {
    userId: String(row.blocked_id),
    name: row.blocked_name || '已屏蔽用户',
    createdAt: timestamp(row.created_at)
  };
}

function reportFromRow(row) {
  return {
    id: row.id,
    reporterId: String(row.reporter_id),
    reporterName: row.reporter_name || '',
    targetType: row.target_type,
    targetId: row.target_id,
    targetTitle: row.target_title || row.target_id,
    targetOwnerId: row.target_owner_id ? String(row.target_owner_id) : '',
    reason: row.reason,
    description: row.description,
    status: row.status,
    resolution: row.resolution || '',
    createdAt: timestamp(row.created_at),
    handledAt: timestamp(row.handled_at)
  };
}

async function healthcheck() {
  const result = await query('select current_database() as database, now() as now');
  return result.rows[0];
}

async function findUserByStudentId(studentId) {
  const result = await query(
    `select id, student_id, name, campus, password_hash, is_admin, is_disabled,
       school_email, email_verified_at, verification_method,
       nickname_change_required, nickname_updated_at
     from users where student_id = $1`,
    [studentId]
  );
  return result.rows[0] || null;
}

async function createUser({ studentId, name, campus, passwordHash, schoolEmail = null }) {
  try {
    const result = await query(
      `insert into users
        (student_id, name, campus, password_hash, school_email, last_login_at, login_count,
         nickname_change_required)
       values ($1, $2, $3, $4, $5, now(), 1, true)
       returning id, student_id, name, campus, is_admin, school_email,
         email_verified_at, verification_method, nickname_change_required, nickname_updated_at`,
      [studentId, name, campus, passwordHash, schoolEmail]
    );
    return publicUser(result.rows[0], true, true);
  } catch (error) {
    if (error.code === '23505') {
      if (String(error.constraint || '').includes('school_email')) {
        throw new AppError(409, '该校内邮箱已绑定其他账号', 'school_email_exists');
      }
      throw new AppError(409, '该学号已注册，请直接登录', 'student_id_exists');
    }
    throw error;
  }
}

async function recordLogin(userId) {
  await query(
    `update users
     set last_login_at = now(), login_count = login_count + 1
     where id = $1`,
    [userId]
  );
}

async function updateUserProfile(userId, name) {
  return transaction(async (client) => {
    const currentResult = await client.query(
      `select id, student_id, name, campus, is_admin, is_disabled, school_email,
         email_verified_at, verification_method, nickname_change_required, nickname_updated_at
       from users where id = $1 for update`,
      [userId]
    );
    const current = currentResult.rows[0];
    if (!current || current.is_disabled) throw new AppError(404, '用户不存在或账号已停用');
    if (!current.email_verified_at) {
      throw new AppError(403, '请先完成校园身份认证，再设置公开昵称', 'identity_verification_required');
    }
    if (current.name === name && !current.nickname_change_required) return publicUser(current, true, true);

    if (!current.nickname_change_required && current.nickname_updated_at) {
      const nextChangeAt = new Date(current.nickname_updated_at).getTime() + NICKNAME_CHANGE_COOLDOWN_MS;
      const retryAfter = Math.max(0, Math.ceil((nextChangeAt - Date.now()) / 1000));
      if (retryAfter > 0) {
        const date = new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric'
        }).format(new Date(nextChangeAt));
        const error = new AppError(429, `昵称修改后需要等待90天，请在${date}后再试`, 'nickname_change_cooldown');
        error.retryAfter = retryAfter;
        throw error;
      }
    }

    const changeType = current.nickname_change_required ? 'initial' : 'user_change';
    const result = await client.query(
      `update users
       set name = $2, nickname_change_required = false, nickname_updated_at = now()
       where id = $1
       returning id, student_id, name, campus, is_admin, school_email,
         email_verified_at, verification_method, nickname_change_required, nickname_updated_at`,
      [userId, name]
    );
    await client.query(
      `insert into nickname_change_history
        (user_id, changed_by_user_id, previous_name, next_name, change_type)
       values ($1, $1, $2, $3, $4)`,
      [userId, current.name, name, changeType]
    );
    return publicUser(result.rows[0], true, true);
  });
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
    `update sessions s
     set last_seen_at = now()
     from users u
     where s.token_hash = $1
       and s.user_id = u.id
       and s.expires_at > now()
       and not u.is_disabled
      returning u.id, u.student_id, u.name, u.campus, u.is_admin,
        u.school_email, u.email_verified_at, u.verification_method,
        u.nickname_change_required, u.nickname_updated_at`,
    [tokenHash]
  );
  return result.rows[0] ? publicUser(result.rows[0], true, true) : null;
}

async function updateSchoolEmail(userId, schoolEmail) {
  try {
    return await transaction(async (client) => {
      const current = await client.query(
        'select school_email from users where id = $1 for update',
        [userId]
      );
      if (!current.rows[0]) throw new AppError(404, '用户不存在');
      const changed = String(current.rows[0].school_email || '').toLowerCase() !== schoolEmail.toLowerCase();
      const result = await client.query(
        `update users
         set school_email = $2,
             email_verified_at = case when $3 then null else email_verified_at end,
             verification_method = case when $3 then null else verification_method end
         where id = $1
         returning id, student_id, name, campus, is_admin, school_email,
           email_verified_at, verification_method, nickname_change_required, nickname_updated_at`,
        [userId, schoolEmail, changed]
      );
      if (changed) {
        await client.query(
          "delete from auth_tokens where user_id = $1 and purpose = 'verify_email'",
          [userId]
        );
      }
      return publicUser(result.rows[0], true, true);
    });
  } catch (error) {
    if (error.code === '23505') {
      throw new AppError(409, '该校内邮箱已绑定其他账号', 'school_email_exists');
    }
    throw error;
  }
}

async function markIdentityVerified(userId, method = 'email', expectedEmail = null) {
  const result = await query(
    `update users
     set email_verified_at = now(), verification_method = $2
     where id = $1
       and ($3::text is null or lower(school_email) = lower($3))
     returning id, student_id, name, campus, is_admin, school_email,
       email_verified_at, verification_method, nickname_change_required, nickname_updated_at`,
    [userId, method, expectedEmail]
  );
  if (!result.rows[0]) throw new AppError(409, '校内邮箱已变更，请重新获取验证码', 'school_email_changed');
  return publicUser(result.rows[0], true, true);
}

async function findVerifiedUserForReset(studentId, schoolEmail) {
  const result = await query(
    `select id, student_id, school_email
     from users
     where student_id = $1
       and lower(school_email) = lower($2)
       and email_verified_at is not null
       and not is_disabled`,
    [studentId, schoolEmail]
  );
  return result.rows[0] || null;
}

async function issueAuthToken({ userId, purpose, tokenHash, expiresAt }) {
  return transaction(async (client) => {
    await client.query('delete from auth_tokens where expires_at <= now() or consumed_at is not null');
    const recent = await client.query(
      `select created_at from auth_tokens
       where user_id = $1 and purpose = $2
       order by created_at desc limit 1`,
      [userId, purpose]
    );
    if (recent.rows[0]) {
      const elapsed = Date.now() - new Date(recent.rows[0].created_at).getTime();
      if (elapsed < 60_000) {
        const retryAfter = Math.max(1, Math.ceil((60_000 - elapsed) / 1000));
        const error = new AppError(
          429,
          `验证码刚刚已经发送，请 ${retryAfter} 秒后再试，并检查垃圾邮件箱`,
          'code_rate_limited'
        );
        error.retryAfter = retryAfter;
        throw error;
      }
    }
    await client.query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at)
       values ($1, $2, $3, $4)`,
      [userId, purpose, tokenHash, expiresAt]
    );
  });
}

async function deleteAuthToken(tokenHash) {
  await query('delete from auth_tokens where token_hash = $1', [tokenHash]);
}

async function consumeAuthToken({ userId, purpose, tokenHash }) {
  const outcome = await transaction(async (client) => {
    const result = await client.query(
      `select id, token_hash, attempts
       from auth_tokens
       where user_id = $1 and purpose = $2
         and consumed_at is null and expires_at > now() and attempts < 5
       order by created_at desc limit 1 for update`,
      [userId, purpose]
    );
    const token = result.rows[0];
    if (!token) return { ok: false, missing: true };
    if (token.token_hash !== tokenHash) {
      await client.query(
        `update auth_tokens
         set attempts = attempts + 1,
             consumed_at = case when attempts + 1 >= 5 then now() else consumed_at end
         where id = $1`,
        [token.id]
      );
      return { ok: false, missing: false };
    }
    await client.query('update auth_tokens set consumed_at = now() where id = $1', [token.id]);
    return { ok: true };
  });
  if (!outcome.ok) {
    throw new AppError(400, outcome.missing ? '验证码已过期，请重新获取' : '验证码不正确', 'invalid_auth_code');
  }
}

async function resetUserPassword(userId, nextPasswordHash) {
  await transaction(async (client) => {
    await client.query(
      `update users set password_hash = $2, password_changed_at = now() where id = $1`,
      [userId, nextPasswordHash]
    );
    await client.query('delete from sessions where user_id = $1', [userId]);
  });
}

async function deleteSession(tokenHash) {
  if (tokenHash) await query('delete from sessions where token_hash = $1', [tokenHash]);
}

function adminUserFromRow(row) {
  return {
    id: String(row.id),
    studentId: row.student_id,
    name: row.name,
    campus: row.campus,
    isAdmin: Boolean(row.is_admin),
    isDisabled: Boolean(row.is_disabled),
    isVerified: Boolean(row.email_verified_at),
    schoolEmail: row.school_email || '',
    verificationMethod: row.verification_method || '',
    nicknameRequired: Boolean(row.nickname_change_required),
    nicknameUpdatedAt: timestamp(row.nickname_updated_at),
    nicknameNextChangeAt: row.nickname_updated_at
      ? timestamp(row.nickname_updated_at) + NICKNAME_CHANGE_COOLDOWN_MS
      : 0,
    registeredAt: timestamp(row.created_at),
    lastLoginAt: timestamp(row.last_login_at),
    loginCount: Number(row.login_count || 0),
    validSessions: Number(row.valid_sessions || 0),
    activeSessions: Number(row.active_sessions || 0),
    productCount: Number(row.product_count || 0),
    taskCount: Number(row.task_count || 0)
  };
}

async function getAdminOverview() {
  const result = await query(`
    select
      (select count(*) from users) as total_users,
      (select count(*) from users where not is_disabled) as enabled_users,
      (select count(distinct user_id) from sessions where expires_at > now() and last_seen_at >= now() - interval '15 minutes') as active_users,
      (select count(*) from sessions where expires_at > now()) as valid_sessions,
      (select count(*) from sessions where expires_at > now() and last_seen_at >= now() - interval '15 minutes') as active_sessions,
      (select count(*) from users where last_login_at >= now() - interval '24 hours') as logins_24h,
      (select count(*) from users where created_at >= now() - interval '7 days') as new_users_7d,
      (select count(*) from users where email_verified_at is null) as unverified_users,
      (select count(*) from reports where status in ('pending', 'reviewing')) as pending_reports,
      (select count(*) from products) as total_products,
      (select count(*) from tasks) as total_tasks
  `);
  const row = result.rows[0];
  return {
    totalUsers: Number(row.total_users),
    enabledUsers: Number(row.enabled_users),
    activeUsers: Number(row.active_users),
    validSessions: Number(row.valid_sessions),
    activeSessions: Number(row.active_sessions),
    logins24h: Number(row.logins_24h),
    newUsers7d: Number(row.new_users_7d),
    unverifiedUsers: Number(row.unverified_users),
    pendingReports: Number(row.pending_reports),
    totalProducts: Number(row.total_products),
    totalTasks: Number(row.total_tasks)
  };
}

async function getAdminUsers(search = '', status = 'all') {
  const result = await query(
    `with product_counts as (
       select seller_id as user_id, count(*)::int as product_count
       from products group by seller_id
     ), task_counts as (
       select publisher_id as user_id, count(*)::int as task_count
       from tasks group by publisher_id
     ), session_counts as (
       select user_id,
         count(*)::int as valid_sessions,
         count(*) filter (where last_seen_at >= now() - interval '15 minutes')::int as active_sessions
       from sessions where expires_at > now()
       group by user_id
     )
      select u.id, u.student_id, u.name, u.campus, u.is_admin, u.is_disabled,
       u.school_email, u.email_verified_at, u.verification_method,
       u.nickname_change_required, u.nickname_updated_at,
       u.created_at, u.last_login_at, u.login_count,
       coalesce(s.valid_sessions, 0) as valid_sessions,
       coalesce(s.active_sessions, 0) as active_sessions,
       coalesce(p.product_count, 0) as product_count,
       coalesce(t.task_count, 0) as task_count
     from users u
     left join product_counts p on p.user_id = u.id
     left join task_counts t on t.user_id = u.id
     left join session_counts s on s.user_id = u.id
     where ($1 = '' or u.student_id ilike '%' || $1 || '%' or u.name ilike '%' || $1 || '%')
       and (
         $2 = 'all'
         or ($2 = 'active' and not u.is_disabled)
         or ($2 = 'disabled' and u.is_disabled)
         or ($2 = 'unverified' and u.email_verified_at is null)
         or ($2 = 'online' and coalesce(s.active_sessions, 0) > 0)
       )
     order by u.is_admin desc, u.created_at desc
     limit 200`,
    [String(search || '').trim().slice(0, 50), status]
  );
  return result.rows.map(adminUserFromRow);
}

async function getAdminProducts(search = '', status = 'all') {
  const result = await query(
    `with intent_counts as (
       select product_id,
         count(*) filter (where status in ('pending', 'accepted'))::int as active_intent_count
       from purchase_intents group by product_id
     ), message_counts as (
       select product_id, count(*)::int as message_count
       from messages group by product_id
     )
     select p.*, seller.name as seller_name, seller.student_id as seller_student_id,
       coalesce(i.active_intent_count, 0) as active_intent_count,
       coalesce(m.message_count, 0) as message_count,
       audit.action as last_moderation_action,
       audit.reason as last_moderation_reason,
       audit.created_at as last_moderated_at
     from products p
     join users seller on seller.id = p.seller_id
     left join intent_counts i on i.product_id = p.id
     left join message_counts m on m.product_id = p.id
     left join lateral (
       select action, reason, created_at
       from admin_content_audit_log
       where target_type = 'product' and target_id = p.id
       order by created_at desc limit 1
     ) audit on true
     where (
       $1 = '' or p.title ilike '%' || $1 || '%' or seller.name ilike '%' || $1 || '%'
       or seller.student_id ilike '%' || $1 || '%'
     ) and (
       $2 = 'all'
       or ($2 = 'active' and p.moderation_status = 'clear' and p.status in ('available', 'trading'))
       or ($2 = 'down' and (p.moderation_status = 'down' or p.status = 'down'))
       or ($2 in ('available', 'trading', 'sold') and p.moderation_status = 'clear' and p.status = $2)
     )
     order by p.created_at desc
     limit 200`,
    [String(search || '').trim().slice(0, 80), status]
  );
  return result.rows.map(adminProductFromRow);
}

async function moderateUserContent(client, userId) {
  const sellerIntents = await client.query(
    `update purchase_intents i
     set status = 'canceled'
     from products p
     where i.product_id = p.id and p.seller_id = $1
       and i.status in ('pending', 'accepted')
     returning i.buyer_id, i.product_id`,
    [userId]
  );
  await client.query(
    `update products set status = 'down', buyer_id = null
     where seller_id = $1 and status in ('available', 'trading')`,
    [userId]
  );
  const buyerIntents = await client.query(
    `update purchase_intents i
     set status = 'canceled'
     from products p
     where i.product_id = p.id and i.buyer_id = $1
       and i.status in ('pending', 'accepted')
     returning i.product_id, p.seller_id`,
    [userId]
  );
  await client.query(
    `update products set status = 'available', buyer_id = null
     where buyer_id = $1 and status = 'trading'`,
    [userId]
  );
  const publisherApplications = await client.query(
    `update task_applications a
     set status = 'rejected'
     from tasks t
     where a.task_id = t.id and t.publisher_id = $1
       and a.status in ('pending', 'accepted')
     returning a.applicant_id, a.task_id`,
    [userId]
  );
  await client.query(
    `update tasks set status = 'cancelled', taker_id = null
     where publisher_id = $1 and status in ('open', 'in_progress')`,
    [userId]
  );
  const applicantApplications = await client.query(
    `update task_applications a
     set status = 'rejected'
     from tasks t
     where a.task_id = t.id and a.applicant_id = $1
       and a.status in ('pending', 'accepted')
     returning a.task_id, t.publisher_id`,
    [userId]
  );
  const takenTasks = await client.query(
    `update tasks
     set status = case when deadline_at > now() then 'open' else 'expired' end,
         taker_id = null
     where taker_id = $1 and status = 'in_progress'
     returning id, publisher_id`,
    [userId]
  );
  for (const intent of sellerIntents.rows) {
    await insertNotification(client, {
      userId: intent.buyer_id,
      type: 'moderation_trade_closed',
      title: '相关交易已结束',
      body: '因发布账号已被平台停用，这笔交易或咨询已关闭。',
      entityType: 'product',
      entityId: intent.product_id
    });
  }
  for (const intent of buyerIntents.rows) {
    await insertNotification(client, {
      userId: intent.seller_id,
      type: 'moderation_buyer_closed',
      title: '相关交易已结束',
      body: '因买家账号已被平台停用，这笔购买意向已关闭；商品已恢复为可交易状态。',
      entityType: 'product',
      entityId: intent.product_id
    });
  }
  for (const application of publisherApplications.rows) {
    await insertNotification(client, {
      userId: application.applicant_id,
      type: 'moderation_task_closed',
      title: '相关互助任务已结束',
      body: '因发布账号已被平台停用，这项互助任务和接单申请已关闭。',
      entityType: 'task',
      entityId: application.task_id
    });
  }
  const notifiedTaskPublishers = new Set();
  for (const application of applicantApplications.rows) {
    const key = `${application.publisher_id}:${application.task_id}`;
    if (notifiedTaskPublishers.has(key)) continue;
    notifiedTaskPublishers.add(key);
    await insertNotification(client, {
      userId: application.publisher_id,
      type: 'moderation_applicant_closed',
      title: '接单申请已结束',
      body: '一位申请者账号已被平台停用，其接单申请已关闭。',
      entityType: 'task',
      entityId: application.task_id
    });
  }
  for (const task of takenTasks.rows) {
    const key = `${task.publisher_id}:${task.id}`;
    if (notifiedTaskPublishers.has(key)) continue;
    await insertNotification(client, {
      userId: task.publisher_id,
      type: 'moderation_taker_closed',
      title: '接单者账号已停用',
      body: '当前接单者无法继续完成任务；未到期任务已重新开放，已到期任务已结束。',
      entityType: 'task',
      entityId: task.id
    });
  }
}

async function manageAdminUser(adminId, targetUserId, action) {
  if (!['disable', 'enable', 'force_logout', 'verify_identity', 'reset_nickname'].includes(action)) {
    throw new AppError(400, '不支持的用户管理操作');
  }
  return transaction(async (client) => {
    const targetResult = await client.query(
      `select id, student_id, name, is_admin, is_disabled, email_verified_at,
         nickname_change_required, nickname_updated_at
       from users where id = $1 for update`,
      [targetUserId]
    );
    const target = targetResult.rows[0];
    if (!target) throw new AppError(404, '用户不存在');
    if (target.is_admin || String(target.id) === String(adminId)) {
      throw new AppError(400, '不能对管理员账号执行此操作');
    }

    if (action === 'disable') {
      await client.query('update users set is_disabled = true where id = $1', [target.id]);
      await moderateUserContent(client, target.id);
    } else if (action === 'enable') {
      await client.query('update users set is_disabled = false where id = $1', [target.id]);
    } else if (action === 'verify_identity') {
      await client.query(
        `update users set email_verified_at = now(), verification_method = 'manual' where id = $1`,
        [target.id]
      );
      await insertNotification(client, {
        userId: target.id,
        type: 'identity_verified',
        title: '校园身份已认证',
        body: '管理员已完成你的校园身份核验，现在可以发布、申请接单和发送消息。',
        entityType: 'user',
        entityId: String(target.id)
      });
    } else if (action === 'reset_nickname') {
      const fallbackName = '昵称待设置';
      await client.query(
        `update users
         set name = $2, nickname_change_required = true, nickname_updated_at = null
         where id = $1`,
        [target.id, fallbackName]
      );
      await client.query(
        `insert into nickname_change_history
          (user_id, changed_by_user_id, previous_name, next_name, change_type)
         values ($1, $2, $3, $4, 'admin_reset')`,
        [target.id, adminId, target.name, fallbackName]
      );
      await insertNotification(client, {
        userId: target.id,
        type: 'nickname_reset',
        title: '请重新设置公开昵称',
        body: '原昵称已由平台重置。完成校园身份认证后，请重新设置昵称再继续发布、接单或聊天。',
        entityType: 'user',
        entityId: String(target.id)
      });
    }

    let sessionsRevoked = 0;
    if (action === 'disable' || action === 'force_logout') {
      const sessions = await client.query('delete from sessions where user_id = $1', [target.id]);
      sessionsRevoked = sessions.rowCount;
    }
    await client.query(
      `insert into admin_audit_log (admin_id, target_user_id, action)
       values ($1, $2, $3)`,
      [adminId, target.id, action]
    );
    return {
      id: String(target.id),
      studentId: target.student_id,
      isDisabled: action === 'disable' ? true : action === 'enable' ? false : target.is_disabled,
      isVerified: action === 'verify_identity' ? true : Boolean(target.email_verified_at),
      nicknameRequired: action === 'reset_nickname' ? true : Boolean(target.nickname_change_required),
      sessionsRevoked
    };
  });
}

async function manageAdminProduct(adminId, productId, action, reason) {
  if (!['down', 'restore', 'delete'].includes(action)) {
    throw new AppError(400, '不支持的商品管理操作');
  }
  return transaction(async (client) => {
    const participantPreview = await client.query(
      `select p.seller_id,
         array(
           select distinct i.buyer_id from purchase_intents i
           where i.product_id = p.id and i.buyer_id is not null
         ) as buyer_ids,
         array(
           select distinct participant.user_id
           from messages m
           cross join lateral (values (m.sender_id), (m.recipient_id)) participant(user_id)
           where m.product_id = p.id and participant.user_id <> p.seller_id
         ) as message_user_ids
       from products p
       where p.id = $1`,
      [productId]
    );
    if (!participantPreview.rows[0]) throw new AppError(404, '商品不存在或已被删除');
    const preview = participantPreview.rows[0];
    const participants = await lockInteractionUsers(client, [
      adminId,
      preview.seller_id,
      ...(preview.buyer_ids || []),
      ...(preview.message_user_ids || [])
    ]);
    const admin = participants.get(String(adminId));
    if (!admin || admin.is_disabled || !admin.is_admin) throw new AppError(403, '仅管理员可处理商品');
    const productResult = await client.query(
      `select p.*, seller.name as seller_name
       from products p join users seller on seller.id = p.seller_id
       where p.id = $1 for update of p`,
      [productId]
    );
    const product = productResult.rows[0];
    if (!product) throw new AppError(404, '商品不存在或已被删除');

    const previousStatus = product.moderation_status === 'down' ? 'platform_down' : product.status;
    let nextStatus = previousStatus;
    let activeIntents = { rows: [] };
    let auditAction;

    if (action === 'down') {
      if (product.moderation_status === 'down') throw new AppError(409, '商品已经由平台下架');
      if (product.status === 'sold') throw new AppError(409, '已售商品不在公开列表，如确认违规可直接永久删除');
      activeIntents = await client.query(
        `update purchase_intents set status = 'canceled', updated_at = now()
         where product_id = $1 and status in ('pending', 'accepted')
         returning buyer_id`,
        [productId]
      );
      await client.query(
        `update products set moderation_status = 'down', moderation_reason = $2,
           moderated_by = $3, moderated_at = now(),
           status = case when status = 'trading' then 'available' else status end,
           buyer_id = null, updated_at = now()
         where id = $1`,
        [productId, reason, adminId]
      );
      nextStatus = 'platform_down';
      auditAction = 'down_product';
    } else if (action === 'restore') {
      if (product.moderation_status !== 'down') throw new AppError(409, '只有平台下架的商品可以解除处置');
      nextStatus = product.status;
      await client.query(
        `update products set moderation_status = 'clear', moderation_reason = null,
           moderated_by = $2, moderated_at = now(), updated_at = now()
         where id = $1`,
        [productId, adminId]
      );
      auditAction = 'restore_product';
    } else {
      activeIntents = await client.query(
        `update purchase_intents set status = 'canceled', updated_at = now()
         where product_id = $1 and status in ('pending', 'accepted')
         returning buyer_id`,
        [productId]
      );
      nextStatus = null;
      auditAction = 'delete_product';
    }

    await client.query(
      `insert into admin_content_audit_log
        (admin_id, target_type, target_id, target_title, target_owner_id,
         action, previous_status, next_status, reason)
       values ($1, 'product', $2, $3, $4, $5, $6, $7, $8)`,
      [adminId, product.id, product.title, product.seller_id, auditAction, previousStatus, nextStatus, reason]
    );

    const actionCopy = action === 'down'
      ? { title: '商品已被管理员下架', body: `“${product.title}”因平台审核已下架。处理原因：${reason}` }
      : action === 'restore'
        ? {
            title: product.status === 'down' ? '商品的平台处置已解除' : '商品已恢复展示',
            body: product.status === 'down'
              ? `“${product.title}”的平台处置已解除；该商品仍保持你此前的下架状态。复核说明：${reason}`
              : `“${product.title}”经复核已恢复展示。处理说明：${reason}`
          }
        : { title: '商品已被管理员删除', body: `“${product.title}”因违规已被永久删除。处理原因：${reason}` };
    await insertNotification(client, {
      userId: product.seller_id,
      type: `admin_product_${action}`,
      title: actionCopy.title,
      body: actionCopy.body,
      entityType: 'product',
      entityId: product.id
    });

    if (action !== 'restore') {
      const affectedUsers = new Set([
        ...(preview.buyer_ids || []),
        ...(preview.message_user_ids || [])
      ].map(String));
      affectedUsers.delete(String(product.seller_id));
      for (const buyerId of affectedUsers) {
        await insertNotification(client, {
          userId: buyerId,
          type: 'admin_product_unavailable',
          title: '相关商品已停止交易',
          body: `“${product.title}”已由平台${action === 'delete' ? '删除' : '下架'}，对应咨询和交易已关闭。`,
          entityType: 'product',
          entityId: product.id
        });
      }
    }

    if (action === 'delete') {
      await client.query('delete from products where id = $1', [productId]);
    }

    return {
      id: product.id,
      title: product.title,
      sellerId: String(product.seller_id),
      action,
      status: action === 'down' ? 'down' : nextStatus,
      moderationStatus: action === 'down' ? 'down' : 'clear',
      deleted: action === 'delete'
    };
  });
}

async function getBootstrap(userId = null) {
  await expireOpenTasks();
  const usersPromise = query('select id, name, campus from users where not is_disabled order by created_at');
  const productsPromise = userId
    ? query(
        `select p.*, u.name as seller_name,
           (select count(*) from purchase_intents i
            where i.product_id = p.id and i.status in ('pending', 'accepted'))::int as interest_count
         from products p join users u on u.id = p.seller_id and not u.is_disabled
         where p.seller_id = $1
            or (p.moderation_status = 'clear' and (p.status in ('available', 'trading') or p.buyer_id = $1))
         order by p.created_at desc`,
        [userId]
      )
    : query(
        `select p.*, u.name as seller_name,
           (select count(*) from purchase_intents i
            where i.product_id = p.id and i.status in ('pending', 'accepted'))::int as interest_count
         from products p join users u on u.id = p.seller_id and not u.is_disabled
         where p.moderation_status = 'clear' and p.status in ('available', 'trading')
         order by p.created_at desc`
      );
  const tasksPromise = userId
    ? query(
        `select t.* from tasks t
         join users publisher on publisher.id = t.publisher_id and not publisher.is_disabled
         where t.status in ('open', 'in_progress') or t.publisher_id = $1 or t.taker_id = $1
         order by t.created_at desc`,
        [userId]
      )
    : query(
        `select t.* from tasks t
         join users publisher on publisher.id = t.publisher_id and not publisher.is_disabled
         where t.status in ('open', 'in_progress')
         order by t.created_at desc`
      );
  const intentsPromise = userId
    ? query(
        `select i.* from purchase_intents i
         join products p on p.id = i.product_id
         join users buyer on buyer.id = i.buyer_id and not buyer.is_disabled
         where i.buyer_id = $1 or p.seller_id = $1
         order by i.created_at`,
        [userId]
      )
    : Promise.resolve({ rows: [] });
  const messagesPromise = userId
    ? query(
        `select m.* from messages m
         join users sender on sender.id = m.sender_id and not sender.is_disabled
         join users recipient on recipient.id = m.recipient_id and not recipient.is_disabled
         where m.sender_id = $1 or m.recipient_id = $1
         order by m.created_at`,
        [userId]
      )
    : Promise.resolve({ rows: [] });
  const applicationsPromise = userId
    ? query(
        `select a.*, u.name as applicant_name
         from task_applications a
         join tasks t on t.id = a.task_id
         join users u on u.id = a.applicant_id and not u.is_disabled
         join users publisher on publisher.id = t.publisher_id and not publisher.is_disabled
         where a.applicant_id = $1 or t.publisher_id = $1
         order by a.created_at desc`,
        [userId]
      )
    : Promise.resolve({ rows: [] });
  const notificationsPromise = userId
    ? query(
        `select * from notifications where user_id = $1
         order by created_at desc limit 100`,
        [userId]
      )
    : Promise.resolve({ rows: [] });
  const blockRelationsPromise = userId
    ? query(
        `select b.*, u.name as blocked_name
         from user_blocks b join users u on u.id = b.blocked_id
         where b.blocker_id = $1 or b.blocked_id = $1`,
        [userId]
      )
    : Promise.resolve({ rows: [] });

  const [users, products, tasks, intents, messages, applications, notifications, blockRelations] = await Promise.all([
    usersPromise,
    productsPromise,
    tasksPromise,
    intentsPromise,
    messagesPromise,
    applicationsPromise,
    notificationsPromise,
    blockRelationsPromise
  ]);

  const blockedIds = new Set();
  if (userId) {
    blockRelations.rows.forEach((row) => {
      const counterpart = String(row.blocker_id) === String(userId) ? row.blocked_id : row.blocker_id;
      blockedIds.add(String(counterpart));
    });
  }
  const visibleProducts = products.rows.map(productFromRow).filter((product) =>
    !blockedIds.has(product.sellerId) || product.sellerId === String(userId)
  );
  const visibleProductIds = new Set(visibleProducts.map((product) => product.id));
  const visibleTasks = tasks.rows.map(taskFromRow).filter((task) =>
    !blockedIds.has(task.publisherId) || task.publisherId === String(userId)
  );
  const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));

  return {
    users: Object.fromEntries(users.rows
      .filter((row) => !blockedIds.has(String(row.id)))
      .map((row) => [String(row.id), publicUser(row)])),
    products: visibleProducts,
    tasks: visibleTasks,
    taskApplications: applications.rows.map(taskApplicationFromRow)
      .filter((application) => visibleTaskIds.has(application.taskId) && !blockedIds.has(application.applicantId)),
    notifications: notifications.rows.map(notificationFromRow),
    blocks: blockRelations.rows
      .filter((row) => String(row.blocker_id) === String(userId))
      .map(blockFromRow),
    intents: intents.rows.map(intentFromRow).filter((intent) =>
      visibleProductIds.has(intent.productId) && !blockedIds.has(intent.buyerId)
    ),
    chats: messages.rows.map(messageFromRow).filter((message) => {
      const peerId = message.from === String(userId) ? message.to : message.from;
      return visibleProductIds.has(message.productId) && !blockedIds.has(peerId);
    })
  };
}

async function createProduct(userId, input, requestId) {
  const id = `p_${randomUUID()}`;
  const result = await query(
    `insert into products
      (id, title, category, item_condition, campus, campus_text, price, location, description,
       seller_id, image_url, image_class, symbol, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (seller_id, request_id) where request_id is not null
     do update set request_id = excluded.request_id
     returning *, (select name from users where id = seller_id) as seller_name`,
    [
      id,
      input.title,
      input.category,
      input.condition,
      input.campus,
      input.campusText,
      input.price,
      input.location,
      input.desc,
      userId,
      input.image || null,
      input.imgClass || null,
      input.symbol || null,
      requestId
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
     where id = $1 and seller_id = $2 and moderation_status = 'clear'
       and status not in ('trading', 'sold')
     returning *, (select name from users where id = seller_id) as seller_name`,
    [productId, userId, status]
  );
  if (!result.rows[0]) throw new AppError(403, '无权修改该商品；平台下架或交易中的商品不能自行变更');
  return productFromRow(result.rows[0]);
}

async function deleteProduct(userId, productId) {
  const result = await query(
    `delete from products
     where id = $1 and seller_id = $2 and moderation_status = 'clear'
       and status not in ('trading', 'sold')
     returning id`,
    [productId, userId]
  );
  if (!result.rows[0]) throw new AppError(403, '无权删除该商品；平台下架或交易中的商品不能自行删除');
}

async function createTask(userId, input, requestId) {
  const id = `t_${randomUUID()}`;
  const result = await query(
    `insert into tasks
      (id, title, task_type, campus, campus_text, reward, location, description,
       deadline_at, estimated_minutes, publisher_id, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (publisher_id, request_id) where request_id is not null
     do update set request_id = excluded.request_id
     returning *`,
    [
      id,
      input.title,
      input.taskType,
      input.campus,
      input.campusText,
      input.reward,
      input.location,
      input.desc,
      input.deadlineAt,
      input.estimatedMinutes,
      userId,
      requestId
    ]
  );
  return taskFromRow(result.rows[0]);
}

async function insertNotification(client, input) {
  const result = await client.query(
    `insert into notifications
      (id, user_id, type, title, body, entity_type, entity_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      `n_${randomUUID()}`,
      input.userId,
      input.type,
      input.title,
      input.body,
      input.entityType || null,
      input.entityId || null
    ]
  );
  return notificationFromRow(result.rows[0]);
}

async function usersAreBlocked(client, firstUserId, secondUserId) {
  const result = await client.query(
    `select 1 from user_blocks
     where (blocker_id = $1 and blocked_id = $2)
        or (blocker_id = $2 and blocked_id = $1)
     limit 1`,
    [firstUserId, secondUserId]
  );
  return Boolean(result.rows[0]);
}

async function lockInteractionUsers(client, userIds) {
  const ids = [...new Set(userIds.map(String))];
  const result = await client.query(
    `select id, is_admin, is_disabled, email_verified_at
     from users where id = any($1::uuid[])
     order by id for update`,
    [ids]
  );
  return new Map(result.rows.map((row) => [String(row.id), row]));
}

async function applyToTask(userId, taskId) {
  await expireOpenTasks();
  return transaction(async (client) => {
    const ownerPreview = await client.query('select publisher_id from tasks where id = $1', [taskId]);
    if (!ownerPreview.rows[0]) throw new AppError(404, '任务不存在');
    const publisherId = String(ownerPreview.rows[0].publisher_id);
    const participants = await lockInteractionUsers(client, [userId, publisherId]);
    const actor = participants.get(String(userId));
    const publisher = participants.get(publisherId);
    if (!actor || actor.is_disabled) throw new AppError(403, '账号已停用，无法申请任务');
    if (!actor.email_verified_at) throw new AppError(403, '请先完成校园身份认证');
    if (!publisher || publisher.is_disabled) throw new AppError(409, '任务发布者账号已停用');
    const taskResult = await client.query(
      'select * from tasks where id = $1 for update',
      [taskId]
    );
    const task = taskResult.rows[0];
    if (!task) throw new AppError(404, '任务不存在');
    if (task.status === 'expired') throw new AppError(409, '任务已过期，请刷新页面');
    if (task.status !== 'open') throw new AppError(409, '任务当前不接受新的接单申请');
    if (String(task.publisher_id) === String(userId)) throw new AppError(400, '不能申请自己发布的任务');
    if (await usersAreBlocked(client, userId, task.publisher_id)) {
      throw new AppError(403, '你与任务发布者之间存在屏蔽关系，无法申请');
    }

    let application;
    try {
      const inserted = await client.query(
        `insert into task_applications (id, task_id, applicant_id)
         values ($1, $2, $3)
         returning *, (select name from users where id = applicant_id) as applicant_name`,
        [`ta_${randomUUID()}`, taskId, userId]
      );
      application = inserted.rows[0];
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, '你已经申请过这个任务');
      throw error;
    }

    await insertNotification(client, {
      userId: task.publisher_id,
      type: 'task_application',
      title: '收到新的接单申请',
      body: `“${task.title}”收到一份接单申请，请在“我的互助任务”中确认或拒绝。`,
      entityType: 'task',
      entityId: task.id
    });
    return { task: taskFromRow(task), application: taskApplicationFromRow(application) };
  });
}

async function manageTaskApplication(userId, applicationId, action) {
  if (!['accept', 'reject', 'withdraw'].includes(action)) {
    throw new AppError(400, '接单申请操作不合法');
  }
  await expireOpenTasks();
  return transaction(async (client) => {
    const result = await client.query(
      `select a.*, t.publisher_id, t.status as task_status, t.deadline_at,
         t.title as task_title, t.taker_id, u.name as applicant_name,
         u.is_disabled as applicant_disabled
       from task_applications a
       join tasks t on t.id = a.task_id
       join users u on u.id = a.applicant_id
       where a.id = $1
       for update of a, t, u`,
      [applicationId]
    );
    const application = result.rows[0];
    if (!application) throw new AppError(404, '接单申请不存在');
    if (application.status !== 'pending') throw new AppError(409, '这份接单申请已经处理');

    if (action === 'withdraw') {
      if (String(application.applicant_id) !== String(userId)) {
        throw new AppError(403, '只能撤回自己的接单申请');
      }
      const updated = await client.query(
        `update task_applications set status = 'withdrawn' where id = $1
         returning *, $2::text as applicant_name`,
        [application.id, application.applicant_name]
      );
      await insertNotification(client, {
        userId: application.publisher_id,
        type: 'task_application_withdrawn',
        title: '接单申请已撤回',
        body: `“${application.task_title}”的一位申请者已撤回申请。`,
        entityType: 'task',
        entityId: application.task_id
      });
      return { application: taskApplicationFromRow(updated.rows[0]) };
    }

    if (String(application.publisher_id) !== String(userId)) {
      throw new AppError(403, '只有任务发布者可以处理接单申请');
    }
    if (action === 'reject') {
      const updated = await client.query(
        `update task_applications set status = 'rejected' where id = $1
         returning *, $2::text as applicant_name`,
        [application.id, application.applicant_name]
      );
      await insertNotification(client, {
        userId: application.applicant_id,
        type: 'task_application_rejected',
        title: '接单申请未被选择',
        body: `发布者没有选择你完成“${application.task_title}”，你可以继续查看其他互助任务。`,
        entityType: 'task',
        entityId: application.task_id
      });
      return { application: taskApplicationFromRow(updated.rows[0]) };
    }

    if (application.task_status !== 'open') throw new AppError(409, '任务已不再接受申请');
    if (application.applicant_disabled) throw new AppError(409, '申请者账号已停用，不能确认该申请');
    if (new Date(application.deadline_at).getTime() <= Date.now()) {
      throw new AppError(409, '任务已到截止时间，不能再确认接单者');
    }
    if (await usersAreBlocked(client, application.publisher_id, application.applicant_id)) {
      throw new AppError(403, '你与申请者之间存在屏蔽关系，不能确认该申请');
    }

    const accepted = await client.query(
      `update task_applications set status = 'accepted' where id = $1
       returning *, $2::text as applicant_name`,
      [application.id, application.applicant_name]
    );
    const rejected = await client.query(
      `update task_applications set status = 'rejected'
       where task_id = $1 and id <> $2 and status = 'pending'
       returning applicant_id`,
      [application.task_id, application.id]
    );
    const taskUpdated = await client.query(
      `update tasks set status = 'in_progress', taker_id = $2 where id = $1 returning *`,
      [application.task_id, application.applicant_id]
    );
    await insertNotification(client, {
      userId: application.applicant_id,
      type: 'task_application_accepted',
      title: '接单申请已通过',
      body: `发布者已选择你完成“${application.task_title}”，请按任务说明及时完成。`,
      entityType: 'task',
      entityId: application.task_id
    });
    for (const row of rejected.rows) {
      await insertNotification(client, {
        userId: row.applicant_id,
        type: 'task_application_rejected',
        title: '任务已选择其他同学',
        body: `“${application.task_title}”已由其他同学接单。`,
        entityType: 'task',
        entityId: application.task_id
      });
    }
    return {
      task: taskFromRow(taskUpdated.rows[0]),
      application: taskApplicationFromRow(accepted.rows[0])
    };
  });
}

async function expireOpenTasks() {
  await transaction(async (client) => {
    const expired = await client.query(
      `update tasks
       set status = 'expired', updated_at = now()
       where status = 'open' and deadline_at is not null and deadline_at <= now()
      returning id, title, publisher_id`
    );
    for (const task of expired.rows) {
      await insertNotification(client, {
        userId: task.publisher_id,
        type: 'task_expired_publisher',
        title: '互助任务已自动过期',
        body: `“${task.title}”已到截止时间，平台已停止接收和处理新的接单申请。`,
        entityType: 'task',
        entityId: task.id
      });
      const applications = await client.query(
        `update task_applications set status = 'rejected'
         where task_id = $1 and status = 'pending'
         returning applicant_id`,
        [task.id]
      );
      for (const application of applications.rows) {
        await insertNotification(client, {
          userId: application.applicant_id,
          type: 'task_expired',
          title: '互助任务已过期',
          body: `“${task.title}”到截止时间仍未确认接单者，申请已自动结束。`,
          entityType: 'task',
          entityId: task.id
        });
      }
    }
  });
}

async function updateTask(userId, taskId, action) {
  if (action === 'take') return applyToTask(userId, taskId);
  await expireOpenTasks();
  return transaction(async (client) => {
    const current = await client.query('select * from tasks where id = $1 for update', [taskId]);
    const task = current.rows[0];
    if (!task) throw new AppError(404, '任务不存在');

    if (action === 'done') {
      if (String(task.publisher_id) !== userId || task.status !== 'in_progress') {
        throw new AppError(403, '只有发布者可以确认完成');
      }
      task.status = 'done';
      if (task.taker_id) {
        await insertNotification(client, {
          userId: task.taker_id,
          type: 'task_completed',
          title: '互助任务已确认完成',
          body: `发布者已确认“${task.title}”完成，感谢你的帮助。`,
          entityType: 'task',
          entityId: task.id
        });
      }
    } else if (action === 'cancel') {
      if (String(task.publisher_id) !== userId || task.status === 'done') {
        throw new AppError(403, '只有发布者可以取消任务');
      }
      task.status = 'cancelled';
      const affected = await client.query(
        `update task_applications set status = 'rejected'
         where task_id = $1 and status = 'pending'
         returning applicant_id`,
        [task.id]
      );
      const recipients = new Set(affected.rows.map((row) => String(row.applicant_id)));
      if (task.taker_id) recipients.add(String(task.taker_id));
      for (const recipientId of recipients) {
        await insertNotification(client, {
          userId: recipientId,
          type: 'task_cancelled',
          title: '互助任务已取消',
          body: `发布者取消了“${task.title}”。`,
          entityType: 'task',
          entityId: task.id
        });
      }
    } else if (action === 'withdraw') {
      if (String(task.taker_id) !== userId || task.status !== 'in_progress') {
        throw new AppError(403, '只有当前接单者可以放弃接单');
      }
      if (task.deadline_at && new Date(task.deadline_at).getTime() <= Date.now()) {
        throw new AppError(409, '任务已到截止时间，无法重新开放，请联系发布者处理');
      }
      task.status = 'open';
      task.taker_id = null;
      await client.query(
        `update task_applications set status = 'withdrawn'
         where task_id = $1 and applicant_id = $2 and status = 'accepted'`,
        [task.id, userId]
      );
      await insertNotification(client, {
        userId: task.publisher_id,
        type: 'task_taker_withdrawn',
        title: '接单者已放弃任务',
        body: `“${task.title}”已重新开放，其他同学可以再次申请。`,
        entityType: 'task',
        entityId: task.id
      });
    } else {
      throw new AppError(400, '任务操作不合法');
    }

    const updated = await client.query(
      'update tasks set status = $2, taker_id = $3, updated_at = now() where id = $1 returning *',
      [taskId, task.status, task.taker_id]
    );
    return taskFromRow(updated.rows[0]);
  });
}

async function markNotificationsRead(userId, notificationId = 'all') {
  const result = notificationId === 'all'
    ? await query(
        `update notifications set is_read = true
         where user_id = $1 and not is_read returning id`,
        [userId]
      )
    : await query(
        `update notifications set is_read = true
         where id = $1 and user_id = $2 returning id`,
        [notificationId, userId]
      );
  return result.rowCount;
}

async function blockUser(userId, targetUserId) {
  if (String(userId) === String(targetUserId)) throw new AppError(400, '不能屏蔽自己');
  return transaction(async (client) => {
    const target = await client.query('select id, name from users where id = $1', [targetUserId]);
    if (!target.rows[0]) throw new AppError(404, '用户不存在');
    await client.query(
      `insert into user_blocks (blocker_id, blocked_id)
       values ($1, $2) on conflict do nothing`,
      [userId, targetUserId]
    );
    return { userId: String(targetUserId), name: target.rows[0].name };
  });
}

async function unblockUser(userId, targetUserId) {
  await query(
    'delete from user_blocks where blocker_id = $1 and blocked_id = $2',
    [userId, targetUserId]
  );
}

async function resolveReportTarget(client, targetType, targetId) {
  if (targetType === 'product') {
    const result = await client.query(
      'select seller_id as owner_id, title from products where id = $1',
      [targetId]
    );
    return result.rows[0] || null;
  }
  if (targetType === 'task') {
    const result = await client.query(
      'select publisher_id as owner_id, title from tasks where id = $1',
      [targetId]
    );
    return result.rows[0] || null;
  }
  if (targetType === 'user') {
    const result = await client.query(
      'select id as owner_id, name as title from users where id::text = $1',
      [targetId]
    );
    return result.rows[0] || null;
  }
  return null;
}

async function createReport(userId, input) {
  return transaction(async (client) => {
    const target = await resolveReportTarget(client, input.targetType, input.targetId);
    if (!target) throw new AppError(404, '举报对象不存在');
    if (String(target.owner_id) === String(userId)) throw new AppError(400, '不能举报自己发布的内容');
    try {
      const result = await client.query(
        `insert into reports
          (id, reporter_id, target_type, target_id, reason, description)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [`r_${randomUUID()}`, userId, input.targetType, input.targetId, input.reason, input.description]
      );
      return reportFromRow({
        ...result.rows[0],
        target_title: target.title,
        target_owner_id: target.owner_id
      });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, '你已经举报过该对象，管理员正在处理');
      throw error;
    }
  });
}

async function getAdminReports(status = 'pending') {
  const result = await query(
    `select r.*, reporter.name as reporter_name,
       coalesce(p.title, t.title, target_user.name, r.target_id) as target_title,
       coalesce(p.seller_id, t.publisher_id, target_user.id) as target_owner_id
     from reports r
     join users reporter on reporter.id = r.reporter_id
     left join products p on r.target_type = 'product' and p.id = r.target_id
     left join tasks t on r.target_type = 'task' and t.id = r.target_id
     left join users target_user on r.target_type = 'user' and target_user.id::text = r.target_id
     where ($1 = 'all' or r.status = $1)
     order by case when r.status in ('pending', 'reviewing') then 0 else 1 end,
       r.created_at desc
     limit 200`,
    [status]
  );
  return result.rows.map(reportFromRow);
}

async function manageReport(adminId, reportId, action, resolution = '') {
  if (!['resolve', 'dismiss', 'disable_target'].includes(action)) {
    throw new AppError(400, '举报处理操作不合法');
  }
  return transaction(async (client) => {
    const reportResult = await client.query('select * from reports where id = $1 for update', [reportId]);
    const report = reportResult.rows[0];
    if (!report) throw new AppError(404, '举报记录不存在');
    if (!['pending', 'reviewing'].includes(report.status)) throw new AppError(409, '这条举报已经处理');
    const target = await resolveReportTarget(client, report.target_type, report.target_id);
    const targetUserId = target?.owner_id || null;
    let nextStatus = action === 'dismiss' ? 'dismissed' : 'resolved';
    let nextResolution = resolution || (action === 'dismiss' ? '核查后未发现违规' : '管理员已完成核查处理');
    let auditAction = action === 'dismiss' ? 'dismiss_report' : 'resolve_report';

    if (action === 'disable_target') {
      if (!targetUserId) throw new AppError(404, '无法定位被举报内容的发布者');
      const targetUser = await client.query('select is_admin from users where id = $1', [targetUserId]);
      if (!targetUser.rows[0]) throw new AppError(404, '被举报用户不存在');
      if (targetUser.rows[0].is_admin) throw new AppError(400, '不能通过举报流程停用管理员');
      await client.query('update users set is_disabled = true where id = $1', [targetUserId]);
      await client.query('delete from sessions where user_id = $1', [targetUserId]);
      await moderateUserContent(client, targetUserId);
      nextResolution = resolution || '违规成立，相关账号已停用';
      auditAction = 'ban_from_report';
    }

    const updated = await client.query(
      `update reports
       set status = $2, resolution = $3, handled_by = $4, handled_at = now()
       where id = $1 returning *`,
      [reportId, nextStatus, nextResolution, adminId]
    );
    await client.query(
      `insert into admin_audit_log (admin_id, target_user_id, action)
       values ($1, $2, $3)`,
      [adminId, targetUserId, auditAction]
    );
    await insertNotification(client, {
      userId: report.reporter_id,
      type: 'report_resolved',
      title: action === 'dismiss' ? '举报已完成核查' : '举报已处理',
      body: nextResolution,
      entityType: 'report',
      entityId: report.id
    });
    return reportFromRow({
      ...updated.rows[0],
      target_title: target?.title || report.target_id,
      target_owner_id: targetUserId
    });
  });
}

async function createIntent(userId, productId) {
  return transaction(async (client) => {
    const ownerPreview = await client.query('select seller_id from products where id = $1', [productId]);
    if (!ownerPreview.rows[0]) throw new AppError(404, '商品不存在');
    const sellerId = String(ownerPreview.rows[0].seller_id);
    const participants = await lockInteractionUsers(client, [userId, sellerId]);
    const actor = participants.get(String(userId));
    const seller = participants.get(sellerId);
    if (!actor || actor.is_disabled) throw new AppError(403, '账号已停用，无法发起交易');
    if (!actor.email_verified_at) throw new AppError(403, '请先完成校园身份认证');
    if (!seller || seller.is_disabled) throw new AppError(409, '卖家账号已停用');
    const productResult = await client.query(
      'select * from products where id = $1 for update',
      [productId]
    );
    const product = productResult.rows[0];
    if (!product) throw new AppError(404, '商品不存在');
    if (product.moderation_status !== 'clear' || product.status !== 'available') {
      throw new AppError(409, '商品当前不可咨询');
    }
    if (String(product.seller_id) === userId) throw new AppError(400, '不能购买自己的商品');
    if (await usersAreBlocked(client, userId, product.seller_id)) {
      throw new AppError(403, '你与卖家之间存在屏蔽关系，无法发起交易');
    }

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
    const previewResult = await client.query(
      `select i.buyer_id, p.seller_id
       from purchase_intents i join products p on p.id = i.product_id
       where i.id = $1`,
      [intentId]
    );
    const preview = previewResult.rows[0];
    if (!preview) throw new AppError(404, '购买意向不存在');
    const participants = await lockInteractionUsers(client, [userId, preview.seller_id, preview.buyer_id]);
    const actor = participants.get(String(userId));
    const buyer = participants.get(String(preview.buyer_id));
    if (!actor || actor.is_disabled) throw new AppError(403, '账号已停用，无法处理购买意向');
    const result = await client.query(
      `select i.*, p.seller_id, p.status as product_status,
         p.moderation_status as product_moderation_status
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
    if (!buyer || buyer.is_disabled) throw new AppError(409, '买家账号已停用，不能接受该意向');
    if (await usersAreBlocked(client, intent.seller_id, intent.buyer_id)) {
      throw new AppError(403, '你与买家之间存在屏蔽关系，不能接受该意向');
    }
    if (intent.product_moderation_status !== 'clear' || intent.product_status !== 'available') {
      throw new AppError(409, '商品已经不处于可交易状态');
    }

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
    if (product.moderation_status !== 'clear') throw new AppError(409, '商品已被平台下架，不能继续交易');
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
      `update products set status = $2::varchar, buyer_id = case when $2::varchar = 'available' then null else buyer_id end
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
    const ownerPreview = await client.query('select seller_id from products where id = $1', [input.productId]);
    if (!ownerPreview.rows[0]) throw new AppError(404, '商品不存在');
    const sellerId = String(ownerPreview.rows[0].seller_id);
    const participants = await lockInteractionUsers(client, [userId, input.peerId, sellerId]);
    const actor = participants.get(String(userId));
    const peer = participants.get(String(input.peerId));
    if (!actor || actor.is_disabled) throw new AppError(403, '账号已停用，无法发送消息');
    if (!actor.email_verified_at) throw new AppError(403, '请先完成校园身份认证');
    if (!peer || peer.is_disabled) throw new AppError(409, '对方账号已停用');
    const access = await client.query(
      `select p.seller_id, p.status as product_status,
         p.moderation_status as product_moderation_status, i.buyer_id
       from products p
       left join purchase_intents i
         on i.product_id = p.id and i.buyer_id in ($2, $3)
         and i.status in ('pending', 'accepted', 'sold')
       where p.id = $1 for update of p`,
      [input.productId, userId, input.peerId]
    );
    const row = access.rows[0];
    if (!row) throw new AppError(404, '商品不存在');
    const buyerId = row.buyer_id ? String(row.buyer_id) : null;
    const allowed =
      (userId === sellerId && input.peerId === buyerId) ||
      (userId === buyerId && input.peerId === sellerId);
    if (!allowed) throw new AppError(403, '无权在该会话中发送消息');
    if (row.product_moderation_status !== 'clear' || row.product_status === 'down') {
      throw new AppError(409, '商品已下架，当前会话已关闭');
    }
    if (await usersAreBlocked(client, userId, input.peerId)) {
      throw new AppError(403, '你与对方之间存在屏蔽关系，无法发送消息');
    }

    const result = await client.query(
      `insert into messages (id, product_id, sender_id, recipient_id, body, request_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (sender_id, request_id) where request_id is not null
       do update set request_id = excluded.request_id
       returning *`,
      [`m_${randomUUID()}`, input.productId, userId, input.peerId, input.text, input.requestId]
    );
    return messageFromRow(result.rows[0]);
  });
}

async function getMessagesSince(userId, afterCursor = 0, limit = 100) {
  const rawCursor = String(afterCursor || '');
  const separator = rawCursor.lastIndexOf('|');
  const suppliedTime = separator >= 0 ? rawCursor.slice(0, separator) : '';
  const suppliedId = separator >= 0 ? rawCursor.slice(separator + 1) : '';
  const cursorTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(suppliedTime)
    ? suppliedTime
    : '1970-01-01T00:00:00.000000Z';
  const cursorId = /^[A-Za-z0-9_-]{0,120}$/.test(suppliedId) ? suppliedId : '';
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const result = await query(
    `select m.*,
       to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time
     from messages m
     join products p on p.id = m.product_id
     join users sender on sender.id = m.sender_id and not sender.is_disabled
     join users recipient on recipient.id = m.recipient_id and not recipient.is_disabled
     where (m.sender_id = $1 or m.recipient_id = $1)
       and (m.created_at > $2::timestamptz or (m.created_at = $2::timestamptz and m.id > $3))
       and (p.seller_id = $1 or (
         p.moderation_status = 'clear'
         and (p.status in ('available', 'trading') or p.buyer_id = $1)
       ))
       and not exists (
         select 1 from user_blocks b
         where (b.blocker_id = $1 and b.blocked_id in (m.sender_id, m.recipient_id))
            or (b.blocked_id = $1 and b.blocker_id in (m.sender_id, m.recipient_id))
     )
     order by m.created_at, m.id
     limit $4`,
    [userId, cursorTime, cursorId, pageSize + 1]
  );
  const messages = result.rows.slice(0, pageSize).map(messageFromRow);
  return {
    messages,
    hasMore: result.rows.length > pageSize,
    nextCursor: messages.at(-1)?.cursor || rawCursor
  };
}

function adminProductFromRow(row) {
  return {
    ...productFromRow(row),
    sellerStudentId: row.seller_student_id,
    activeIntentCount: Number(row.active_intent_count || 0),
    messageCount: Number(row.message_count || 0),
    lastModerationAction: row.last_moderation_action || '',
    lastModerationReason: row.last_moderation_reason || '',
    lastModeratedAt: timestamp(row.last_moderated_at)
  };
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
  recordLogin,
  updateUserProfile,
  updateSchoolEmail,
  markIdentityVerified,
  findVerifiedUserForReset,
  issueAuthToken,
  deleteAuthToken,
  consumeAuthToken,
  resetUserPassword,
  createSession,
  getSessionUser,
  deleteSession,
  getAdminOverview,
  getAdminUsers,
  getAdminProducts,
  manageAdminUser,
  manageAdminProduct,
  getBootstrap,
  createProduct,
  setProductAvailability,
  deleteProduct,
  createTask,
  applyToTask,
  manageTaskApplication,
  updateTask,
  markNotificationsRead,
  blockUser,
  unblockUser,
  createReport,
  getAdminReports,
  manageReport,
  createIntent,
  updateIntent,
  updateTrade,
  createMessage,
  getMessagesSince
};

const crypto = require('crypto');
const db = require('../database');

async function main() {
  if (!db.databaseConfigured) throw new Error('DATABASE_URL is required');
  const users = (await db.query('select id, is_admin from users order by is_admin desc, created_at limit 3')).rows;
  if (users.length < 3) throw new Error('Platform flow test requires at least three users');
  const admin = users.find((user) => user.is_admin);
  const members = users.filter((user) => !user.is_admin);
  if (!admin || members.length < 2) throw new Error('Platform flow test requires one admin and two members');

  const suffix = crypto.randomUUID();
  const taskId = `test_flow_${suffix}`;
  const blockedTaskId = `test_block_${suffix}`;
  const productId = `test_product_${suffix}`;
  const moderationProductId = `test_moderation_product_${suffix}`;
  const moderationTaskId = `test_moderation_task_${suffix}`;
  const tokenHash = crypto.createHash('sha256').update(`token:${suffix}`).digest('hex');
  const wrongTokenHash = crypto.createHash('sha256').update(`wrong:${suffix}`).digest('hex');
  const cleanupEntityIds = [taskId, blockedTaskId, productId, moderationProductId, moderationTaskId];
  let reportId = '';
  let moderationReportId = '';
  let temporaryUserId = '';

  try {
    await db.query(
      `insert into tasks
        (id, title, task_type, campus, campus_text, reward, location, description,
         deadline_at, estimated_minutes, publisher_id)
       values ($1, $2, 'pickup', 'pingleyuan', '平乐园校区', 1, '教学楼大厅',
         '自动化测试任务', now() + interval '1 day', 30, $3)`,
      [taskId, '任务申请确认测试', members[0].id]
    );
    const applied = await db.applyToTask(String(members[1].id), taskId);
    const accepted = await db.manageTaskApplication(
      String(members[0].id),
      applied.application.id,
      'accept'
    );
    if (accepted.task.status !== 'in_progress' || accepted.task.takerId !== String(members[1].id)) {
      throw new Error('Task application acceptance did not assign the applicant');
    }
    await db.updateTask(String(members[0].id), taskId, 'done');

    await db.query(
      `insert into tasks
        (id, title, task_type, campus, campus_text, reward, location, description,
         deadline_at, estimated_minutes, publisher_id)
       values ($1, $2, 'pickup', 'pingleyuan', '平乐园校区', 1, '教学楼大厅',
         '自动化测试任务', now() + interval '1 day', 30, $3)`,
      [blockedTaskId, '屏蔽权限测试', members[0].id]
    );
    await db.blockUser(String(members[1].id), String(members[0].id));
    let blockedApplyRejected = false;
    try {
      await db.applyToTask(String(members[1].id), blockedTaskId);
    } catch (error) {
      blockedApplyRejected = error.status === 403;
    }
    if (!blockedApplyRejected) throw new Error('Blocked user was still able to apply to a task');
    await db.unblockUser(String(members[1].id), String(members[0].id));

    await db.query(
      `insert into products
        (id, title, category, item_condition, campus, campus_text, price, location,
         description, seller_id)
       values ($1, '屏蔽购买意向测试', '生活用品', '全新', 'pingleyuan', '平乐园校区',
         1, '教学楼大厅', '自动化测试商品', $2)`,
      [productId, members[0].id]
    );
    const purchase = await db.createIntent(String(members[1].id), productId);
    await db.blockUser(String(members[0].id), String(members[1].id));
    const sellerBootstrap = await db.getBootstrap(String(members[0].id));
    if (sellerBootstrap.intents.some((intent) => intent.id === purchase.intent.id)) {
      throw new Error('Blocked buyer intent remained visible to the seller');
    }
    let blockedIntentRejected = false;
    try {
      await db.updateIntent(String(members[0].id), purchase.intent.id, 'accept');
    } catch (error) {
      blockedIntentRejected = error.status === 403;
    }
    if (!blockedIntentRejected) throw new Error('Seller could accept a blocked buyer intent');
    await db.unblockUser(String(members[0].id), String(members[1].id));

    const report = await db.createReport(String(members[1].id), {
      targetType: 'task',
      targetId: blockedTaskId,
      reason: 'other',
      description: '自动化测试举报，将在测试结束后删除。'
    });
    reportId = report.id;

    const tempStudentId = `2099${String(crypto.randomInt(10_000_000, 100_000_000))}`;
    const temporary = await db.query(
      `insert into users (student_id, name, campus, password_hash, school_email)
       values ($1, '治理流程测试用户', '平乐园校区', '!test', $2)
       returning id`,
      [tempStudentId, `flow-${suffix}@bjut.edu.cn`]
    );
    temporaryUserId = String(temporary.rows[0].id);
    let emailRaceRejected = false;
    try {
      await db.markIdentityVerified(temporaryUserId, 'email', `other-${suffix}@bjut.edu.cn`);
    } catch (error) {
      emailRaceRejected = error.status === 409;
    }
    if (!emailRaceRejected) throw new Error('Identity verification ignored an email change');
    await db.query(
      `insert into products
        (id, title, category, item_condition, campus, campus_text, price, location,
         description, seller_id)
       values ($1, '违规内容下架测试', '生活用品', '全新', 'pingleyuan', '平乐园校区',
         1, '教学楼大厅', '自动化测试商品', $2)`,
      [moderationProductId, temporaryUserId]
    );
    await db.query(
      `insert into tasks
        (id, title, task_type, campus, campus_text, reward, location, description,
         deadline_at, estimated_minutes, publisher_id)
       values ($1, '违规任务取消测试', 'pickup', 'pingleyuan', '平乐园校区', 1,
         '教学楼大厅', '自动化测试任务', now() + interval '1 day', 30, $2)`,
      [moderationTaskId, temporaryUserId]
    );
    const moderationReport = await db.createReport(String(members[1].id), {
      targetType: 'user',
      targetId: temporaryUserId,
      reason: 'other',
      description: '自动化测试账号封禁，将在测试结束后删除。'
    });
    moderationReportId = moderationReport.id;
    await db.manageReport(String(admin.id), moderationReportId, 'disable_target');
    const moderated = await db.query(
      `select u.is_disabled, p.status as product_status, t.status as task_status
       from users u join products p on p.seller_id = u.id
       join tasks t on t.publisher_id = u.id where u.id = $1`,
      [temporaryUserId]
    );
    const moderatedRow = moderated.rows[0];
    if (!moderatedRow?.is_disabled || moderatedRow.product_status !== 'down' || moderatedRow.task_status !== 'cancelled') {
      throw new Error('Report ban did not disable the account and remove active content');
    }

    await db.issueAuthToken({
      userId: members[1].id,
      purpose: 'verify_email',
      tokenHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });
    let wrongCodeRejected = false;
    try {
      await db.consumeAuthToken({
        userId: members[1].id,
        purpose: 'verify_email',
        tokenHash: wrongTokenHash
      });
    } catch (error) {
      wrongCodeRejected = error.status === 400;
    }
    const attempts = await db.query('select attempts from auth_tokens where token_hash = $1', [tokenHash]);
    if (!wrongCodeRejected || Number(attempts.rows[0]?.attempts) !== 1) {
      throw new Error('Auth code attempt tracking failed');
    }
    await db.consumeAuthToken({
      userId: members[1].id,
      purpose: 'verify_email',
      tokenHash
    });

    const bootstrap = await db.getBootstrap(String(members[0].id));
    if (!Array.isArray(bootstrap.taskApplications) || !Array.isArray(bootstrap.notifications)) {
      throw new Error('Bootstrap is missing task applications or notifications');
    }
    console.log(JSON.stringify({
      ok: true,
      taskApplication: 'accepted',
      blockedApply: 'rejected',
      blockedIntent: 'hidden-and-rejected',
      reportCreated: Boolean(reportId),
      reportBan: 'content-removed',
      emailRace: 'rejected',
      wrongAuthCodeAttempts: 1,
      notificationCount: bootstrap.notifications.length
    }, null, 2));
  } finally {
    await db.query('delete from reports where id = any($1)', [[reportId, moderationReportId].filter(Boolean)]);
    await db.query(
      `delete from user_blocks
       where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`,
      [members[1].id, members[0].id]
    );
    await db.query('delete from notifications where entity_id = any($1)', [[...cleanupEntityIds, moderationReportId].filter(Boolean)]);
    await db.query('delete from tasks where id = any($1)', [cleanupEntityIds]);
    await db.query('delete from products where id = any($1)', [cleanupEntityIds]);
    await db.query('delete from auth_tokens where token_hash = any($1)', [[tokenHash, wrongTokenHash]]);
    if (temporaryUserId) {
      await db.query('delete from admin_audit_log where target_user_id = $1', [temporaryUserId]);
      await db.query('delete from users where id = $1', [temporaryUserId]);
    }
  }
}

main()
  .then(() => db.pool.end())
  .catch(async (error) => {
    console.error(error);
    if (db.pool) await db.pool.end().catch(() => {});
    process.exitCode = 1;
  });

const crypto = require('crypto');
const db = require('../database');

async function main() {
  if (!db.databaseConfigured) throw new Error('DATABASE_URL is required');
  const users = (await db.query(
    `select id, is_admin from users
     where not is_disabled and (is_admin or email_verified_at is not null)
     order by is_admin desc, created_at limit 10`
  )).rows;
  if (users.length < 3) throw new Error('Platform flow test requires at least three users');
  const admin = users.find((user) => user.is_admin);
  const members = users.filter((user) => !user.is_admin);
  if (!admin || members.length < 2) throw new Error('Platform flow test requires one admin and two members');

  const suffix = crypto.randomUUID();
  const taskId = `test_flow_${suffix}`;
  const blockedTaskId = `test_block_${suffix}`;
  const productId = `test_product_${suffix}`;
  const adminProductId = `test_admin_product_${suffix}`;
  const moderationProductId = `test_moderation_product_${suffix}`;
  const moderationTaskId = `test_moderation_task_${suffix}`;
  const tokenHash = crypto.createHash('sha256').update(`token:${suffix}`).digest('hex');
  const wrongTokenHash = crypto.createHash('sha256').update(`wrong:${suffix}`).digest('hex');
  const cleanupEntityIds = [taskId, blockedTaskId, productId, adminProductId, moderationProductId, moderationTaskId];
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
    const messageRequestId = `test_message_${suffix}`;
    const messageCursor = `${new Date(Date.now() - 5_000).toISOString().replace(/Z$/, '000Z')}|`;
    const realtimeMessage = await db.createMessage(String(members[1].id), {
      productId,
      peerId: String(members[0].id),
      text: '实时消息增量同步测试',
      requestId: messageRequestId
    });
    const duplicateMessage = await db.createMessage(String(members[1].id), {
      productId,
      peerId: String(members[0].id),
      text: '实时消息增量同步测试',
      requestId: messageRequestId
    });
    if (duplicateMessage.id !== realtimeMessage.id) {
      throw new Error('Message idempotency created a duplicate message');
    }
    const incrementalMessages = await db.getMessagesSince(String(members[0].id), messageCursor, 100);
    if (!incrementalMessages.messages.some((message) => message.id === realtimeMessage.id)) {
      throw new Error('Incremental message query did not return the new message');
    }
    const pageTimestamp = new Date(Date.now() + 1_000);
    const pageMessageIds = Array.from({ length: 102 }, (_, index) =>
      `m_page_${suffix}_${String(index).padStart(3, '0')}`
    );
    await db.query(
      `insert into messages (id, product_id, sender_id, recipient_id, body, created_at)
       select id, $2, $3, $4, '复合游标分页测试', $5::timestamptz
       from unnest($1::text[]) as id`,
      [pageMessageIds, productId, members[1].id, members[0].id, pageTimestamp]
    );
    const pageStartCursor = `${pageTimestamp.toISOString().replace(/Z$/, '000Z')}|`;
    const firstPage = await db.getMessagesSince(String(members[0].id), pageStartCursor, 100);
    const secondPage = await db.getMessagesSince(String(members[0].id), firstPage.nextCursor, 100);
    const pagedIds = new Set([...firstPage.messages, ...secondPage.messages].map((message) => message.id));
    if (!firstPage.hasMore || secondPage.hasMore || pagedIds.size !== pageMessageIds.length ||
      pageMessageIds.some((messageId) => !pagedIds.has(messageId))) {
      throw new Error('Composite message cursor skipped or duplicated a pagination boundary');
    }
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
    const blockedMessages = await db.getMessagesSince(String(members[0].id), messageCursor, 100);
    if (blockedMessages.messages.some((message) => message.id === realtimeMessage.id)) {
      throw new Error('Blocked peer message remained visible in incremental sync');
    }
    await db.unblockUser(String(members[0].id), String(members[1].id));

    await db.query(
      `insert into products
        (id, title, category, item_condition, campus, campus_text, price, location,
         description, seller_id)
       values ($1, '管理员商品处置测试', '生活用品', '全新', 'pingleyuan', '平乐园校区',
         1, '教学楼大厅', '自动化测试商品', $2)`,
      [adminProductId, members[0].id]
    );
    const listedAdminProducts = await db.getAdminProducts('管理员商品处置测试', 'all');
    if (!listedAdminProducts.some((product) => product.id === adminProductId)) {
      throw new Error('Admin product list did not return the target product');
    }
    await db.manageAdminProduct(String(admin.id), adminProductId, 'down', '自动化测试违规下架');
    const downProduct = await db.query(
      'select status, moderation_status, moderation_reason from products where id = $1',
      [adminProductId]
    );
    if (downProduct.rows[0]?.status !== 'available' || downProduct.rows[0]?.moderation_status !== 'down') {
      throw new Error('Admin moderation state did not independently take down the product');
    }
    let sellerRestoreRejected = false;
    try {
      await db.setProductAvailability(String(members[0].id), adminProductId, 'available');
    } catch (error) {
      sellerRestoreRejected = error.status === 403;
    }
    let sellerDeleteRejected = false;
    try {
      await db.deleteProduct(String(members[0].id), adminProductId);
    } catch (error) {
      sellerDeleteRejected = error.status === 403;
    }
    if (!sellerRestoreRejected || !sellerDeleteRejected) {
      throw new Error('Seller could bypass an administrator product takedown');
    }
    await db.manageAdminProduct(String(admin.id), adminProductId, 'restore', '自动化测试复核恢复');
    const restoredProduct = await db.query(
      'select status, moderation_status, moderation_reason from products where id = $1',
      [adminProductId]
    );
    if (restoredProduct.rows[0]?.status !== 'available' || restoredProduct.rows[0]?.moderation_status !== 'clear' || restoredProduct.rows[0]?.moderation_reason) {
      throw new Error('Admin could not clear the independent product moderation state');
    }
    const soldIntentId = `test_admin_sold_intent_${suffix}`;
    const soldMessageId = `test_admin_sold_message_${suffix}`;
    await db.query(
      `insert into purchase_intents (id, product_id, buyer_id, status)
       values ($1, $2, $3, 'sold')`,
      [soldIntentId, adminProductId, members[1].id]
    );
    await db.query(
      `insert into messages (id, product_id, sender_id, recipient_id, body)
       values ($1, $2, $3, $4, '已售商品管理员删除通知测试')`,
      [soldMessageId, adminProductId, members[1].id, members[0].id]
    );
    await db.query(
      `update products set status = 'sold', buyer_id = $2 where id = $1`,
      [adminProductId, members[1].id]
    );
    await db.manageAdminProduct(String(admin.id), adminProductId, 'delete', '自动化测试永久删除');
    const deletedProduct = await db.query('select id from products where id = $1', [adminProductId]);
    const moderationAudit = await db.query(
      `select count(*)::int as count from admin_content_audit_log
       where target_type = 'product' and target_id = $1`,
      [adminProductId]
    );
    const soldBuyerNotification = await db.query(
      `select 1 from notifications
       where user_id = $1 and entity_id = $2 and type = 'admin_product_unavailable'`,
      [members[1].id, adminProductId]
    );
    if (deletedProduct.rowCount || moderationAudit.rows[0]?.count !== 3 || !soldBuyerNotification.rowCount) {
      throw new Error('Admin product deletion or audit logging failed');
    }

    const report = await db.createReport(String(members[1].id), {
      targetType: 'task',
      targetId: blockedTaskId,
      reason: 'other',
      description: '自动化测试举报，将在测试结束后删除。'
    });
    reportId = report.id;

    const tempStudentId = `2099${String(crypto.randomInt(10_000_000, 100_000_000))}`;
    const temporary = await db.query(
      `insert into users
        (student_id, name, campus, password_hash, school_email, email_verified_at,
         verification_method, nickname_change_required)
       values ($1, '同学0000', '平乐园校区', '!test', $2, now(), 'manual', true)
       returning id`,
      [tempStudentId, `flow-${suffix}@emails.bjut.edu.cn`]
    );
    temporaryUserId = String(temporary.rows[0].id);
    const renamedUser = await db.updateUserProfile(temporaryUserId, '小北测试员');
    if (renamedUser.name !== '小北测试员' || renamedUser.nicknameRequired) {
      throw new Error('Initial nickname setup did not persist');
    }
    let nicknameCooldownRejected = false;
    try {
      await db.updateUserProfile(temporaryUserId, '冷静期测试昵称');
    } catch (error) {
      nicknameCooldownRejected = error.status === 429 && error.code === 'nickname_change_cooldown';
    }
    if (!nicknameCooldownRejected) throw new Error('Nickname cooldown was not enforced');
    await db.manageAdminUser(String(admin.id), temporaryUserId, 'reset_nickname');
    const resetUser = await db.query(
      'select nickname_change_required from users where id = $1',
      [temporaryUserId]
    );
    if (!resetUser.rows[0]?.nickname_change_required) throw new Error('Admin nickname reset did not require onboarding');
    const resetNickname = await db.updateUserProfile(temporaryUserId, '重新设置昵称');
    if (resetNickname.name !== '重新设置昵称' || resetNickname.nicknameRequired) {
      throw new Error('Nickname could not be set after an admin reset');
    }
    let emailRaceRejected = false;
    try {
      await db.markIdentityVerified(temporaryUserId, 'email', `other-${suffix}@emails.bjut.edu.cn`);
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
      adminProductModeration: 'seller-proof-down-restored-deleted-and-audited',
      nickname: 'verified-onboarding-cooldown-and-admin-reset',
      realtimeMessage: 'incremental-idempotent-and-keyset-paginated',
      reportCreated: Boolean(reportId),
      reportBan: 'content-removed',
      emailRace: 'rejected',
      wrongAuthCodeAttempts: 1,
      notificationCount: bootstrap.notifications.length
    }, null, 2));
  } finally {
    await db.query('delete from reports where id = any($1)', [[reportId, moderationReportId].filter(Boolean)]);
    await db.query(
      `delete from admin_content_audit_log where target_type = 'product' and target_id = any($1)`,
      [[adminProductId]]
    );
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

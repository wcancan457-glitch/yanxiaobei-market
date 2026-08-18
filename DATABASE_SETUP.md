# 燕小北集市 Supabase PostgreSQL 部署说明

## 架构

浏览器只访问燕小北集市的 HTTPS API。数据库连接地址仅保存在 GitHub Actions Secret 和线上服务器的 root-only 环境文件中，绝不发送到前端。

```text
浏览器 -> HTTPS/Nginx -> Node.js -> Supabase PostgreSQL
```

聊天实时通道为同域、需登录的 `/api/events` SSE。服务端只推送事件类型和时间戳等时机信号，不在 SSE 中携带消息正文；浏览器收到信号后调用鉴权的 `/api/messages?after=<cursor>` 增量读取，数据库查询继续执行账号停用、双方屏蔽和商品可见性过滤。增量游标由 `(created_at, id)` 组成，避免多条消息时间相同时分页漏读或重复；SSE 中断时前端每 3 秒轮询，并每 30 秒重新获取完整状态以校准可见性。

## 需要人工完成的 Supabase 设置

1. 在 Supabase Dashboard 新建 `yanxiaobei-market` 项目。
2. 区域选择 `Southeast Asia (Singapore)`。
3. 保存项目数据库密码，不要提交到 Git 或聊天。
4. 在项目首页点击 `Connect`，选择 `Session pooler`，复制 owner 连接 URI，并把占位密码替换为已进行 URL 编码的数据库密码。该连接只用于迁移和备份，保存为 GitHub Actions Secret `MIGRATION_DATABASE_URL`，不要写入应用运行环境。
5. 为迁移 `009_least_privilege_app_role.sql` 创建的 `yanxiaobei_app` 准备独立强密码，并按 `.env.example` 形式生成使用该角色的 Session pooler URI，保存为 `APP_DATABASE_URL`。部署中的 `db:configure-role` 会设置角色登录密码并验证该 URI，线上服务只持久化这条受限连接为 `DATABASE_URL`。
6. 生成独立随机的 `AUTH_TOKEN_SECRET`（至少 32 字符，建议 64 字符），用于校园邮箱认证与密码重置验证码的 HMAC，不得与数据库或备份口令复用。
7. 如需邮件验证码，配置 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS` 与 `MAIL_FROM`。SMTP 未配置时管理员仍可人工认证用户，但邮箱验证码与自助找回密码不可用。
8. 生成独立的高强度备份口令并保存为 `BACKUP_PASSPHRASE`。所有 Secret 均通过 `gh secret set <名称>` 的隐藏提示录入，不要提交到 Git、文档或聊天。

GitHub Actions 需要以下 Secrets：

- 部署连接：`SERVER_HOST`、`SERVER_USERNAME`、`SERVER_PASSWORD`。
- 数据库与令牌：`MIGRATION_DATABASE_URL`、`APP_DATABASE_URL`、`AUTH_TOKEN_SECRET`。
- 可选邮件：`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`MAIL_FROM`。
- 备份：`BACKUP_PASSPHRASE`；备份工作流读取 `MIGRATION_DATABASE_URL`，不使用权限不足的应用连接。

## 自动部署会执行的动作

1. 安装 Node 依赖并运行代码检查；已配置 SMTP 时，在执行迁移与替换线上版本前验证 SMTP 连接和认证，验证失败则终止部署。
2. 使用 `MIGRATION_DATABASE_URL` 按文件名顺序执行尚未应用的迁移。`008_identity_notifications_and_moderation.sql` 增加校内邮箱认证令牌、任务申请、通知、屏蔽和举报数据结构，并只把上线前明确的三个初始账号标记为 `legacy` 认证；`009_least_privilege_app_role.sql` 创建受限应用角色、授权和 RLS policies；`010_student_email_domain.sql` 把学生邮箱后缀修正为 `@emails.bjut.edu.cn`，保留旧 `@bjut.edu.cn` 绑定的邮箱名前缀，并要求通过邮件方式认证的账号重新验证，同时清除旧地址对应的验证码与冷却记录；`011_realtime_messages.sql` 为消息增加 `request_id`、发送者范围的幂等唯一索引，以及按收发方、创建时间和消息 ID 排序的增量查询索引；`012_admin_product_moderation.sql` 为商品增加独立的 `moderation_status`、处置原因与处置人/时间，并创建永久保留的 `admin_content_audit_log` 管理员内容审计表。
3. 首次部署前复制 `auth.json`、`db.json` 到 `data/backups/pre-postgres-*`。
4. 把 JSON 用户、商品、任务、意向和聊天迁移到 PostgreSQL。
5. 创建 `data/.postgres-migrated` 标记，防止旧 JSON 在后续部署中覆盖数据库。
6. 运行 `db:configure-role` 设置并校验 `yanxiaobei_app` 登录信息，然后仅把 `APP_DATABASE_URL` 作为 `DATABASE_URL` 连同 `AUTH_TOKEN_SECRET` 和可选 `SMTP_*`/`MAIL_FROM` 写入服务器 `/etc/yanxiaobei-market.env`，文件权限为 `600`；owner 连接不落入应用环境文件。
7. 重启服务并检查 `/api/health`、`/api/bootstrap` 和公网 HTTPS。

## 最小权限数据库角色

- `MIGRATION_DATABASE_URL` 使用数据库 owner，限 GitHub 部署迁移、首次 JSON 导入和加密备份；`APP_DATABASE_URL` 使用 `yanxiaobei_app`，限 Node.js 运行时。两者必须使用不同角色和不同密码。
- `yanxiaobei_app` 仅获得业务表必需的 DML 权限与必要 sequence 权限，没有建表、建 schema、数据库管理或读取 `schema_migrations` 的权限。管理员内容审计表是收窄的例外：`admin_content_audit_log` 只授予 `SELECT` 与 `INSERT`，不授予 `UPDATE` 或 `DELETE`。
- 迁移 009 为启用 RLS 的业务表创建仅授予 `yanxiaobei_app` 的 policies。浏览器不直连数据库，用户级鉴权、认证、屏蔽和管理员授权仍由 Node API 执行；不要把应用角色 URI 暴露到前端。
- 迁移 012 为审计表分别创建运行角色专用的读取和新增 RLS policy；平台下架、解除处置和永久删除都追加审计记录，运行时角色不能覆盖或删除既有记录。

## 数据查看

- Supabase Dashboard -> Table Editor：查看各数据表。
- Supabase Dashboard -> SQL Editor：执行统计和排查查询。
- GitHub Actions -> `Backup Supabase database`：查看每周加密备份任务。

## 恢复原则

- PostgreSQL 上线前的 JSON 快照保留在服务器 `data/backups/`。
- GitHub 每周保存一份 AES-256 加密的 PostgreSQL 逻辑备份，保留 30 天。
- 解密备份需要 `BACKUP_PASSPHRASE`。遗失备份口令将无法恢复加密备份。

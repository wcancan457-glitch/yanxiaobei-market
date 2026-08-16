# 燕小北集市 Supabase PostgreSQL 部署说明

## 架构

浏览器只访问燕小北集市的 HTTPS API。数据库连接地址仅保存在 GitHub Actions Secret 和线上服务器的 root-only 环境文件中，绝不发送到前端。

```text
浏览器 -> HTTPS/Nginx -> Node.js -> Supabase PostgreSQL
```

## 需要人工完成的 Supabase 设置

1. 在 Supabase Dashboard 新建 `yanxiaobei-market` 项目。
2. 区域选择 `Southeast Asia (Singapore)`。
3. 保存项目数据库密码，不要提交到 Git 或聊天。
4. 在项目首页点击 `Connect`，选择 `Session pooler`，复制连接 URI，并把 `[YOUR-PASSWORD]` 替换为已进行 URL 编码的数据库密码。
5. 在本机项目目录运行 `gh secret set DATABASE_URL`，按隐藏提示粘贴完整 URI。
6. 生成一个独立的高强度备份口令，在本机运行 `gh secret set BACKUP_PASSPHRASE`，按隐藏提示粘贴口令。

## 自动部署会执行的动作

1. 安装 Node 依赖。
2. 执行 `db/migrations/001_initial.sql` 创建表、外键、索引和 RLS 基线。
3. 首次部署前复制 `auth.json`、`db.json` 到 `data/backups/pre-postgres-*`。
4. 把 JSON 用户、商品、任务、意向和聊天迁移到 PostgreSQL。
5. 创建 `data/.postgres-migrated` 标记，防止旧 JSON 在后续部署中覆盖数据库。
6. 将数据库地址写入服务器 `/etc/yanxiaobei-market.env`，文件权限为 `600`。
7. 重启服务并检查 `/api/health`、`/api/bootstrap` 和公网 HTTPS。

## 数据查看

- Supabase Dashboard -> Table Editor：查看各数据表。
- Supabase Dashboard -> SQL Editor：执行统计和排查查询。
- GitHub Actions -> `Backup Supabase database`：查看每周加密备份任务。

## 恢复原则

- PostgreSQL 上线前的 JSON 快照保留在服务器 `data/backups/`。
- GitHub 每周保存一份 AES-256 加密的 PostgreSQL 逻辑备份，保留 30 天。
- 解密备份需要 `BACKUP_PASSPHRASE`。遗失备份口令将无法恢复加密备份。

begin;

alter table users add column if not exists school_email text;
alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists verification_method varchar(20);
alter table users add column if not exists password_changed_at timestamptz;

alter table users drop constraint if exists users_school_email_check;
alter table users
  add constraint users_school_email_check
  check (school_email is null or lower(school_email) ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@bjut[.]edu[.]cn$');

alter table users drop constraint if exists users_verification_method_check;
alter table users
  add constraint users_verification_method_check
  check (verification_method is null or verification_method in ('email', 'manual', 'legacy'));

create unique index if not exists users_school_email_unique_idx
  on users (lower(school_email)) where school_email is not null;

-- 仅兼容上线前已经存在的三个初始账号。按明确学号回填可确保迁移重跑时
-- 不会把后来注册、仍待认证的新用户误标为 legacy。
update users
set email_verified_at = coalesce(email_verified_at, now()),
    verification_method = coalesce(verification_method, 'legacy')
where email_verified_at is null
  and student_id in ('20231234', '20239999', '202364391');

create table if not exists auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose varchar(30) not null check (purpose in ('verify_email', 'reset_password')),
  token_hash char(64) not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now()
);

create table if not exists task_applications (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  applicant_id uuid not null references users(id) on delete cascade,
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists task_applications_one_active_idx
  on task_applications (task_id, applicant_id)
  where status in ('pending', 'accepted');

create table if not exists notifications (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  type varchar(40) not null,
  title varchar(100) not null,
  body text not null check (char_length(body) between 1 and 1000),
  entity_type varchar(20) check (entity_type is null or entity_type in ('product', 'task', 'report', 'user', 'system')),
  entity_id text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists user_blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists reports (
  id text primary key,
  reporter_id uuid not null references users(id) on delete cascade,
  target_type varchar(20) not null check (target_type in ('product', 'task', 'user')),
  target_id text not null,
  reason varchar(30) not null check (reason in ('spam', 'fraud', 'prohibited', 'harassment', 'privacy', 'other')),
  description text not null check (char_length(description) between 1 and 1000),
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'reviewing', 'resolved', 'dismissed')),
  resolution text,
  handled_by uuid references users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists reports_one_pending_target_idx
  on reports (reporter_id, target_type, target_id)
  where status in ('pending', 'reviewing');

create index if not exists auth_tokens_user_purpose_idx
  on auth_tokens (user_id, purpose, created_at desc);
create index if not exists auth_tokens_expiry_idx on auth_tokens (expires_at);
create index if not exists task_applications_task_idx
  on task_applications (task_id, created_at desc);
create index if not exists task_applications_applicant_idx
  on task_applications (applicant_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on notifications (user_id, is_read, created_at desc);
create index if not exists user_blocks_blocked_idx on user_blocks (blocked_id);
create index if not exists reports_status_created_idx on reports (status, created_at desc);

drop trigger if exists task_applications_set_updated_at on task_applications;
create trigger task_applications_set_updated_at before update on task_applications
for each row execute function set_updated_at();

drop trigger if exists reports_set_updated_at on reports;
create trigger reports_set_updated_at before update on reports
for each row execute function set_updated_at();

alter table admin_audit_log drop constraint if exists admin_audit_log_action_check;
alter table admin_audit_log
  add constraint admin_audit_log_action_check
  check (action in (
    'disable', 'enable', 'force_logout', 'verify_identity',
    'resolve_report', 'dismiss_report', 'ban_from_report'
  ));

alter table auth_tokens enable row level security;
alter table task_applications enable row level security;
alter table notifications enable row level security;
alter table user_blocks enable row level security;
alter table reports enable row level security;

revoke all on table auth_tokens, task_applications, notifications, user_blocks, reports
  from anon, authenticated;

commit;

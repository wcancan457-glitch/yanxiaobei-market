begin;

alter table users add column if not exists nickname_change_required boolean not null default false;
alter table users add column if not exists nickname_updated_at timestamptz;

-- 旧版系统自动生成的“同学+学号后四位”不应成为永久公开昵称。
update users
set nickname_change_required = true,
    name = '昵称待设置'
where not is_admin
  and name ~ '^同学[0-9]{4}$';

create table if not exists nickname_change_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  changed_by_user_id uuid references users(id) on delete set null,
  previous_name varchar(30) not null,
  next_name varchar(30) not null,
  change_type varchar(20) not null
    check (change_type in ('initial', 'user_change', 'admin_reset')),
  created_at timestamptz not null default now()
);

create index if not exists nickname_change_history_user_idx
  on nickname_change_history (user_id, created_at desc);

alter table admin_audit_log drop constraint if exists admin_audit_log_action_check;
alter table admin_audit_log
  add constraint admin_audit_log_action_check
  check (action in (
    'disable', 'enable', 'force_logout', 'verify_identity', 'reset_nickname',
    'resolve_report', 'dismiss_report', 'ban_from_report'
  ));

alter table nickname_change_history enable row level security;
revoke all on table nickname_change_history from anon, authenticated;
revoke all on table nickname_change_history from yanxiaobei_app;
grant insert on table nickname_change_history to yanxiaobei_app;

drop policy if exists yanxiaobei_app_insert on nickname_change_history;
create policy yanxiaobei_app_insert on nickname_change_history
  for insert to yanxiaobei_app with check (true);

commit;

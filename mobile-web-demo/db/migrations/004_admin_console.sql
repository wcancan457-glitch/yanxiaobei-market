begin;

alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists is_disabled boolean not null default false;
alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists login_count integer not null default 0 check (login_count >= 0);

update users
set is_admin = (student_id = '202364391')
where is_admin is distinct from (student_id = '202364391');

update users u
set last_login_at = activity.last_login_at,
    login_count = greatest(u.login_count, 1)
from (
  select user_id, max(created_at) as last_login_at
  from sessions
  group by user_id
) activity
where u.id = activity.user_id and u.last_login_at is null;

create index if not exists users_last_login_idx on users(last_login_at desc);
create index if not exists users_disabled_idx on users(is_disabled, created_at desc);

create table if not exists admin_audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid references users(id) on delete set null,
  target_user_id uuid references users(id) on delete set null,
  action varchar(30) not null check (action in ('disable', 'enable', 'force_logout')),
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on admin_audit_log(created_at desc);
alter table admin_audit_log enable row level security;
revoke all on table admin_audit_log from anon, authenticated;

commit;

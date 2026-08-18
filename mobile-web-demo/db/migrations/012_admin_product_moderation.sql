begin;

alter table products add column if not exists moderation_status varchar(20) not null default 'clear';
alter table products add column if not exists moderation_reason text;
alter table products add column if not exists moderated_by uuid references users(id) on delete set null;
alter table products add column if not exists moderated_at timestamptz;

alter table products drop constraint if exists products_moderation_status_check;
alter table products
  add constraint products_moderation_status_check
  check (moderation_status in ('clear', 'down'));

alter table products drop constraint if exists products_moderation_reason_check;
alter table products
  add constraint products_moderation_reason_check
  check (moderation_reason is null or char_length(moderation_reason) between 4 and 300);

create index if not exists products_moderation_status_idx
  on products (moderation_status, status, created_at desc);

create table if not exists admin_content_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references users(id) on delete restrict,
  target_type varchar(20) not null check (target_type in ('product')),
  target_id text not null,
  target_title varchar(100) not null,
  target_owner_id uuid references users(id) on delete set null,
  action varchar(30) not null check (action in ('down_product', 'restore_product', 'delete_product')),
  previous_status varchar(20),
  next_status varchar(20),
  reason text not null check (char_length(reason) between 4 and 300),
  created_at timestamptz not null default now()
);

create index if not exists admin_content_audit_target_idx
  on admin_content_audit_log (target_type, target_id, created_at desc);

alter table admin_content_audit_log enable row level security;
revoke all on table admin_content_audit_log from anon, authenticated;
revoke all on table admin_content_audit_log from yanxiaobei_app;
grant select, insert on table admin_content_audit_log to yanxiaobei_app;

drop policy if exists yanxiaobei_app_select on admin_content_audit_log;
create policy yanxiaobei_app_select on admin_content_audit_log
  for select to yanxiaobei_app using (true);

drop policy if exists yanxiaobei_app_insert on admin_content_audit_log;
create policy yanxiaobei_app_insert on admin_content_audit_log
  for insert to yanxiaobei_app with check (true);

commit;

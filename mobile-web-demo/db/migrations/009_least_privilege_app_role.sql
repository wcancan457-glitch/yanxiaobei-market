begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'yanxiaobei_app') then
    create role yanxiaobei_app
      nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

do $$
begin
  execute format('grant connect on database %I to yanxiaobei_app', current_database());
end
$$;

grant usage on schema public to yanxiaobei_app;
revoke create on schema public from yanxiaobei_app;

grant select, insert, update, delete on table
  users, sessions, products, tasks, purchase_intents, messages,
  admin_audit_log, auth_tokens, task_applications, notifications,
  user_blocks, reports
to yanxiaobei_app;

grant usage, select on all sequences in schema public to yanxiaobei_app;
revoke all on table schema_migrations from yanxiaobei_app;

drop policy if exists yanxiaobei_app_all on users;
create policy yanxiaobei_app_all on users for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on sessions;
create policy yanxiaobei_app_all on sessions for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on products;
create policy yanxiaobei_app_all on products for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on tasks;
create policy yanxiaobei_app_all on tasks for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on purchase_intents;
create policy yanxiaobei_app_all on purchase_intents for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on messages;
create policy yanxiaobei_app_all on messages for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on admin_audit_log;
create policy yanxiaobei_app_all on admin_audit_log for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on auth_tokens;
create policy yanxiaobei_app_all on auth_tokens for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on task_applications;
create policy yanxiaobei_app_all on task_applications for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on notifications;
create policy yanxiaobei_app_all on notifications for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on user_blocks;
create policy yanxiaobei_app_all on user_blocks for all to yanxiaobei_app using (true) with check (true);
drop policy if exists yanxiaobei_app_all on reports;
create policy yanxiaobei_app_all on reports for all to yanxiaobei_app using (true) with check (true);

commit;

begin;

alter table products
  add column if not exists item_condition varchar(30) not null default '未填写';

alter table tasks
  add column if not exists task_type varchar(30) not null default 'other',
  add column if not exists deadline_at timestamptz,
  add column if not exists estimated_minutes integer;

alter table tasks drop constraint if exists tasks_status_check;
alter table tasks
  add constraint tasks_status_check
  check (status in ('open', 'in_progress', 'done', 'cancelled', 'expired'));

alter table tasks drop constraint if exists tasks_estimated_minutes_check;
alter table tasks
  add constraint tasks_estimated_minutes_check
  check (estimated_minutes is null or estimated_minutes between 5 and 1440);

-- 旧任务没有可靠的日期，不能替用户猜一个截止时间。保留记录，但停止在公开列表展示。
update tasks
set status = 'expired'
where status = 'open' and deadline_at is null;

create index if not exists idx_tasks_status_deadline
  on tasks (status, deadline_at);

commit;

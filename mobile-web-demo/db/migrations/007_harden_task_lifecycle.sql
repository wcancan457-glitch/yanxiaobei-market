begin;

-- 无法可靠推断日期的旧任务统一保留为过期记录，包括已经被接取的旧任务。
update tasks
set status = 'expired', updated_at = now()
where status in ('open', 'in_progress') and deadline_at is null;

alter table tasks drop constraint if exists tasks_task_type_check;
alter table tasks
  add constraint tasks_task_type_check
  check (task_type in ('pickup', 'errand', 'part_time', 'skill', 'other'));

alter table tasks drop constraint if exists tasks_active_fields_check;
alter table tasks
  add constraint tasks_active_fields_check
  check (
    status not in ('open', 'in_progress')
    or (
      deadline_at is not null
      and estimated_minutes is not null
      and deadline_at > created_at
    )
  );

commit;

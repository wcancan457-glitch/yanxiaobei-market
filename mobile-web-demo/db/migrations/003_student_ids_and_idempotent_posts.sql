begin;

alter table users drop constraint if exists users_student_id_check;
alter table users add constraint users_student_id_check check (
  student_id ~ '^20[0-9]{6,18}$'
  or student_id ~ '^[SB]20[0-9]{7}$'
);

alter table products add column if not exists request_id varchar(100);
alter table tasks add column if not exists request_id varchar(100);

create unique index if not exists products_seller_request_idx
  on products(seller_id, request_id)
  where request_id is not null;
create unique index if not exists tasks_publisher_request_idx
  on tasks(publisher_id, request_id)
  where request_id is not null;

commit;

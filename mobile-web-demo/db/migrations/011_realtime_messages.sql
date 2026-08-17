begin;

alter table messages add column if not exists request_id varchar(100);

alter table messages drop constraint if exists messages_request_id_check;
alter table messages
  add constraint messages_request_id_check
  check (request_id is null or request_id ~ '^[A-Za-z0-9_-]{16,100}$');

create unique index if not exists messages_sender_request_unique_idx
  on messages (sender_id, request_id) where request_id is not null;

create index if not exists messages_recipient_created_idx
  on messages (recipient_id, created_at, id);

create index if not exists messages_sender_created_idx
  on messages (sender_id, created_at, id);

commit;

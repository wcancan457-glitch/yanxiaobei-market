begin;

alter table sessions add column if not exists last_seen_at timestamptz not null default now();
create index if not exists sessions_last_seen_idx on sessions(last_seen_at desc);

commit;

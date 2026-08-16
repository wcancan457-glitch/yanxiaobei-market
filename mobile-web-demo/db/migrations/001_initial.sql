begin;

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  student_id text not null unique check (student_id ~ '^[0-9]{4,20}$'),
  name varchar(30) not null,
  campus varchar(30) not null default '平乐园校区',
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash char(64) primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id text primary key,
  title varchar(100) not null,
  category varchar(30) not null,
  campus varchar(30) not null,
  campus_text varchar(30) not null,
  price numeric(10, 2) not null check (price > 0),
  location varchar(120) not null,
  description text not null,
  status varchar(20) not null default 'available'
    check (status in ('available', 'trading', 'sold', 'down')),
  seller_id uuid not null references users(id) on delete restrict,
  buyer_id uuid references users(id) on delete set null,
  image_url text,
  image_class varchar(30),
  symbol varchar(10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  title varchar(100) not null,
  campus varchar(30) not null,
  campus_text varchar(30) not null,
  reward numeric(10, 2) not null check (reward > 0),
  location varchar(120) not null,
  description text not null,
  status varchar(20) not null default 'open'
    check (status in ('open', 'in_progress', 'done', 'cancelled')),
  publisher_id uuid not null references users(id) on delete restrict,
  taker_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists purchase_intents (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  buyer_id uuid not null references users(id) on delete cascade,
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'canceled', 'sold')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists products_status_created_idx
  on products(status, created_at desc);
create index if not exists products_seller_idx
  on products(seller_id, created_at desc);
create index if not exists tasks_status_created_idx
  on tasks(status, created_at desc);
create index if not exists tasks_publisher_idx
  on tasks(publisher_id, created_at desc);
create index if not exists intents_product_idx
  on purchase_intents(product_id, created_at desc);
create index if not exists intents_buyer_idx
  on purchase_intents(buyer_id, created_at desc);
create unique index if not exists intents_one_active_per_buyer_product_idx
  on purchase_intents(product_id, buyer_id)
  where status in ('pending', 'accepted');
create index if not exists messages_conversation_idx
  on messages(product_id, sender_id, recipient_id, created_at);
create index if not exists sessions_user_idx on sessions(user_id);
create index if not exists sessions_expiry_idx on sessions(expires_at);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users
for each row execute function set_updated_at();

drop trigger if exists products_set_updated_at on products;
create trigger products_set_updated_at before update on products
for each row execute function set_updated_at();

drop trigger if exists tasks_set_updated_at on tasks;
create trigger tasks_set_updated_at before update on tasks
for each row execute function set_updated_at();

drop trigger if exists intents_set_updated_at on purchase_intents;
create trigger intents_set_updated_at before update on purchase_intents
for each row execute function set_updated_at();

alter table users enable row level security;
alter table sessions enable row level security;
alter table products enable row level security;
alter table tasks enable row level security;
alter table purchase_intents enable row level security;
alter table messages enable row level security;

revoke all on table users, sessions, products, tasks, purchase_intents, messages
  from anon, authenticated;

commit;

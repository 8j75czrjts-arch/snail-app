-- Drank Snail Natra schema. Run once in the Supabase SQL editor.
--
-- Tables are prefixed sn_ so they never collide with anything already in the project
-- (the Daily Tally app in the same project uses dt_).
-- Row level security is ON with no policies: the public/anon key can read and write nothing.
-- Only the Vercel API (using the service_role key, which bypasses RLS) touches these tables.

-- One row per person. Profile settings live here. Water is always stored in US fl oz.
create table if not exists sn_users (
  id                 uuid primary key,
  email              text not null unique,
  unit               text not null default 'oz' check (unit in ('oz', 'l')),
  bottle_oz          numeric not null default 20,
  goal_oz            numeric not null default 73,
  music_app          text not null default 'apple' check (music_app in ('apple', 'spotify')),
  time_zone          text not null default 'UTC',          -- IANA, e.g. 'America/New_York'
  last_evaluated_day date,                                  -- last local day checked for the death rule
  onboarded          boolean not null default false,
  created_at         timestamptz not null default now()
);

create table if not exists sn_snails (
  id         uuid primary key,
  user_id    uuid not null references sn_users(id) on delete cascade,
  hatched_on date not null,
  died_on    date,                                          -- null while alive
  created_at timestamptz not null default now()
);
create index if not exists sn_snails_user on sn_snails (user_id, hatched_on);

-- One row per bottle logged. `day` is the user's local calendar day.
create table if not exists sn_drinks (
  id         uuid primary key,                              -- made by the client so retries are safe
  user_id    uuid not null references sn_users(id) on delete cascade,
  snail_id   uuid not null references sn_snails(id) on delete cascade,
  day        date not null,
  amount_oz  numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists sn_drinks_user_day on sn_drinks (user_id, day);

-- One row per finished day, written when the day is evaluated. Streaks come from here.
create table if not exists sn_days (
  user_id  uuid not null references sn_users(id) on delete cascade,
  day      date not null,
  bottles  int not null,
  oz       numeric not null,
  needed   int not null,
  goal_met boolean not null,
  primary key (user_id, day)
);

-- Web push subscriptions (one per browser/device).
create table if not exists sn_push (
  endpoint   text primary key,
  user_id    uuid not null references sn_users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists sn_push_user on sn_push (user_id);

-- Which nags already went out, so a repeated cron run never sends the same one twice.
create table if not exists sn_nags (
  user_id uuid not null references sn_users(id) on delete cascade,
  day     date not null,
  kind    text not null,
  primary key (user_id, day, kind)
);

alter table sn_users  enable row level security;
alter table sn_snails enable row level security;
alter table sn_drinks enable row level security;
alter table sn_days   enable row level security;
alter table sn_push   enable row level security;
alter table sn_nags   enable row level security;

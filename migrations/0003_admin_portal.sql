-- Support for the web admin portal: where an uploaded ID lives, editable
-- settings, and a way to grant portal access without a redeploy.

-- ---------------------------------------------------------------------------
-- Uploaded documents
-- ---------------------------------------------------------------------------

-- The file itself is never downloaded or stored by this service — Telegram
-- already hosts it, and re-hosting a copy of somebody's national ID would be
-- exposure with no benefit. What is kept is the handle needed to fetch it
-- through the Bot API on demand, which requires the bot token and therefore
-- only this service (and Telegram) can resolve.
alter table card_jobs add column if not exists telegram_file_id        text;
alter table card_jobs add column if not exists telegram_file_unique_id text;

-- ---------------------------------------------------------------------------
-- Settings editable from the portal
-- ---------------------------------------------------------------------------

-- A single row rather than a key-value table: there is exactly one set of
-- settings for this deployment, and a fixed row shape makes a wrong or missing
-- key impossible rather than something to check for.
--
-- Columns are nullable and null means "use the environment variable's
-- default" (see src/env.ts) — so a deployment that has never touched the
-- portal behaves exactly as it did before this table existed.
create table if not exists app_settings (
  id                       boolean primary key default true check (id),
  point_price_etb          numeric(10,2) check (point_price_etb > 0),
  cbe_account_name         text,
  cbe_account_number       text,
  telebirr_account_name    text,
  telebirr_account_number  text,
  updated_at               timestamptz not null default now(),
  updated_by               bigint
);
insert into app_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Portal access
-- ---------------------------------------------------------------------------

-- ADMIN_TELEGRAM_IDS (the environment variable) remains the bootstrap set —
-- the people who can get in with no database available to grant anyone else
-- access, and who cannot be removed by anyone using the portal. This table is
-- purely additive: an admin already in means an admin already in has granted
-- someone else the same standing, via the portal, without a redeploy.
create table if not exists bot_admins (
  telegram_id bigint primary key references bot_users(telegram_id) on delete cascade,
  added_by    bigint,
  created_at  timestamptz not null default now()
);

comment on table app_settings is
  'Singleton. A null column means: use the environment variable default.';
comment on column card_jobs.telegram_file_id is
  'Handle to fetch the file through the Bot API. The file is never stored here.';

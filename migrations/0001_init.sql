-- Conversation state, lookup audit, and support handoff.
--
-- Four tables, and only this bot touches them. There is no row-level security
-- here and no role switching: those exist to separate tenants that share a
-- database, and this database has one occupant. Protecting it is the
-- connection string's job.

-- ---------------------------------------------------------------------------
-- Who is talking to the bot, and where they are in a conversation
-- ---------------------------------------------------------------------------

create table if not exists bot_users (
  telegram_id  bigint primary key,
  chat_id      bigint not null,
  first_name   text not null default '',
  username     text,
  -- Null until they pick one. The distinction matters: it is what makes /start
  -- show the language chooser rather than guessing from language_code and
  -- being wrong at someone in a language they do not read.
  language     text check (language in ('am','en')),
  -- Where the next plain text message should be routed. A conversation with no
  -- state is one where free text means nothing, and gets the menu back.
  state        text not null default 'idle',
  state_data   jsonb not null default '{}'::jsonb,
  -- Set when Telegram answers 403 for this chat with a reason that says the
  -- chat is gone. Cleared when they message the bot again.
  is_blocked   boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Update de-duplication
-- ---------------------------------------------------------------------------

-- Telegram retries a webhook delivery until it gets a 2xx, and will happily
-- deliver the same update twice if our response is slow. Without this, one
-- tapped button can open two support tickets or spend two lookups from a
-- rate-limit budget. update_id is unique per bot and monotonic, so recording it
-- is enough to make the whole handler idempotent.
create table if not exists bot_updates (
  update_id   bigint primary key,
  received_at timestamptz not null default now()
);

create index if not exists bot_updates_received_at_idx on bot_updates (received_at);

-- ---------------------------------------------------------------------------
-- Lookup audit
-- ---------------------------------------------------------------------------

-- A national ID number is the most sensitive thing this bot will ever hold, so
-- it is not held. The row below records that a lookup happened, by whom, and
-- how it turned out — which is what rate limiting and support need — while the
-- number itself is reduced to a keyed hash plus its last four digits (enough
-- for a person to recognise their own attempt when support reads it back to
-- them, not enough to reconstruct).
--
-- The hash is an HMAC, not a bare digest: the search space of a 12-digit number
-- is small enough to enumerate in seconds, so an unkeyed hash of it is
-- effectively plaintext.
create table if not exists bot_lookups (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint not null references bot_users(telegram_id) on delete cascade,
  id_kind     text not null check (id_kind in ('fin','fan')),
  id_hash     text not null,
  id_last4    text not null,
  outcome     text not null check (outcome in ('found','not_found','invalid','unavailable','error')),
  created_at  timestamptz not null default now()
);

-- Serves the per-user rate limit, which is the only way this is ever read.
create index if not exists bot_lookups_telegram_id_created_at_desc_idx
  on bot_lookups (telegram_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Support handoff
-- ---------------------------------------------------------------------------

create table if not exists bot_support_messages (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint not null references bot_users(telegram_id) on delete cascade,
  language    text not null,
  body        text not null,
  -- Whether the copy forwarded to the support chat actually got there. False
  -- means the message is in this table only, and someone has to come looking.
  forwarded   boolean not null default false,
  status      text not null default 'open' check (status in ('open','closed')),
  created_at  timestamptz not null default now()
);

create index if not exists bot_support_messages_status_created_at_desc_idx
  on bot_support_messages (status, created_at desc);

comment on table bot_users is
  'One row per Telegram chat with the bot. Holds the conversation state machine.';
comment on column bot_lookups.id_hash is
  'HMAC of the submitted number — see src/bot/fayda.ts. The number itself is never stored.';

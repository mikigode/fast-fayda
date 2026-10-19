-- Points, payments, per-user output settings, and card jobs.
--
-- The bot becomes a paid service here: a print costs points, points are bought
-- by paying into a CBE or Telebirr account and sending the receipt, and the
-- receipt is verified before anything is credited.
--
-- The design rule throughout is that a receipt is worth points exactly once.
-- Everything else — parsing six input formats, fetching the bank's page,
-- falling back to a human — is machinery around that one guarantee, which is
-- enforced by a unique index rather than by any of the code paths above it.

-- ---------------------------------------------------------------------------
-- Balances and output preferences
-- ---------------------------------------------------------------------------

alter table bot_users add column if not exists points int not null default 0;

-- The four outputs the bot can produce, and which background to composite on.
-- Held per user because they are sticky preferences, not per-request choices:
-- someone printing a stack of cards sets them once.
alter table bot_users add column if not exists download_type text not null default 'pdf_mirror'
  check (download_type in ('png_mirror','pdf_mirror','duo_png','zip'));
alter table bot_users add column if not exists background text not null default 'bg2';

-- A balance that can go negative means a refund bug becomes free prints.
alter table bot_users drop constraint if exists bot_users_points_non_negative;
alter table bot_users add constraint bot_users_points_non_negative check (points >= 0);

-- ---------------------------------------------------------------------------
-- Purchases
-- ---------------------------------------------------------------------------

create table if not exists point_purchases (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint not null references bot_users(telegram_id) on delete cascade,
  provider     text not null check (provider in ('cbe','telebirr')),
  -- The bank's own transaction reference, normalised. This is the identity of
  -- the payment, and the reason a screenshot cannot be spent twice.
  reference    text not null,
  -- What the person actually sent, kept so an operator reviewing a rejected
  -- purchase can see the input rather than guess at it.
  raw_input    text not null,
  amount_etb   numeric(12,2),
  points       int not null default 0,
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected')),
  -- How it reached that status: the bot confirmed it against the bank's page,
  -- or a human decided.
  decided_by   text not null default 'none' check (decided_by in ('none','auto','admin')),
  admin_id     bigint,
  note         text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

-- The single-use guarantee. Case-folded, because a reference typed by hand
-- arrives in whatever case the person's keyboard was in, and FT25391XM4KP and
-- ft25391xm4kp are the same payment.
create unique index if not exists point_purchases_reference_key
  on point_purchases (provider, upper(reference));

create index if not exists point_purchases_status_created_at_desc_idx
  on point_purchases (status, created_at desc);
create index if not exists point_purchases_telegram_id_created_at_desc_idx
  on point_purchases (telegram_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

-- Every movement of points, so a disputed balance can be reconstructed rather
-- than argued about. bot_users.points is the running total; this is why it
-- holds the value it does.
create table if not exists point_ledger (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint not null references bot_users(telegram_id) on delete cascade,
  delta       int not null,
  reason      text not null check (reason in ('purchase','print','refund','admin_grant','admin_deduct')),
  -- The purchase or card job this movement came from, when there is one.
  ref_id      uuid,
  balance_after int not null,
  created_at  timestamptz not null default now()
);

create index if not exists point_ledger_telegram_id_created_at_desc_idx
  on point_ledger (telegram_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Card jobs
-- ---------------------------------------------------------------------------

-- One row per card the bot is asked to produce, whichever way it was asked.
-- Created before the points are spent and settled after, so a job that fails
-- can be refunded against a record rather than on trust.
create table if not exists card_jobs (
  id            uuid primary key default gen_random_uuid(),
  telegram_id   bigint not null references bot_users(telegram_id) on delete cascade,
  source        text not null check (source in ('otp','upload_image','upload_pdf')),
  download_type text not null,
  background    text not null,
  status        text not null default 'pending'
                  check (status in ('pending','rendering','delivered','failed','refunded')),
  points_spent  int not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);

create index if not exists card_jobs_telegram_id_created_at_desc_idx
  on card_jobs (telegram_id, created_at desc);

-- ---------------------------------------------------------------------------
-- OTP sessions
-- ---------------------------------------------------------------------------

-- The card-by-FAN flow: a number is submitted, the provider sends a code to the
-- phone registered against it, and the code comes back here.
--
-- The FAN is hashed for the same reason lookup numbers are (see bot_lookups) —
-- it is somebody's application number, and the session needs to recognise it,
-- not remember it. Sessions expire because an unanswered OTP is an abandoned
-- one, and a stale session that still accepts a code is a way in.
create table if not exists otp_sessions (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint not null references bot_users(telegram_id) on delete cascade,
  -- Which of the three OTP buttons started this.
  slot         int not null check (slot between 1 and 3),
  fan_hash     text not null,
  fan_last4    text not null,
  -- Opaque handle the provider gave us to continue the exchange with.
  provider_ref text,
  status       text not null default 'awaiting_code'
                 check (status in ('awaiting_code','verified','failed','expired')),
  attempts     int not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '10 minutes'
);

create index if not exists otp_sessions_telegram_id_created_at_desc_idx
  on otp_sessions (telegram_id, created_at desc);

comment on index point_purchases_reference_key is
  'One payment, one credit. The single-use guarantee lives here, not in application code.';
comment on column bot_users.points is
  'Running total. point_ledger holds the movements that produced it.';

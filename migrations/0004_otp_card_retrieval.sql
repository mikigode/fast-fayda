-- Card retrieval by FAN: what has to survive between "send me the code" and
-- the code arriving.

-- The provider's verify call needs the FAN sent back alongside the OTP, so the
-- number has to outlive the message it arrived in. Everywhere else in this
-- service an ID number is hashed and forgotten (see bot_lookups), and that
-- remains true here for the audit columns — fan_hash and fan_last4 above are
-- still what gets kept.
--
-- This column is the exception, and it is deliberately a narrow one: encrypted
-- with AES-256-GCM under a key derived from the environment (src/crypto.ts),
-- cleared the moment the session reaches a terminal state, and gone within ten
-- minutes regardless because the session expires. A database dump on its own
-- does not yield it.
alter table otp_sessions add column if not exists fan_secret text;

comment on column otp_sessions.fan_secret is
  'Encrypted FAN, needed for the verify call. Cleared on completion; never plaintext.';

-- Finding the session a code belongs to means "the newest one still open for
-- this person", which is this index.
create index if not exists otp_sessions_open_idx
  on otp_sessions (telegram_id, created_at desc)
  where status = 'awaiting_code';

-- A card produced from an OTP has no uploaded file behind it, so the columns
-- added in 0003 for that case do not apply. They were added nullable, which is
-- what makes an OTP job representable in the same table; this records why.
comment on table card_jobs is
  'One row per print. OTP jobs have no telegram_file_id — nothing was uploaded, and the delivered PDF is not retained.';

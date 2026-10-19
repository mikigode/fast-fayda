-- Card API key editable from the portal.
--
-- Same pattern as the other settings columns in app_settings: nullable, and a
-- null means "use the environment variable's default" (see src/env.ts), so a
-- deployment that never touches the portal behaves exactly as before.
--
-- This column holds the upstream Card API key — a secret that spends points on
-- every verify — so the portal shows it masked and only overwrites it when an
-- admin types a new value. It is read back on every verify rather than captured
-- at boot, which is what lets a key be rotated without a redeploy.
alter table app_settings add column if not exists card_api_key text;

comment on column app_settings.card_api_key is
  'Card API key set from the portal. Null means: use CARD_API_KEY from the environment.';

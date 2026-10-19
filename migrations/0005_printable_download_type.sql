-- The download-format menu offers a "Printable Card" (`printable`), but the
-- constraint added in 0002 predates that choice and never allowed it — it lists
-- only the four mirror formats. Selecting it failed against the database, so
-- the setting could not be saved. Widen the constraint to match the menu.

alter table bot_users drop constraint if exists bot_users_download_type_check;
alter table bot_users add constraint bot_users_download_type_check
  check (download_type in ('png_mirror', 'pdf_mirror', 'duo_png', 'zip', 'printable'));

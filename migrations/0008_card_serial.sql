-- A serial number for each printable card.
--
-- The bot draws the printable card itself, so a print run needs a number that
-- identifies the card. A sequence is the guarantee: `nextval` is atomic, so two
-- verifies finishing at the same moment never receive the same serial, and a
-- number is never handed out twice. It starts at 58100 and only goes up.
create sequence if not exists card_serial_seq start with 58100;

comment on sequence card_serial_seq is
  'Printable-card serials. Starts at 58100; one allocation per successful printable card.';

# Vendor documentation

The card API's own integration guides, kept here because `src/bot/card.ts` is
written against them and a claim in a comment is easier to trust when the
source is next to it.

| File | What it covers |
|---|---|
| `fayda-api-telegram-bot-integration-guide.pdf` | `POST /verify-otp` → **PDF bytes**. The optional second call that delivers the provider's original PDF. |
| `fayda-api-json-integration-guide.pdf` | `POST /verify-otp-json` → identity data as JSON. The primary verify: its fields draw the designed card. |

Two things from these shaped the implementation, and both fail confusingly
rather than loudly if missed:

**A successful verify is not JSON.** `/verify-otp` answers with the raw PDF on
success and JSON on every error, so the response is read as bytes and the
content type inspected before anything parses it. A client that calls
`.json()` unconditionally gets a syntax error from `%PDF-1.4` and reports a
successful verification as a failure — with the point already spent.

**Calling both verify endpoints costs two points.** Each successful verify
deducts one. Every completed delivery starts with `/verify-otp-json`, whose
fields draw the 2600×800 card; that image is sent first and is the guarantee.
Formats other than "Printable Card" then make a second, best-effort call to
`/verify-otp` for the provider's original PDF. If that call is refused, the PDF
is lost and the image is not.

The card is always the designed image (`src/bot/cardImage.ts`, drawn on
`assets/card-background.png` with the holder's particulars). Nothing is
rasterised out of a delivered PDF, and no A4 page is produced: a picture of
paper is not a card. "Printable Card" asks for the JSON verify and receives only
the designed picture.

These are third-party documents, reproduced here for reference. They are not
authored by this project, and they are not a licence — see
`../relying-party-application.md` for the question of whether the service
described here is itself an authorised relying party.

# Vendor documentation

The card API's own integration guides, kept here because `src/bot/card.ts` is
written against them and a claim in a comment is easier to trust when the
source is next to it.

| File | What it covers |
|---|---|
| `fayda-api-telegram-bot-integration-guide.pdf` | `POST /verify-otp` → **PDF bytes**. The default: delivers the provider's original PDF. |
| `fayda-api-json-integration-guide.pdf` | `POST /verify-otp-json` → identity data as JSON. Used for the "Printable Card" format. |

Two things from these shaped the implementation, and both fail confusingly
rather than loudly if missed:

**A successful verify is not JSON.** `/verify-otp` answers with the raw PDF on
success and JSON on every error, so the response is read as bytes and the
content type inspected before anything parses it. A client that calls
`.json()` unconditionally gets a syntax error from `%PDF-1.4` and reports a
successful verification as a failure — with the point already spent.

**Calling both verify endpoints costs two points.** Each successful verify
deducts one, and the guide is explicit that both endpoints must not be called
for the same OTP. The bot therefore verifies through exactly one: `/verify-otp`
by default, `/verify-otp-json` for "Printable Card".

The PDF is also sent as a picture. The provider embeds the card's front and back
in its own document, so `src/bot/pdfImage.ts` extracts those two images and
composes them side by side. That is the picture a PDF delivery arrives with —
never a rendering of the A4 sheet, and never a reason for a second verify. If a
document has no such artwork, no picture is sent. "Printable Card" draws its
picture from the JSON fields instead (`src/bot/cardImage.ts`, on
`assets/card-background.png`).

These are third-party documents, reproduced here for reference. They are not
authored by this project, and they are not a licence — see
`../relying-party-application.md` for the question of whether the service
described here is itself an authorised relying party.

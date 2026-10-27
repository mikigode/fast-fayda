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

**Never call both verify endpoints for the same OTP.** Each successful verify
deducts a point. The JSON endpoint returns the same identity as fields instead
of a rendered document; the bot uses the PDF endpoint for the document and asks
for JSON only when the customer chose the "Printable Card" format, which is
rendered here from those fields. One choice is made per code, never both.

The PDF is also sent as a picture, and that picture is the PDF: PDFium renders
its pages to a PNG (see `src/bot/pdfImage.ts`) after the document has gone out.
No identity fields are involved, so no second verify is needed. The JSON flow's
picture is drawn from the identity instead (`src/bot/cardImage.ts`).

These are third-party documents, reproduced here for reference. They are not
authored by this project, and they are not a licence — see
`../relying-party-application.md` for the question of whether the service
described here is itself an authorised relying party.

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
deducts one. The JSON endpoint returns the same identity as fields instead of a
rendered document, so the document is fetched through exactly one endpoint: PDF
by default, JSON for "Printable Card". The bot does make a second, JSON call for
the PDF flow — but only after the document has been delivered, and only to get
the fields for the card picture. That is one extra point upstream per PDF
delivery; it is never what produces the document, and if it fails the picture
falls back to the PDF's own pages.

The PDF is also sent as a picture. When the fields behind the code came back,
that picture is the designed card (`src/bot/cardImage.ts`, drawn on
`assets/card-background.png` with the holder's particulars). When they did not —
an already-used code, an outage — PDFium renders the PDF's pages to a PNG
instead (see `src/bot/pdfImage.ts`), so a PDF delivery still arrives as a
picture.

These are third-party documents, reproduced here for reference. They are not
authored by this project, and they are not a licence — see
`../relying-party-application.md` for the question of whether the service
described here is itself an authorised relying party.

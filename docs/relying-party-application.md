# Applying to NIDP as a relying party

Notes for getting fast-fayda legitimate access to Fayda identity data, instead
of scraping somebody else's service for it.

> **Where things currently stand.** The bot now talks to a commercial reseller
> (see `CARD_API_KEY` in the README) over documented endpoints with an issued
> key — not by scraping, and with the holder consenting via an OTP sent to
> their own registered phone. That is a normal integration, and it is what is
> wired up today.
>
> It does not answer the question this document is about. A reseller is only as
> authorised as its own licence, and clean code downstream of an unauthorised
> pipeline is still downstream of it. **Ask the reseller, in writing, whether
> they hold an NIDP relying-party licence and what purposes it permits.** If
> they do, keep the answer on file. If they cannot say, that is itself the
> answer, and the direct route below becomes the one that matters.

Everything in "Where to apply" below came from public search results, not from
pages fetched directly — the sandbox this was written in cannot reach
`id.gov.et`. **Confirm the URLs and the phone number before relying on them.**

---

## 1. Ask the eligibility question before anything else

Do not build, and do not fill in an application, until NIDP has answered this:

> May a private business produce a printed Fayda card — or a printable
> rendering of one — for a resident who has authenticated and consented?
> If yes, under what conditions and with what restrictions on appearance?

This is the question the whole business model rests on, and it is genuinely
open. Two plausible answers:

- **Card issuance is exclusively NIDP's.** Then there is no version of the
  print service that is legal, with or without an API — and that is worth
  knowing in a phone call rather than after months of integration work.
- **A licensed print/reprint service is permitted.** Then the application below
  is the route, and the constraints they attach (branding, security features,
  what the output may look like) become the specification for what gets built.

Ask it first, in writing if you can, so the answer is on record.

Note that this question covers the *manual* path too — an admin taking a
customer's uploaded screenshot and producing a card by hand is still card
production. Whatever answer comes back applies to the current bot as it
stands, not only to a future automated version.

---

## 2. Where to apply

| What | Where |
|---|---|
| Partner portal | `partner.fayda.et` |
| API information and application form | `id.gov.et/api` |
| Partner information | `id.et/partners` |
| API documentation | `nidp.atlassian.net` (Fayda Platform API Specification) |
| Reference code | `github.com/National-ID-Program-Ethiopia` |
| Support | `+251 113 720 006` |

Reported turnaround on an application is around **two working days**, which
suggests the first response is a triage rather than a full decision. NBE-licensed
financial institutions have a separate, faster route via ETswitch — not
applicable here.

---

## 3. What the API actually offers

Fayda is built on MOSIP, and access follows MOSIP's relying-party model:
register as a partner, request an API key against a named policy, get issued
credentials once a Partner Manager approves.

The relevant product is **eKYC**: after the resident authenticates and
consents, the relying party receives their demographic data and facial
photograph. Consent is captured through OTP or biometric authentication —
which is exactly the mechanism the bot's OTP buttons are shaped around.
Authentication is OAuth 2.0 / OpenID Connect through Fayda eSignet.

Two things follow from this that are worth internalising now:

**The OTP is the consent, not a lookup key.** In the current stub, "enter a
FAN, get a card" reads like a database query. In the real system the resident
is authenticating themselves and agreeing to release their data to *you*, a
named partner, for a *stated purpose*. That framing has to survive into the
bot's copy — a customer should understand they are consenting, not just typing
a number.

**Purpose limitation is a binding condition, not boilerplate.** Relying parties
must not use Fayda data for anything other than the consented purpose. Whatever
purpose is written on the application is the purpose the service is allowed to
have, permanently.

---

## 4. What they will ask, and what this codebase can already answer

Applications of this kind ask what data you take, why, how you store it, and
how you secure it. fast-fayda's existing design answers most of that well, and
the answers are true rather than aspirational — each one is enforced in code
and covered by tests.

| Question | Answer as built |
|---|---|
| What identity data is stored? | None. A lookup is recorded as a keyed HMAC of the number plus its last four digits — enough to rate-limit and to let support identify an attempt, not enough to recover the number. |
| Why keyed rather than plain hashing? | Twelve digits is a small enough space to enumerate, so an unkeyed hash would be storage in all but name. |
| Are customer documents stored? | No. Uploads are kept as a Telegram `file_id` only and resolved on demand; no copy is written to disk or object storage. |
| Who can see a customer's document? | Signed-in admins only, streamed through the server so the bot token is never exposed to a browser. |
| How is admin access controlled? | Telegram Login (HMAC-verified), signed session cookie, membership re-checked against the allow-list on every request so revocation is immediate. |
| Rate limiting? | Five lookups per fifteen minutes per person. |
| Audit trail? | Every lookup and every points transaction is recorded with its outcome. |
| Data in transit | TLS throughout; Postgres connections verify certificates (`DATABASE_CA_CERT` for private CAs), and TLS verification is never disabled. |

Gaps to close before submitting — these are real and should not be papered
over:

- **No published privacy notice or retention policy.** Needs writing, and it
  needs to match what the code does.
- **No explicit consent step in the bot.** The copy currently asks for a
  number; it does not tell the customer what will be retrieved, by whom, or
  for what. Under a real eKYC integration that step is mandatory.
- **No data-deletion path.** A customer cannot currently ask for their record
  to be removed.
- **Legal entity.** Partner registration will need a registered business, not
  an individual.

---

## 5. What changes in the code when credentials arrive

Less than you would think, which was the point of building it this way.

`src/bot/fayda.ts` already isolates status lookups behind a `FaydaProvider`
interface, and an unconfigured deployment says "unavailable" rather than
inventing an answer. eKYC is a **different shape** from that interface, though
— it is a consent-and-release flow, not a query — so it arrives as a second
provider alongside the first, roughly:

- an eSignet OIDC client (authorisation redirect, token exchange, userinfo)
- a consent screen in the bot's copy, in both languages, before the redirect
- storage of the returned data only for as long as the job needs it

The conversation, points, payments, admin portal, i18n and audit logging all
stay exactly as they are. None of them know where identity data comes from.

**Rendering a card from scratch stays unbuilt** — and with the OTP flow
delivering a finished PDF from upstream, nothing needs it. Compositing
identity data onto a reproduction of the card's security background is
forgery regardless of who asks, so that path is closed on purpose rather than
merely unfinished.

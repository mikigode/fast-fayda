# fast-fayda

A Telegram bot for Fayda application status, in Amharic and English.

It checks the status of an application by FIN or FAN, answers common questions,
explains how registration appointments work, and hands a message to a human when
none of that is enough. One Node process and a Postgres database; no framework.

```
/start          language chooser → main menu
/status         ask for a FIN (12 digits) or FAN (16 digits) → status
/faq            question list → answers
/support        collect a message → forward it to the support chat
/language       change language
/cancel         drop out of whatever question is open
```

The language is chosen on first contact rather than guessed, and can be changed
at any time. Buttons replace the screen they were tapped on, so a conversation
stays one screen instead of growing into a wall of chat.

---

## Two things to know before pointing anyone at it

**Status lookups need a registry to ask.** There is no public API for FIN/FAN
status, so `FAYDA_PROVIDER` is unset by default and the bot tells people the
check is unavailable. That is deliberate: everything around the lookup — input
validation, rate limiting, auditing, the conversation itself — works without it,
so `src/bot/fayda.ts` is the one file to change when there are credentials.
`FAYDA_PROVIDER=stub` gives deterministic fake answers for local development and
refuses to run when `NODE_ENV=production`, because a made-up status about
someone's national ID is worse than an outage: it looks like an answer.

**This is not the National ID Program.** It is a third-party helper, and it does
not present itself as anything else. If you are deploying it, do not dress it up
in official branding — a bot that looks official while collecting people's ID
numbers is a phishing tool whatever its intent.

---

## Setup, in one command

```bash
git clone https://github.com/caveen18/fast-fayda && cd fast-fayda
npm install
npm run setup
```

It asks for a database URL and a bot token, checks each one as you enter it,
applies the schema, and then either starts the bot locally or points Telegram at
a deployment. Answers are saved to `.env`, so running it again means pressing
enter a few times.

Checking as it goes is the point. A connection string that a given host cannot
reach reads as a credentials problem; a webhook registered against the wrong
path reads as a broken bot; a schema that was never applied reads as a bot that
ignores you. Each of those becomes a sentence naming the fix.

The quickest way to a bot you can message is to choose option 1 — run it here.
No hosting, no URL, no webhook, no deployment.

---

## Running it by hand

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and TELEGRAM_BOT_TOKEN
npm run webhook secret        # generate TELEGRAM_WEBHOOK_SECRET, paste into .env
npm run dev
```

The schema is created on startup — migrations in `migrations/` are applied in
filename order inside a single transaction, under a transaction-scoped advisory
lock, so two containers rolling at once cannot race and a failure part-way
through leaves the database where it started. There is no separate migrate step.

Then point Telegram at the deployment:

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
  npm run webhook set https://your-host.example.com

npm run webhook info      # when the bot goes quiet, this says why
```

`info` is the first place to look when nothing is happening:
`last_error_message` is Telegram's own account of why delivery is failing.

Local development without a public URL: run `npm run webhook delete`, and use a
tunnel (`cloudflared tunnel --url http://localhost:8080`, `ngrok http 8080`) to
get one, then `set` against the tunnel's address.

### In production

```bash
npm run build && npm start
```

Or the container:

```bash
docker build -t fast-fayda .
docker run --env-file .env -p 8080:8080 fast-fayda
```

`GET /health` reports liveness and which status provider is active. `SIGTERM`
drains in-flight requests, closes the pool and exits 0.

---

## Running it for free

Two ways, and neither needs a card.

**Polling — no hosting at all.** Set `BOT_MODE=polling` and run it anywhere with
internet: your laptop, a spare machine, a container with no inbound routing.
The bot asks Telegram for updates over an outbound connection, so there is no
public URL to arrange and no webhook to register.

```bash
BOT_MODE=polling TELEGRAM_BOT_TOKEN=… DATABASE_URL=… npm run dev
```

That is the fastest way to have a working bot in front of you, and the right
mode for developing. Two things to know: exactly one process may poll a bot at
a time — Telegram evicts the second with a 409, which the logs name — and the
bot is only alive while that process is. Starting it clears any registered
webhook, so switching modes is a restart rather than a puzzle.

**Render's free plan — a hosted URL.** `render.yaml` asks for `plan: free`,
which needs no payment method. Free instances sleep after fifteen minutes idle
and take about a minute to wake, so the first person to message after a quiet
spell waits and may need to send twice; Telegram retries what it could not
deliver, so the message usually lands. Fine while testing, poor once people are
paying — change the plan to `starter` when that day comes and nothing else in
the setup changes.

Supabase's free Postgres suits either. Its own idle policy pauses a project
after a week of no activity, which a running bot prevents.

---

## Deploying to Vercel

Vercel's free plan suits a Telegram webhook well: functions wake in about a
second, which is inside Telegram's delivery window, so there is none of the
minute-long cold start a sleeping Render free instance has.

```bash
npm i -g vercel
vercel link
vercel env add DATABASE_URL production        # transaction pooler — see below
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_WEBHOOK_SECRET production
vercel env add ADMIN_TELEGRAM_IDS production
vercel env add ADMIN_CONTACT production
vercel env add BOT_SUPPORT_CHAT_ID production
vercel --prod
```

The Buy Points accounts and `ADMIN_SESSION_SECRET` are optional here too — see
the Admin portal section below. Skip them and set the accounts from the portal
once it is deployed; `ADMIN_SESSION_SECRET` is derived automatically if unset.

The schema is not created for you here. A function has no startup to hang
migrations off, so migrating inside the handler would mean doing it on every
cold start — several at once during a burst, each contending on the same
advisory lock while Telegram waits. Run it once, locally, against the same
database:

```bash
npm run build && DATABASE_URL=… npm run migrate
```

Check it came up, at **`/api/health`**:

```json
{"ok":true,"service":"fast-fayda","configured":true,"missing":[]}
```

`missing` names any environment variable that is not set — never its value — so
an unconfigured deployment says so instead of failing obscurely later. If
`configured` is false, set what it names and redeploy: variables are read at
deploy time, so adding one changes nothing until the next deploy.

Then register the webhook:

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
  WEBHOOK_PATH=/api/webhook npm run webhook set https://your-project.vercel.app
```

### Why there is a .vercelignore

`src/server.ts` and `src/poller.ts` are excluded from the Vercel upload. That is
the load-bearing part of this deployment, and it is deliberately not a matter of
configuration: a file that was never uploaded cannot be chosen as an entrypoint.
`builds` below is supposed to achieve the same thing by switching detection off,
but it depends on Vercel honouring the config; the ignore does not.

Nothing reachable from `api/` imports either file — `api/` reaches
`src/webhook.ts`, `src/env.ts`, `src/db.ts` and `src/bot/*`, and stops there —
so the functions build unchanged. Both files stay in the repository and are what
Render and Docker run.

`/api/health` reports the commit it is running (`VERCEL_GIT_COMMIT_SHA`). Check
it after any deploy: a **Redeploy** from the Vercel dashboard reuses the original
source, so a fix can appear not to work when it was in fact never shipped. It
also names where the card API key comes from (`cardKey`: `settings`, `env` or
`missing`); add `?card=1` to make one short `/balance` call to the card provider
and report `ok`, `refused` (with the status) or `unreachable` (with the error
name). Without the parameter the endpoint calls nobody.

### Why vercel.json uses `builds`

Because otherwise Vercel deploys the wrong file. Zero-configuration detection
finds `src/server.ts` — the long-running server, reachable from the `start`
script through tsconfig's `outDir` — concludes the repository is a server
application, and makes it the handler for every path. It has no default export,
being a process rather than a request handler, so every request returns:

```
Invalid export found in module "/var/task/src/server.cjs".
The default export must be a function or server.
```

Declaring even one entry in `builds` turns that detection off, which is the
whole reason it is there. The `functions` key does not: it configures functions
that are already being built, and has nothing to say about which files Vercel
decided to build.

**Use the transaction pooler here, not the session pooler.** On Render the
service is one process with one pool; on Vercel every warm function instance
holds its own connections, and the count grows with concurrency until the
database refuses more. Supabase's transaction pooler — port **6543** — exists
for exactly that shape:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Migrations are safe through it: they run in one transaction holding a
transaction-scoped advisory lock, which is the form that survives a pooler
handing out a different backend per transaction.

What you give up: **polling does not work on Vercel**, because it is a loop that
has to keep running and a function is killed after seconds. Serverless means
webhook. If you want polling, use Render, a VPS, or your own machine.

---

## Deploying to any container host

Anything that builds the repo and runs `npm run start` works — Render, Railway,
Fly, a plain Docker host, nixpacks-based platforms. The long-running server is
the better home for the OTP flow than a serverless function, because a verify
can take up to two minutes and nothing here will kill it partway.

Set these before the first deploy. The service refuses to start without them
and names the one it is missing, so a container that exits immediately with
`Missing environment variable DATABASE_URL` is not a broken build — it is an
unconfigured one:

| Variable | Needed when |
|---|---|
| `DATABASE_URL` | always |
| `TELEGRAM_BOT_TOKEN` | always |
| `TELEGRAM_WEBHOOK_SECRET` | webhook mode only — `npm run webhook secret` |
| `BOT_MODE=polling` | instead of the secret, if you would rather not expose a URL |

`BOT_MODE=polling` is the shortest path to a working bot on a host like this:
no public URL, no webhook registration, nothing to keep in sync. The one
constraint is that exactly one process may poll a bot, so it does not survive
being scaled past a single instance.

### Health checks and the migration window

The server listens *before* it migrates. Platforms give a new deployment a
fixed window — often 30 seconds — to answer a health check before rolling it
back, and spending that window on a database round trip means a cold pooler or
a slow link can fail a perfectly good build.

`/health` answers 200 as soon as the process is alive, with the honest state in
the body:

```json
{"ok":true,"service":"fast-fayda","ready":true}
```

`ready: false` means migrations have not finished, or failed — in which case a
`reason` field says why, which is visible in a browser where a crash-looped
container shows only that it crash-looped. While not ready the webhook answers
**503**, which Telegram retries, so an update landing in that window is delayed
rather than acknowledged and lost.

---

## Deploying to Render

`render.yaml` is a Blueprint: point Render at this repo, and it creates the web
service, builds it, and asks for the secrets. Nothing secret is in the file.

**Use Supabase's pooler URL, not the direct one.** This is the step that
silently fails otherwise. The connection string Supabase shows first —
`db.<ref>.supabase.co:5432` — resolves to an IPv6 address, and Render dials out
over IPv4. The service will start, apply no migrations, and die on the first
query with `ENETUNREACH` or a connect timeout, which looks like a credentials
problem and is not one.

In the Supabase dashboard, open **Connect** and take the **Session pooler**
string instead. It looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Note the username carries the project ref (`postgres.<ref>`, not `postgres`),
and the host is `pooler.supabase.com`. Session mode — port 5432 — is the one to
use. The transaction pooler on 6543 hands a different backend to every
transaction, which is survivable but buys nothing here.

Then, in Render's dashboard, set:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the session pooler string above |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | `npm run webhook secret` |
| `ADMIN_TELEGRAM_IDS` | your Telegram id (from @userinfobot) |
| `ADMIN_CONTACT` | the handle the bot tells people to message |
| `BOT_SUPPORT_CHAT_ID` | the chat that gets payments needing review |
| `CBE_ACCOUNT_NAME` / `CBE_ACCOUNT_NUMBER` | shown to customers in Buy Points — not secret |
| `TELEBIRR_ACCOUNT_NAME` / `TELEBIRR_ACCOUNT_NUMBER` | same, for Telebirr — not secret |
| `POINTS_PER_PRINT` | points one upload costs; default `1` |

All five are optional at deploy time — set them later from the admin portal
instead, once it is up. Buy Points tells the customer to contact
`ADMIN_CONTACT` for now if neither account is configured anywhere.

Deploy, wait for `Schema up to date.` in the logs, then register the webhook
against the service's URL:

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
  npm run webhook set https://fast-fayda.onrender.com
```

Two Render specifics worth knowing. Free instances sleep after fifteen minutes
idle, and Telegram gives a webhook delivery seconds before it gives up and
retries — a sleeping bot answers the first person of the morning late or not at
all, which is why the Blueprint asks for Starter. And a deploy starts the new
container before retiring the old one, so two instances briefly migrate at once;
that is what the advisory lock in `src/db.ts` is for, and it is tested.

If TLS fails with a self-signed-certificate error, do not turn verification
off — put the provider's CA certificate in `DATABASE_CA_CERT` as PEM. The pool
picks it up and keeps verifying.

---

## Points and payments

A print costs points; points are bought by paying into a CBE or Telebirr
account and sending the receipt. The bot accepts all six forms people actually
send — either CBE link, a bare CBE reference, the Telebirr receipt link, a bare
Telebirr id, or the whole SMS pasted in — reduces them to one reference, and
fetches the bank's page to read the amount.

One rule sits under all of it: **a receipt is worth points exactly once**. That
is enforced by a unique index on (provider, reference), not by application code,
so two deliveries racing each other still credit once. The two CBE link forms of
the same payment normalise to the same reference, so sending both does not pay
twice.

The pages being scraped were built for people, not for us, so verification has
three outcomes rather than two:

| Outcome | When | What happens |
|---|---|---|
| credit | page read, amount covers a point | points credited immediately |
| review | page unreachable, or no amount on it | queued, forwarded to the admin chat, customer told it is being checked |
| reject | page read, amount below one point | told the minimum, and the reference is *not* spent |

Only the last is a refusal. A customer who paid is never told they did not
because a bank redesigned a page — that failure lands in a queue instead. An
admin taps Approve, is asked how many points, and both the ledger and the
customer are updated. A second decision on the same payment does nothing.

Only an admin may decide — an `ADMIN_TELEGRAM_IDS` super admin, or someone
granted access from the portal or the chat. It is checked on the callback
itself, not inferred from which chat the button was tapped in — callback data is
attacker-controlled, and anyone can send `adm:ok:<id>` to a bot.

---

## Card retrieval

The OTP buttons run a real flow when `CARD_API_KEY` is set, and say plainly
that retrieval is not connected when it is not.

```
tap OTP 1/2/3  → balance checked first, cost named
send a FAN     → provider sends a code to the phone registered against it
send the code  → JSON verify returns the identity fields
                 → the designed 2600×800 card is drawn and sent first
                 → for every format except "Printable Card", the provider's
                   original PDF is then fetched and sent as a document
```

Every completed verification is verified with **`/verify-otp-json`** first. Its
identity fields are drawn here as the 2600×800 front-and-back picture (photo and
QR included), and that image is the delivery: it goes out before anything else
and cannot be withheld by a later failure. "Printable Card" stops there, because
the picture *is* the card.

For the other formats, the provider's original PDF follows as a second,
best-effort call to **`/verify-otp`**. It is attempted after the image has been
delivered, so the card is already safely in the chat before the provider is asked
for anything else. If the provider refuses it — an already-used code, an outage,
no time left in the request — the customer keeps the image and simply does not
get the PDF. Nothing falls back to artwork rasterised from a PDF, and no A4 sheet
is produced.

That second verify is another point spent upstream; the customer is still
charged one. The previous order (PDF first, JSON second) meant a refused second
call left only the PDF's own artwork, which is the 1524×1200 image this flow
must never send. Image first is the guarantee; PDF second is the bonus.

Although the published docs describe a `{ otp, fanNumber, session }` body, the
live API refuses that with "finNumber is required" (on both endpoints). The bot
only ever collects a 16-digit FAN, so the client derives the required 12-digit
`finNumber` from it — the FAN's last 12 digits — which the live endpoint
accepts.

Three things about it are deliberate:

**The balance is checked before the FAN is asked for.** Sending somebody's
number upstream and only then telling them they cannot afford the result would
spend their privacy for nothing.

**The point is charged on delivery, not on request.** Asking for a code costs
nothing upstream; a verify costs a point, on success. So the customer is
charged when a card exists, and a failed or mistyped code is free.

**The JSON verify happens exactly once per code.** No retry on timeout. A retry
would either spend a second point or fail against an already-used code, and
neither is worth the chance that the first attempt quietly succeeded — so a
verify that does not come back closes the session and tells the admin chat to
check whether a point was spent. The PDF verify that follows is the one
deliberate second call, and its failure costs only the PDF.

The PDF is never stored. It goes straight to the person who asked for it, and
the `card_jobs` row that records the spend deliberately carries no file handle.

The FAN is the one exception to "ID numbers are never stored": the verify call
needs it back alongside the code, so it survives between two messages —
encrypted with AES-256-GCM under a derived key, cleared the moment the session
closes, and gone within ten minutes regardless. See `src/crypto.ts` for exactly
what that protects against.

### The timeout is load-bearing

A verify can take up to two minutes, because the provider is waiting on an
upstream validation of its own. `CARD_API_TIMEOUT_MS` (default 55s) must stay
**below** the platform's function limit — a call killed mid-flight may already
have spent a point, leaving the customer with nothing. `api/webhook.ts` sets
`maxDuration: 60`, which is Vercel Hobby's ceiling. On a plan or platform with
a lower limit, lower both. Render and a VPS have no such limit.

### Where the API comes from

This talks to a commercial reseller (`CARD_API_URL`), not to NIDP directly:
documented endpoints, an issued key, and a points balance that is topped up.
**Whether that reseller holds a valid NIDP relying-party licence is worth
confirming with them in writing** — clean code downstream of an unauthorised
data pipeline is still downstream of it.
[`docs/relying-party-application.md`](docs/relying-party-application.md) covers
applying to NIDP directly, and the eligibility question worth settling either
way.

## What is not connected yet

The two upload paths (Fayda Screenshot, Upload PDF) take a photo or document,
spend `POINTS_PER_PRINT` points, and file it as a pending card job for an admin
to see and mark delivered in the admin portal below. Turning an *uploaded* file
into a printable card — compositing it onto a background template — is not
built, and is not planned: reproducing the card's security background is
forgery whoever asks for it. The OTP flow above needs none of that: it draws the
2600×800 front-and-back card from the identity fields the verify endpoint
returns, then fetches the provider's original PDF when the chosen format wants
it.

---

## Admin portal

A plain web page at **`/admin`**, gated by Telegram's Login Widget rather than
a password: whoever runs a payment or upload review is already identified to
Telegram, so reusing that avoids a second credential to leak. Anyone in
`ADMIN_TELEGRAM_IDS`, or granted from the portal or the bot itself, can sign in
and:

- approve or reject a pending payment (same effect as tapping the button in
  chat — this is the same decision, from a screen instead of a phone)
- see uploaded card jobs and open the image or PDF a customer sent, streamed
  through the server so a browser is never handed the bot token
- mark a job delivered once the card has been produced and sent
- edit the price per point and the CBE and Telebirr receiving accounts
- post an announcement to every user who has started the bot, in one message
  that reports how many it reached
- add or remove admins, if they are a **super admin**

There are two roles. `ADMIN_TELEGRAM_IDS` are **super admins**: they are a
deployment fact, cannot be removed from inside the app, and are the only ones
who may grant or revoke access. Everyone granted later is a regular **admin**,
held in the `bot_admins` table, and can use the panel and the chat tools but not
grow the operator list. A grant requires the person to have started the bot
once, because `bot_admins` refers to `bot_users`.

The same announcement, and the same payment review, are available in chat:
**`/admin`** opens a panel for any admin. It reports the number of users, the
points they hold between them, the pending payment and document counts, and the
card-API account balance (“My points”); its buttons open a **Users** list (each
person's balance, highest first), the pending-payment review queue (each row
carrying the usual Approve/Reject buttons), a **Bank accounts** screen for the
CBE and Telebirr name and number customers are shown (a change there is live for
the very next Buy Points message, and a single `-` clears a field back to the
deployment's value), and a **Post to all users** flow.
A super admin also sees **Add admin** and **Admins** (list with a Remove button
per granted admin). The panel is deliberately in English rather than translated
copy, since its audience is whoever runs the bot; the broadcast text is escaped
before sending, and a chat that has blocked the bot is marked and skipped next
time.

Local setup needs nothing beyond what the bot already requires — signing in
works off the same `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS`. On Vercel,
`vercel.json` rewrites `/admin` and `/admin/*` to the `api/admin.ts` function;
on Render or a VPS, `src/server.ts` answers those paths directly. Either way,
run migration `0003_admin_portal.sql` (part of the normal `npm run migrate`)
before the portal is used — it adds the settings and admin-grant tables.

The session cookie is signed, not stored server-side, so revoking someone is
immediate: removing a Telegram id from `ADMIN_TELEGRAM_IDS`, or revoking a
granted admin, takes effect on their very next request, since membership is
re-checked every time rather than trusted from the cookie.

Prices and receiving accounts set from the portal or the chat panel override the
`POINT_PRICE_ETB` / `CBE_ACCOUNT_*` / `TELEBIRR_ACCOUNT_*` environment
variables — those stay as the fallback a fresh deployment starts with, before
anyone has set real ones.

---

## How it is put together

```
src/
├── server.ts       HTTP: authenticates the webhook, hands updates to the router
├── env.ts          configuration, read lazily and checked once at startup
├── db.ts           pool, transactions, migration runner
├── crypto.ts       AES-256-GCM for the one value that must be stored readable-back
├── bot/
│   ├── router.ts   the conversation — commands, buttons, state machine
│   ├── i18n.ts     every string, am + en
│   ├── fayda.ts    number parsing, hashing, the lookup provider interface
│   ├── card.ts     FAN → OTP → identity, behind a provider interface
│   ├── receipts.ts six receipt formats to one reference; amount extraction
│   ├── payments.ts credit / review / reject, and the receipt fetcher
│   ├── settings.ts price + accounts: portal value, falling back to env
│   ├── api.ts      Telegram Bot API client
│   ├── broadcast.ts one message to every user, shared by the portal and /admin
│   └── store.ts    persistence, behind an interface
└── admin/
    ├── handler.ts        the portal's routes, transport-agnostic
    ├── telegram-auth.ts  Login Widget verification, session signing
    └── html.ts           plain HTML rendering, no framework
migrations/         schema, applied on startup
scripts/            webhook registration and the command menu
tests/              conversation, HTTP surface, and store-against-Postgres
```

`router.ts` is written against the `BotStore` and `BotApi` interfaces rather than
against Postgres and the network, so the whole conversation is testable with
in-memory doubles — which is why `tests/bot.test.ts` can walk 50+ paths through
it in under 100ms. `tests/store.integration.test.ts` covers the SQL those doubles stand in
for, and is skipped unless you point it at a scratch database.

```bash
npm test                                       # unit + HTTP
createdb fast_fayda_test
TEST_DATABASE_URL=postgres://…/fast_fayda_test npm test   # + the store
npm run typecheck
```

---

## Notable decisions

**ID numbers are never stored in plain text.** A lookup is recorded as an HMAC
of the number plus its last four digits — enough for rate limiting, and enough
for support to confirm which attempt someone means. An unkeyed hash would not
do: twelve digits is a small enough space to enumerate in seconds, so hashing
it plainly would be storage in all but name.

The card flow has the one exception, and it is a narrow one by construction: a
FAN is held encrypted for the ten minutes an OTP is outstanding, because the
verify call needs it back. It is cleared the moment that session closes. Saying
"never stored" and then quietly keeping it would be the worse outcome, so this
paragraph exists rather than the simpler sentence.

**Five lookups per fifteen minutes, per person.** Generous for someone checking
their own application and their family's; restrictive for anyone walking the
number space to see whose applications exist.

**Updates are claimed before anything writes.** Telegram redelivers a webhook
until it gets a 2xx, so without a claim on `update_id` one tapped button could
open two support tickets or spend two lookups.

**The webhook answers 200 even when handling fails.** A non-2xx has Telegram
redeliver, so a bug that throws on one update would loop, and an update that
consistently breaks the handler would block the queue behind it. Errors are
logged; deliveries are acknowledged.

**A 403 from Telegram only counts as "blocked" when it says so.** Any proxy or
WAF in front of the service can refuse a request with the same status, and
reading that as "this person blocked the bot" marks live users unreachable every
time the network misbehaves. Found by running it, not by reading it.

**Group chats are ignored.** In a group, every member would see the ID number
being checked.

---

## The copy is ours, not the original's

The wording in `src/bot/i18n.ts` was written for this bot. If you are matching an
existing bot's flow, replace the values there — the keys, structure and layout
are shaped to take them, and `Copy` is a type both language records must satisfy,
so a string added to one language will not compile until the other has it. A
half-translated bot is worse than a monolingual one: it switches language
mid-conversation.

The Amharic deserves a native read before launch.

# Why `vercel.json` looks the way it does

This file holds the reasoning that used to sit in a `"//"` key inside
`vercel.json` itself. It cannot live there: Vercel validates `vercel.json`
against a schema that rejects unknown top-level properties, so the comment key
failed the deployment before the build started, with

```
The `vercel.json` schema validation failed with the following message:
should NOT have additional property `//`
```

Every deployment from 19 Aug 2026 onward failed that way — the config was
never parsed, so no build log was produced either. JSON has no comments and
Vercel accepts no stand-in for them, so the prose lives here instead.

## `builds` is deliberate, not legacy habit

Declaring even one build switches Vercel's zero-configuration detection off
entirely. That is the point of it.

Without it, Vercel found `src/server.ts` — the long-running Node server, which
it reaches from the `start` script through tsconfig's `outDir` — decided this
repository was a server application, and deployed that as the handler for every
path. `src/server.ts` has no default export, because it is a process that
listens rather than a function that returns, so every request answered:

```
Invalid export found in module '/var/task/src/server.cjs'.
The default export must be a function or server.
```

A `functions` key configures functions; it does not stop that detection.
`builds` does. The two entry points cannot be reconciled — one is a process,
the other is a request handler — so the fix is to say which one Vercel is
looking at.

Nothing in this build reaches `src/server.ts`: `api/` imports
`src/webhook.ts` and the bot modules, never the server, so the long-running
entry point is not part of the Vercel build at all. It is still what Render and
Docker run.

With `builds` and no `routes`, each function is served at its own path:
`/api/webhook`, `/api/health`, and `/api/admin`.

## `rewrites`, not `routes`

`rewrites` is additive on top of the above rather than a replacement of it,
unlike the legacy combined `routes` array — which is why this uses `rewrites`.
It gives the admin portal a plain `/admin` URL without touching how
`/api/webhook` or `/api/health` are reached.

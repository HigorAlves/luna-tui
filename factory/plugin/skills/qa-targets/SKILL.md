---
name: qa-targets
description: Resolve WHERE browser QA runs — named targets from the stage input's context.qaTargets (local, staging, preview), credential references (literal | op:// | env:), guard rule
when_to_use: Use before booting the environment in the e2e stage.
---

# QA targets

Browser QA runs against a **target**: `local` (the dev server booted inside the stage container) or a remote URL such as staging or a preview deploy. Targets arrive in the stage input: `context.qaTargets` in `/in/stage.json`, one entry per target with its name, base URL and credential references. Nothing on disk holds them; no registry file is read or written.

**Announce at start:** "I'm using the qa-targets skill to resolve where browser QA runs."

## Target shape

```json
[
  { "name": "local",   "kind": "local",  "baseUrl": null, "healthPath": "/", "guard": false, "users": {}, "login": null },
  { "name": "staging", "kind": "remote", "baseUrl": "https://staging.example.com", "healthPath": "/healthz", "guard": true,
    "users": { "admin": { "username": "env:STAGING_ADMIN_USER", "password": "op://Eng/staging-admin/password" } },
    "login": { "path": "/login", "usernameField": "Email", "passwordField": "Password", "submit": "Sign in", "successPath": "/dashboard" } }
]
```

- `kind` — `local` is booted by `browser-qa` Step 1 (the dev server from `package.json`); `remote` is probed, never provisioned.
- `guard: true` — a shared environment. Mutating scenarios are tagged `@mutating`; on a guarded target they are scored `partial` with note `guarded target` — never silently dropped, never executed.
- `users.<name>.{username,password}` — **references, not values**: a literal, `op://vault/item/field` (1Password CLI, `op read`), or `env:VAR`. They are substituted at run time, inline in the command that consumes them; the resolved JSON is **never written to disk**. Unresolvable ⇒ the affected criteria are `partial` with the reason, never a silent skip.
- `login` — the recipe the Playwright `setup` project follows once per run; the session is saved as `storageState` and reused by every scenario. Field hints match by label or placeholder text.

## Resolution order (every caller, same order)

1. A settled `target` decision in the stage input (`mcp__luna__decision_get {key: "target"}`) → use it silently.
2. Otherwise, in factory mode there is no Target gate: `local` when it is listed (a remote target is a judgment call and is never auto-picked over local); else the first listed target; else, with no targets at all, an ad-hoc `local` whose `baseUrl` is the booted dev server URL.

## After resolution

- `kind: local` → continue to `browser-qa` Step 1 (boot or attach the dev server). Its URL becomes the target's `baseUrl`.
- Ad-hoc `local` without a saved target → an **unauthenticated** run: `users` and `login` are empty, so no credential ever reaches an arbitrary origin. Authenticated QA requires a named target.
- `kind: remote` → probe `curl -sf "<baseUrl><healthPath>"`; failure is an **environment failure** (name, URL, curl exit in `summary`; every criterion `partial`) — stop, never fall back to local silently.
- Hand the driver the **target name**, `baseUrl` and `guard` — never the resolved JSON. Resolution happens **inline, inside the same shell command that consumes it**: `LUNA_TARGET_JSON="$(<build the JSON with references substituted>)" npx playwright test …`, where `env:VAR` becomes `"$VAR"` and `op://…` becomes `$(op read 'op://…')`. Every tool call is a fresh shell, so an exported variable from an earlier call is gone; and a standalone resolve prints plaintext passwords into the transcript, which is written to disk.

**Iron rule — never resolve credentials as their own command.** Substitution only ever happens inside the `$(…)` of the command that needs the values. If a step seems to need the resolved values to reason about (which user, which URL), read the references from `context.qaTargets` — they name the user and the source, not the secret.

## Redaction rules (iron)

- Resolved credentials appear in no packet file: not `steps.md`, not `qa-manifest.json`, not the stage answer. Reference the user by its target name (`as admin`).
- The Playwright `setup` project records no video and no trace so the password is never typed on camera; scenario traces contain the session cookie only — acceptable for test environments, noted in `steps.md` as `Auth: storageState from setup project (user: admin)`.
- `op://` reads go through `op read` only; the value is never cached.

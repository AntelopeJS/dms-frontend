---
covers:
  - package.json
  - templates/vue/index.html
docs:
  - docs/1.introduction.md
---

# Smoke

The fixed journey every verdict runs, whatever the diff touches: the renderer serves the dashboard of a fresh platform, the administrator signs in through the rendered form and stays signed in across a reload.

## Sub-features

- `smoke`: onboard through the API, sign in through the form, open Settings, reload and still be signed in.

## How to get to it (user POV)

- `ajs dms start` serves the dashboard; open its URL and sign in.

## Driving it with dms-control

```bash
dms-control journey "$RUN" smoke
```

## Gotchas

- The sign-in form renders on the server and hydrates after load; a click that lands first reloads the form. `signin.mjs` waits for the page to settle and signs in again when the form stays on `/auth`.
- The run serves the renderer checkout (`--renderer`), so `smoke` also proves the checkout builds and starts in the dms playground.

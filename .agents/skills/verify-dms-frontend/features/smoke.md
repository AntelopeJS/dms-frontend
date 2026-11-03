---
covers:
  - package.json
docs:
  - docs/1.introduction.md
---

# Smoke

The fixed journey every verdict runs: the renderer serves onboarding, the administrator signs in through the rendered form, a reload keeps the session.

## Sub-features

- `smoke`: onboard, sign in through the form, open Settings, reload.

## How to get to it (user POV)

- `ajs dms start` serves the dashboard; open the Local URL.

## Driving it with dms-control

```bash
dms-control journey "$RUN" smoke
```

## Gotchas

None.

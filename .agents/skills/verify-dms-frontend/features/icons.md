---
covers:
  - templates/vue/icon-api.mjs
  - templates/vue/icon-bundle.ts
  - templates/vue/icon-hydration.ts
  - templates/vue/icon-scan.mjs
  - templates/vue/server/favicon.mjs
  - templates/vue/server/icons.mjs
  - templates/vue/ui-lazy-icons.mjs
docs:
  - docs/6.rendering/4.icons.md
---

# Icons

The browser never asks a third party for an icon. The frontend server serves collections at `/api/_dms/icons/<prefix>.json`, draws icons on the server and sends each once per page in a hidden sprite.

## Sub-features

- `the-icon-route-answers-iconify-json-from-the-installed-collections`: Iconify JSON for `lucide` and `ph`, `not_found` for a missing name, the documented `Cache-Control`, `HEAD` allowed, a write refused with 405.
- `the-icon-route-refuses-unknown-collections-and-bad-names`: 404 for an unknown collection, 400 for names outside Iconify's rule, both `no-store`.
- `one-sprite-draws-each-icon-once-and-no-third-party-is-asked`: one `svg#dms-icon-sprite`, every `<use>` points at a symbol, symbols are unique and fewer than the uses, and the hydrated page requests only the frontend and the backend.
- `a-signed-out-page-loads-the-icon-bundle-only-when-the-visitor-acts`: the sign-in page requests no `virtual_nuxt-ui-icons` chunk while idle and one after a key press; a signed-in page has requested it by `load`.

## How to get to it (user POV)

- Every dashboard page shows icons; `curl -sI "$WEB/api/_dms/icons/lucide.json?icons=house"`.

## Driving it with dms-control

```bash
dms-control journey "$RUN" icons
```

## Gotchas

- An empty entry in the list (`house,,star`) is accepted and skipped; the docs do not name it.

## Not driven

- Which icons the Nuxt UI bundle holds (6.4): its content is not read; its timing is driven (`a-signed-out-page-loads-the-icon-bundle-only-when-the-visitor-acts`) and the origins of the run's requests are checked.
- Collections other than `lucide` and `ph` through `@iconify/json` (6.4): the workspace ships only these two, so the playground has no other.
- The browser fetching an icon no installed collection holds (6.4 Server rendering): no playground page declares one.
- Flip and rotation symbols (6.4 sprite): no page the journeys reach flips or rotates an icon.

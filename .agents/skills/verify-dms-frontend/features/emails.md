---
covers:
  - templates/vue/email-locales.ts
  - templates/vue/email-markup.ts
  - templates/vue/email-renderer.ts
  - templates/vue/email-runtime.ts
  - templates/vue/server/email-bundle-watch.mjs
  - templates/vue/server/email.mjs
  - templates/vue/vite.email.config.ts
docs:
  - docs/5.frontend-modules/9.emails.md
---

# E-mails

The frontend server renders the DMS's e-mail templates when the backend asks: complete HTML with no Vue hydration comments, links built on the dashboard's origin, and a route that only accepts the backend's signed render requests.

## Sub-features

- `a-rendered-email-carries-no-hydration-markers-and-links-to-the-dashboard`: the password-reset and invitation messages the sink captures are HTML documents without `<!--[-->`, `<!--]-->` or `<!---->`; the invitation's sign-up link starts with `DMS_CLIENT_BASE_URL`; `POST /api/html/render` without a valid service token answers 401.
- `the-render-route-takes-one-signed-single-use-token-per-render`: a signed token renders the template once; a replayed token, one signed with another secret, an unknown template and an empty name are refused with the documented bodies; the language header picks the catalog and an unknown language renders English.
- `an-email-logo-is-on-the-public-dashboard-url-the-variable-names`: a built module sets an e-mail logo and the project configures another `clientBaseUrl`; the rendered invitation's logo starts with `DMS_CLIENT_BASE_URL` when it is set and with the project's value when it is not. Both reach the render as the one public option `dms.clientBaseUrl`, with the variable first (`email-renderer.ts`, `defu(variable, publicConfig)`).
- A valid render is driven with a signed token (`the-render-route-takes-one-signed-single-use-token-per-render`), the language header and the unknown-language fallback included. The same journey as the logo one (`an-email-logo-is-on-the-public-dashboard-url-the-variable-names`) also renders the fixture's `Probe` template: Outlook's conditional comments and a plain comment stay byte for byte, and a second module of higher priority wins with its `app/app.config.ts` (`tone=high`) over the first module's e-mail `appConfig` and layer config (`tone=email`, `tone=layer`), while the first module's own keys stay (`only=layer`).

## How to get to it (user POV)

- Sign-in page "Forgot password"; Settings, Workspace, Members, Invite members.

## Driving it with dms-control

```bash
dms-control journey "$RUN" emails
```

## Gotchas

- The captured message is read raw from the sink and decoded from quoted-printable.

## Not driven

- A corrupt or missing catalog failing the render (5.9): `dist/server/locales/` would have to be damaged in the run's build.
- The e-mail bundle build in development, its 60 second wait and the low priority child (5.9): development only; the run serves a production build.
- The size budget of `verify-source` (5.9): owned by the verify-source feature.

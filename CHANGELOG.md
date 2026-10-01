# Changelog

## v0.3.7

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.6...v0.3.7)

### 🩹 Fixes

- **server:** Log a hint when the frontend refuses oversized request headers ([#74](https://github.com/AntelopeJS/dms-frontend/pull/74))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.5...v0.3.6)

### 🩹 Fixes

- **dev:** Answer 500 with Vite's error for a module that fails to transform ([#69](https://github.com/AntelopeJS/dms-frontend/pull/69))
- **range:** Report a refused range cleanly in verify-source and name each layer by its path ([#70](https://github.com/AntelopeJS/dms-frontend/pull/70))
- **manifest:** Refuse a manifest the backend serves even when a cache exists ([#71](https://github.com/AntelopeJS/dms-frontend/pull/71))
- **dev:** Report the port the system picked when -p 0 asks for any port ([#72](https://github.com/AntelopeJS/dms-frontend/pull/72))

### 💅 Refactors

- Drop the unused runtime exports, an orphan doc comment and inline requires ([#73](https://github.com/AntelopeJS/dms-frontend/pull/73))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.4...v0.3.5)

### 🩹 Fixes

- **renderer:** Let an app.config.ts edit reach the server render in development ([#67](https://github.com/AntelopeJS/dms-frontend/pull/67))
- **vue:** Serve icons from the frontend server instead of the Iconify API ([#68](https://github.com/AntelopeJS/dms-frontend/pull/68))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.3...v0.3.4)

### 🩹 Fixes

- **vue:** Localise Nuxt UI built-in strings with the DMS locale ([#66](https://github.com/AntelopeJS/dms-frontend/pull/66))

### 🏡 Chore

- **lint:** Check @antelopejs/interface-* ranges ([#65](https://github.com/AntelopeJS/dms-frontend/pull/65))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.2...v0.3.3)

### 🚀 Enhancements

- **workspace:** Refuse a frontend module whose range excludes this release ([#59](https://github.com/AntelopeJS/dms-frontend/pull/59))

### 🩹 Fixes

- **dev:** Render an edited component on the server without a restart ([#55](https://github.com/AntelopeJS/dms-frontend/pull/55))
- **dev:** Refresh every file derived from the layers without a restart ([#56](https://github.com/AntelopeJS/dms-frontend/pull/56))

### ✅ Tests

- **email:** Treat a catalog read mid-rebuild as not rebuilt yet ([#58](https://github.com/AntelopeJS/dms-frontend/pull/58))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.3.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.1...v0.3.2)

### 🩹 Fixes

- **server:** Track render scopes through the public Vue API ([#54](https://github.com/AntelopeJS/dms-frontend/pull/54))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.0...v0.3.1)

### 🩹 Fixes

- **server:** Clean error pages, server-side access redirects and dev email bundle ([#41](https://github.com/AntelopeJS/dms-frontend/pull/41))
- **server:** Resilient dev server and network-error feedback ([#42](https://github.com/AntelopeJS/dms-frontend/pull/42))
- **server:** Stop the production server from keeping every render it serves ([#44](https://github.com/AntelopeJS/dms-frontend/pull/44))
- **dev:** Release the reserved port while a client is connected to it ([#48](https://github.com/AntelopeJS/dms-frontend/pull/48))
- **dev:** Apply translations changed in a layer without a restart ([#49](https://github.com/AntelopeJS/dms-frontend/pull/49))
- **server:** Pass the manifest's secrets to the frontend server ([#53](https://github.com/AntelopeJS/dms-frontend/pull/53))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.3.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.8...v0.3.0)

### 💅 Refactors

- **vue:** ⚠️  Remove the useColorMode shim ([#43](https://github.com/AntelopeJS/dms-frontend/pull/43))

#### ⚠️ Breaking Changes

- **vue:** ⚠️  Remove the useColorMode shim ([#43](https://github.com/AntelopeJS/dms-frontend/pull/43))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.8

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.7...v0.2.8)

### 🩹 Fixes

- **vue:** Resolve server-rendered async components before hydrating ([#32](https://github.com/AntelopeJS/dms-frontend/pull/32))
- **router:** Keep the page mounted when only the query or hash changes ([#37](https://github.com/AntelopeJS/dms-frontend/pull/37))
- **vue:** Share cookie refs and read them from the rendered request ([#36](https://github.com/AntelopeJS/dms-frontend/pull/36))
- **vue:** Match active links on path segments ([#35](https://github.com/AntelopeJS/dms-frontend/pull/35))
- **vue:** Resolve a single @vueuse/core aligned with Nuxt UI ([#31](https://github.com/AntelopeJS/dms-frontend/pull/31))

### 📖 Documentation

- **readme:** Import components rendered inside <svg> directly ([#38](https://github.com/AntelopeJS/dms-frontend/pull/38))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.2.7

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.6...v0.2.7)

### 🩹 Fixes

- **ssr:** Define __VUE_PROD_DEVTOOLS__ for the external vue-i18n build ([#39](https://github.com/AntelopeJS/dms-frontend/pull/39))
- **server:** Announce when the frontend server is ready ([#33](https://github.com/AntelopeJS/dms-frontend/pull/33))

### 💅 Refactors

- **build:** Merge tsconfig.build.json into tsconfig.json ([#27](https://github.com/AntelopeJS/dms-frontend/pull/27))

### 🤖 CI

- **release:** Release next from a dedicated branch and restore requireCommits ([#28](https://github.com/AntelopeJS/dms-frontend/pull/28))
- **release:** Reference the shared release workflows through v1 ([#29](https://github.com/AntelopeJS/dms-frontend/pull/29))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))
- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.5...v0.2.6)

### 🩹 Fixes

- **workspace:** Keep dev-rewritten declaration files out of Tailwind's scan ([#26](https://github.com/AntelopeJS/dms-frontend/pull/26))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.4...v0.2.5)

### 🩹 Fixes

- **verify-source:** Remove the generated workspace on exit ([#25](https://github.com/AntelopeJS/dms-frontend/pull/25))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- **layers:** Expose the layer alias convention as a public helper ([#24](https://github.com/AntelopeJS/dms-frontend/pull/24))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.2...v0.2.3)

### 🩹 Fixes

- **update-check:** Retry a failed lookup after an hour, not a day ([#22](https://github.com/AntelopeJS/dms-frontend/pull/22))
- **windows:** Keep generated specifiers and globs on POSIX separators ([#23](https://github.com/AntelopeJS/dms-frontend/pull/23))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.1...v0.2.2)

### 🩹 Fixes

- **ssr:** Serve styles in the document and stop cold pages reloading the app ([#21](https://github.com/AntelopeJS/dms-frontend/pull/21))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- **cli:** Generate ephemeral dev session secrets ([#19](https://github.com/AntelopeJS/dms-frontend/pull/19))

### 🏡 Chore

- Remove obsolete demo ([#18](https://github.com/AntelopeJS/dms-frontend/pull/18))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## Unreleased

### 🚀 Enhancements

- Generate an ephemeral session secret for `ajs dms dev`; `build` and `start`
  now require an explicit secret. Dev sessions are invalidated on restart.

## v0.2.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.9...v0.2.0)

### 💅 Refactors

- ⚠️  Rename the frontend-module SDK alias to `#dms/frontend-module` ([#16](https://github.com/AntelopeJS/dms-frontend/pull/16))

### 🏡 Chore

- Align community files with the organization defaults ([#15](https://github.com/AntelopeJS/dms-frontend/pull/15))

#### ⚠️ Breaking Changes

- ⚠️  Rename the frontend-module SDK alias to `#dms/frontend-module` ([#16](https://github.com/AntelopeJS/dms-frontend/pull/16))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.9

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.8...v0.1.9)

### 📖 Documentation

- **cli:** Present the loader as `ajs dms <command>` ([#14](https://github.com/AntelopeJS/dms-frontend/pull/14))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.8

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.7...v0.1.8)

### 🚀 Enhancements

- Take /auth/establish endpoints from the frontend manifest ([#13](https://github.com/AntelopeJS/dms-frontend/pull/13))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.7

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.6...v0.1.7)

### 🩹 Fixes

- **cli:** Kill the spawned server with the CLI and explain CSRF 403s ([#12](https://github.com/AntelopeJS/dms-frontend/pull/12))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.5...v0.1.6)

### 🏡 Chore

- Require @antelopejs/core 1.7 ([#11](https://github.com/AntelopeJS/dms-frontend/pull/11))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.4...v0.1.5)

### 🏡 Chore

- Accept AntelopeJS core 2.x as the CLI peer ([#9](https://github.com/AntelopeJS/dms-frontend/pull/9))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.3...v0.1.4)

## v0.1.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- **auth:** Open a session from a module backend endpoint ([#6](https://github.com/AntelopeJS/dms-frontend/pull/6))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **cli:** Load .env from the current directory ([#5](https://github.com/AntelopeJS/dms-frontend/pull/5))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.0...v0.1.1)

### 📖 Documentation

- Position the package as a frontend-agnostic loader ([#4](https://github.com/AntelopeJS/dms-frontend/pull/4))

### 🏡 Chore

- Require AntelopeJS core 1.6.0 as the CLI peer ([#3](https://github.com/AntelopeJS/dms-frontend/pull/3))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.0.1...v0.1.0)

### 💅 Refactors

- ⚠️  Align env var names with the DMS templates ([#1](https://github.com/AntelopeJS/dms-frontend/pull/1))

### 🏡 Chore

- **release:** Skip the npm auth pre-flight for trusted publishing ([#2](https://github.com/AntelopeJS/dms-frontend/pull/2))

#### ⚠️ Breaking Changes

- ⚠️  Align env var names with the DMS templates ([#1](https://github.com/AntelopeJS/dms-frontend/pull/1))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

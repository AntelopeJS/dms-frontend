# Changelog

## v0.9.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.8.0...v0.9.0)

### 🚀 Enhancements

- **build:** ⚠️  Resolve ${@module.VAR} with the function its provider declares ([#192](https://github.com/AntelopeJS/dms-frontend/pull/192))
- **dev:** ⚠️  Read the frontend modules from the project, as build does ([#193](https://github.com/AntelopeJS/dms-frontend/pull/193))
- **locales:** Refuse a catalog message vue-i18n cannot compile ([#190](https://github.com/AntelopeJS/dms-frontend/pull/190))
- **runtime:** IsDmsHydrating(), whether the browser hydrates the page ([#189](https://github.com/AntelopeJS/dms-frontend/pull/189))
- **build:** Report what each frontend module adds to the client entry ([#182](https://github.com/AntelopeJS/dms-frontend/pull/182))

### 🔥 Performance

- **vue:** Stop useColorMode from re-applying the color mode on boot ([#168](https://github.com/AntelopeJS/dms-frontend/pull/168))
- **i18n:** Keep every locale catalog out of the client entry, each one complete ([#181](https://github.com/AntelopeJS/dms-frontend/pull/181))
- **vue:** Render a page that completes its query in place of redirecting ([#194](https://github.com/AntelopeJS/dms-frontend/pull/194))

### 🩹 Fixes

- **start:** Report the modules the build serves, and warn when the project now gives others ([#191](https://github.com/AntelopeJS/dms-frontend/pull/191))
- **server:** Let a client read its 413 before the proxy closes the connection ([#185](https://github.com/AntelopeJS/dms-frontend/pull/185))
- **vue:** Render Nuxt UI key hints the same on the server and in the browser ([#172](https://github.com/AntelopeJS/dms-frontend/pull/172))
- **vue:** Keep a failed page setup from warning about its own template ([#169](https://github.com/AntelopeJS/dms-frontend/pull/169))
- **vue:** Compile props typed with auto-imported types to their runtime type ([#171](https://github.com/AntelopeJS/dms-frontend/pull/171))

### ✅ Tests

- **server:** Stop the servers a test started before removing their directory ([#184](https://github.com/AntelopeJS/dms-frontend/pull/184))
- Check that the workspace receives every template file the application loads ([#183](https://github.com/AntelopeJS/dms-frontend/pull/183))

#### ⚠️ Breaking Changes

- **build:** ⚠️  Resolve ${@module.VAR} with the function its provider declares ([#192](https://github.com/AntelopeJS/dms-frontend/pull/192))
- **dev:** ⚠️  Read the frontend modules from the project, as build does ([#193](https://github.com/AntelopeJS/dms-frontend/pull/193))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.8.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.7.1...v0.8.0)

### 🚀 Enhancements

- **server:** Trust the client address header the hosting platform writes (DMS_CLIENT_IP_HEADER) ([#167](https://github.com/AntelopeJS/dms-frontend/pull/167))
- **server:** Set DMS_CLIENT_IP_HEADER on backend requests to the client resolved ([#173](https://github.com/AntelopeJS/dms-frontend/pull/173))
- **server:** Cap a proxied body with maxBodyBytes (413) and allow hour-long transfers ([#174](https://github.com/AntelopeJS/dms-frontend/pull/174))
- **build:** ⚠️  Build the frontend from the project, without a backend or snapshot ([#177](https://github.com/AntelopeJS/dms-frontend/pull/177))
- **start:** Say whether the backend took the ready report ([#180](https://github.com/AntelopeJS/dms-frontend/pull/180))

### 🩹 Fixes

- **server:** Compile a component's style block before inlining it in the dev document ([#160](https://github.com/AntelopeJS/dms-frontend/pull/160))
- **ssr:** Link the CSS of every component the server rendered ([#162](https://github.com/AntelopeJS/dms-frontend/pull/162))
- **server:** ⚠️  Stop waiting out a backend's 503 (revert #156 and #158) ([#175](https://github.com/AntelopeJS/dms-frontend/pull/175), [#156](https://github.com/AntelopeJS/dms-frontend/issues/156), [#158](https://github.com/AntelopeJS/dms-frontend/issues/158))
- **start:** Compare the build with the backend once it first answers, not only within 10 s ([#178](https://github.com/AntelopeJS/dms-frontend/pull/178))
- **server:** Keep a backend stream that fails from ending the server ([#150](https://github.com/AntelopeJS/dms-frontend/pull/150))
- **server:** Relay the client's time zone and every realtime header to the backend ([#164](https://github.com/AntelopeJS/dms-frontend/pull/164))
- **server:** ⚠️  A session outlives the browser only when written persistent ([#165](https://github.com/AntelopeJS/dms-frontend/pull/165))
- **server:** Import the built SSR renderer by file URL on Windows ([#163](https://github.com/AntelopeJS/dms-frontend/pull/163))
- **server:** Relay backend redirects instead of following them ([#151](https://github.com/AntelopeJS/dms-frontend/pull/151))
- **server:** Relay a backend redirect to the client instead of following it ([#186](https://github.com/AntelopeJS/dms-frontend/pull/186))
- **server:** One redirect option after #151 and #186, and a proxied path in the relative Location test ([#187](https://github.com/AntelopeJS/dms-frontend/pull/187), [#151](https://github.com/AntelopeJS/dms-frontend/issues/151), [#186](https://github.com/AntelopeJS/dms-frontend/issues/186))
- **server:** Drop the duplicate redirect option and proxy /media in the redirect test ([#188](https://github.com/AntelopeJS/dms-frontend/pull/188))

### 📖 Documentation

- **production:** Uploads stop at 100 MB at the Cloudflare edge on AntelopeJS Cloud ([#176](https://github.com/AntelopeJS/dms-frontend/pull/176))

### 🏡 Chore

- ⚠️  Build the renderer with Vite 8 (Rolldown), entry kept in one file ([#161](https://github.com/AntelopeJS/dms-frontend/pull/161))

#### ⚠️ Breaking Changes

- **build:** ⚠️  Build the frontend from the project, without a backend or snapshot ([#177](https://github.com/AntelopeJS/dms-frontend/pull/177))
- **server:** ⚠️  Stop waiting out a backend's 503 (revert #156 and #158) ([#175](https://github.com/AntelopeJS/dms-frontend/pull/175), [#156](https://github.com/AntelopeJS/dms-frontend/issues/156), [#158](https://github.com/AntelopeJS/dms-frontend/issues/158))
- **server:** ⚠️  A session outlives the browser only when written persistent ([#165](https://github.com/AntelopeJS/dms-frontend/pull/165))
- ⚠️  Build the renderer with Vite 8 (Rolldown), entry kept in one file ([#161](https://github.com/AntelopeJS/dms-frontend/pull/161))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Maxime Westhoven <maxime@altab.be>
- Alessandro Aloisio

## v0.7.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.7.0...v0.7.1)

### 🩹 Fixes

- **server:** Wait out a starting backend's 503, not only a waking one ([#158](https://github.com/AntelopeJS/dms-frontend/pull/158))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.7.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.6.4...v0.7.0)

### 🚀 Enhancements

- **cli:** ⚠️  Build a frontend from a snapshot, without secrets or a live backend ([#157](https://github.com/AntelopeJS/dms-frontend/pull/157))

#### ⚠️ Breaking Changes

- **cli:** ⚠️  Build a frontend from a snapshot, without secrets or a live backend ([#157](https://github.com/AntelopeJS/dms-frontend/pull/157))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.6.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.6.3...v0.6.4)

### 🚀 Enhancements

- **server:** Wait out a backend's cold-start 503 for GET and HEAD ([#156](https://github.com/AntelopeJS/dms-frontend/pull/156))

### 🩹 Fixes

- **start:** Run the production server under NODE_ENV=production ([#154](https://github.com/AntelopeJS/dms-frontend/pull/154))
- **ssr:** Name hand-over reads in the dev warning ([#155](https://github.com/AntelopeJS/dms-frontend/pull/155))

### 📖 Documentation

- Clarify learning paths and illustrate real outcomes ([#152](https://github.com/AntelopeJS/dms-frontend/pull/152))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Alessandro Aloisio

## v0.6.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.6.2...v0.6.3)

### 🩹 Fixes

- **deps:** Require core 1.16.0 and current tooling ([#149](https://github.com/AntelopeJS/dms-frontend/pull/149))

### 📖 Documentation

- Make dense guide sections easier to scan ([#148](https://github.com/AntelopeJS/dms-frontend/pull/148))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.6.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.6.1...v0.6.2)

### 🚀 Enhancements

- **vue:** Run a plugin before or after the others with `enforce` ([#140](https://github.com/AntelopeJS/dms-frontend/pull/140))

### 🔥 Performance

- **client:** Start the app from a function so the entry stays one chunk ([#142](https://github.com/AntelopeJS/dms-frontend/pull/142))
- **server:** Send the build's public files with their type, an ETag and a Last-Modified ([#143](https://github.com/AntelopeJS/dms-frontend/pull/143))
- **proxy:** Compress the backend answers the backend sent uncompressed ([#144](https://github.com/AntelopeJS/dms-frontend/pull/144))

### 🩹 Fixes

- **vue:** Keep Nuxt UI's state, toasts included, to the request that set it ([#139](https://github.com/AntelopeJS/dms-frontend/pull/139))
- Stop serving the build manifest ([#138](https://github.com/AntelopeJS/dms-frontend/pull/138))

### 📖 Documentation

- Add the frontend user guide, its env reference check and a dms-frontend skill ([#137](https://github.com/AntelopeJS/dms-frontend/pull/137))
- Remove the 0.6 migration page ([#147](https://github.com/AntelopeJS/dms-frontend/pull/147))
- Make the 0.6 migration page exact and complete ([#141](https://github.com/AntelopeJS/dms-frontend/pull/141))

### 🏡 Chore

- **dev:** Stop pre-bundling vuedraggable by name ([#145](https://github.com/AntelopeJS/dms-frontend/pull/145))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))
- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.6.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.6.0...v0.6.1)

### 🚀 Enhancements

- Report the dms-frontend version when the frontend server is ready ([#136](https://github.com/AntelopeJS/dms-frontend/pull/136))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.6.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.6...v0.6.0)

### 🚀 Enhancements

- ⚠️  Renderer 0.6.0, the server-rendering stack without backward compatibility ([#133](https://github.com/AntelopeJS/dms-frontend/pull/133))

#### ⚠️ Breaking Changes

- ⚠️  Renderer 0.6.0, the server-rendering stack without backward compatibility ([#133](https://github.com/AntelopeJS/dms-frontend/pull/133))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.5...v0.5.6)

### 🤖 CI

- Speed up pipeline and verify-source ([#112](https://github.com/AntelopeJS/dms-frontend/pull/112))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.4...v0.5.5)

### 🩹 Fixes

- **proxy:** Refuse request targets naming another host ([#111](https://github.com/AntelopeJS/dms-frontend/pull/111))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.3...v0.5.4)

### 🚀 Enhancements

- **proxy:** Let modules declare public endpoints and relay If-Match ([#108](https://github.com/AntelopeJS/dms-frontend/pull/108))

### 🩹 Fixes

- **auth:** Surface the backend OAuth error key on provider sign-in failures ([#109](https://github.com/AntelopeJS/dms-frontend/pull/109))
- **email:** Strip Vue hydration markers from rendered emails ([#107](https://github.com/AntelopeJS/dms-frontend/pull/107))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.2...v0.5.3)

### 🩹 Fixes

- **auth:** Scope session cookies to the backend instance ([#106](https://github.com/AntelopeJS/dms-frontend/pull/106))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.1...v0.5.2)

### 🩹 Fixes

- **vue:** Keep route objects stable and compare navigations with the shown URL ([#105](https://github.com/AntelopeJS/dms-frontend/pull/105))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.0...v0.5.1)

### 🩹 Fixes

- **auth:** Honour "keep my active session" and stop account validation from switching the session ([#104](https://github.com/AntelopeJS/dms-frontend/pull/104))

### ❤️ Contributors

- Maxime Westhoven ([@mwesto](http://github.com/mwesto))

## v0.5.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- **sdk:** ⚠️  Prefix registered components and drop private components ([#103](https://github.com/AntelopeJS/dms-frontend/pull/103))

#### ⚠️ Breaking Changes

- **sdk:** ⚠️  Prefix registered components and drop private components ([#103](https://github.com/AntelopeJS/dms-frontend/pull/103))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.4.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.12...v0.4.0)

### 🚀 Enhancements

- ⚠️  Module-declared auto-imports, private components, page loading state, session language and SSR icons ([#101](https://github.com/AntelopeJS/dms-frontend/pull/101))

### 🩹 Fixes

- **server:** Forward the client country header to the backend ([#102](https://github.com/AntelopeJS/dms-frontend/pull/102))

#### ⚠️ Breaking Changes

- ⚠️  Module-declared auto-imports, private components, page loading state, session language and SSR icons ([#101](https://github.com/AntelopeJS/dms-frontend/pull/101))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.12

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.11...v0.3.12)

### 🩹 Fixes

- **verify-source:** Find the DMS core layer in the project ([#100](https://github.com/AntelopeJS/dms-frontend/pull/100))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.11

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.10...v0.3.11)

### 🩹 Fixes

- **cli:** Wrap the dev banner and the clean list to the terminal width ([#99](https://github.com/AntelopeJS/dms-frontend/pull/99))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.10

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.9...v0.3.10)

### 🩹 Fixes

- **cli:** Honor --quiet everywhere and accept -q and --verbose=<channels> after the command ([#98](https://github.com/AntelopeJS/dms-frontend/pull/98))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.9

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.8...v0.3.9)

### 🚀 Enhancements

- **cli:** Frame pnpm install and the production build ([#87](https://github.com/AntelopeJS/dms-frontend/pull/87))
- **dev:** Ready banner, degraded-state warnings and a clean stop ([#88](https://github.com/AntelopeJS/dms-frontend/pull/88))
- **build:** Summary, working next step and no silent stale builds ([#89](https://github.com/AntelopeJS/dms-frontend/pull/89))
- **prepare:** Add --strict and report skipped vs failed on stderr ([#90](https://github.com/AntelopeJS/dms-frontend/pull/90))
- **cli:** Add ajs dms workspaces [--json] and confirm clean --all ([#91](https://github.com/AntelopeJS/dms-frontend/pull/91))

### 🔥 Performance

- **cli:** Lazy-load commands, unzipper and semver; quieter update notice ([#94](https://github.com/AntelopeJS/dms-frontend/pull/94))

### 🩹 Fixes

- **cli:** Exit 130 on Ctrl+C and stop the whole child process tree ([#82](https://github.com/AntelopeJS/dms-frontend/pull/82))
- **cli:** Write feedback to stderr ([#83](https://github.com/AntelopeJS/dms-frontend/pull/83))
- **cli:** Validate options before doing any work ([#84](https://github.com/AntelopeJS/dms-frontend/pull/84))
- **cli:** Explain unreachable and refused backends ([#85](https://github.com/AntelopeJS/dms-frontend/pull/85))
- **verify-source:** Report results without stack traces ([#92](https://github.com/AntelopeJS/dms-frontend/pull/92))
- **cli:** Polish the remaining rough edges from the before/after review ([#95](https://github.com/AntelopeJS/dms-frontend/pull/95))
- **release:** Build before running the tests ([#97](https://github.com/AntelopeJS/dms-frontend/pull/97))

### 💅 Refactors

- **cli:** Adopt @antelopejs/core/cli and drop figlet, boxen and chalk ([#86](https://github.com/AntelopeJS/dms-frontend/pull/86))
- **cli:** Rely on @antelopejs/core 1.13 output helpers ([#96](https://github.com/AntelopeJS/dms-frontend/pull/96))

### 📖 Documentation

- **cli:** Rewrite help text and the environment topic ([#93](https://github.com/AntelopeJS/dms-frontend/pull/93))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.8

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.7...v0.3.8)

### 🩹 Fixes

- **vue:** Read the request's own URL in useDmsRoute() on the server ([#79](https://github.com/AntelopeJS/dms-frontend/pull/79))
- **vue:** Keep the meta a page declared when it reads its route ([#81](https://github.com/AntelopeJS/dms-frontend/pull/81))
- **server:** Serve the frontend's own files before asking the backend ([#80](https://github.com/AntelopeJS/dms-frontend/pull/80))

### ❤️ Contributors

- Alessandro Aloisio

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

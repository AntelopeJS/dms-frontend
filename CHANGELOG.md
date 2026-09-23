# Changelog

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

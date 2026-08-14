# TypeScript + tRPC Opto-Sync E2E

This repository proves a non-Next.js full-stack TypeScript path:

- a standalone tRPC HTTP server performs authoritative merges with the native
  Opto-Sync engine;
- a client queues an offline write in real IndexedDB semantics via
  `fake-indexeddb`;
- the optimistic view crosses the typed tRPC boundary and is acknowledged only
  after the server returns the merged document;
- server-only and client-only nested fields survive the reconciliation.

The `vendor/opto-sync-clients` submodule and its nested `syncer.c` submodule are
immutable test inputs. Their exact commits are repeated in
`opto-sync-pin.json` so drift is reviewable without executing code.

Run the proof with:

```sh
git submodule update --init --recursive
npm ci
npm run check
```

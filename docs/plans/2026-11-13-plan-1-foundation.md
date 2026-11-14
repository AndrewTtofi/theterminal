# Plan 1 — Foundation Implementation Plan

**Goal:** A locally running core server with a tamper-evident, hash-chained decision ledger, an event-sourced project/lifecycle-board model, a secured local HTTP + WebSocket API, and a web UI showing the lifecycle board and live ledger. This is the base every later plan builds on.

**Architecture:** pnpm monorepo, TypeScript everywhere. `@theterminal/shared` holds domain types and zod schemas. `@theterminal/core` is a Node server. Every state change is first appended to an append-only, SHA-256 hash-chained SQLite ledger, and board state is a projection rebuilt from ledger events, so nothing can change state without leaving a ledger entry (spec §5, §8). `@theterminal/ui` is a React/Vite app that the core serves on `127.0.0.1`, protected by a per-install token.

**Tech Stack:** Node ≥ 22 LTS, TypeScript 5 (strict, ESM), pnpm workspaces, better-sqlite3, Fastify 5 + @fastify/websocket + @fastify/static + @fastify/cookie, zod, React 18 + Vite, Vitest + @testing-library/react, Playwright.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md`. This plan covers the Foundation slice of milestone 1 (spec §7 core items 4 and 7, partially). Plans 2–9 cover the rest: agent runtime, intake and glass box, workspace UI, connections and capacity, linked machines, share view, cloud and collaboration, and installers.

## Global Constraints

- License: **Apache-2.0** for the whole repo (spec §8 "open-source licence"; choice is the planner's call).
- Must run on **macOS (Apple Silicon)** and **Windows**; CI runs both (spec §10.4). Linux is not required in CI yet.
- Node ≥ 22, TypeScript `strict: true`, ESM only (`"type": "module"`).
- Package scope `@theterminal/*`; working product name "The Terminal".
- The ledger is **append-only**: no code path may UPDATE or DELETE ledger rows (spec §8 "no agent action may bypass it").
- All state changes go through `BoardService` commands, which append to the ledger **before** updating projections, in the same transaction.
- The server binds **127.0.0.1 only** and rejects any request without the install token (credentials stay with the Owner, spec §8).
- Stages are exactly, in order: `plan`, `design`, `build`, `ship`, `operate` (spec §4.3).
- The default human actor for this plan is `{ kind: "human", id: "owner" }`. Roles arrive in Plan 8.

## Review Focus

1. **Simultaneous writes**: two API requests that append at the same moment must not fork the hash chain. Expected: both entries land with consecutive `seq`, and `verify()` stays ok. (Test in Task 3.)
2. **Tampered database file**: someone edits `ledger.db` directly. Expected: on startup the server detects the broken chain, starts **read-only**, and reports `integrity: "broken"` with the seq. It does not crash and does not keep writing. (Tests in Tasks 3 and 7.)
3. **A random website calling the local API** (CSRF / DNS rebinding). Expected: rejected without the token cookie/header, and rejected when the `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>`. (Test in Task 6.)
4. **Port already in use**: expected to fall back to the next free port and print the real URL. (Test in Task 7.)
5. **Data directory with spaces or non-ASCII characters** (e.g. `C:\Users\Χρήστης\AppData\…`). Expected: works normally. (Test in Task 7.)

---

## File Structure

```
package.json                      # root: workspaces, scripts (build, test, e2e, lint)
pnpm-workspace.yaml
tsconfig.base.json
vitest.workspace.ts
LICENSE                           # Apache-2.0
.gitignore                        # node_modules, dist, *.db, test-results/
.github/workflows/ci.yml          # macos-latest + windows-latest: install, build, test, e2e

packages/shared/src/domain.ts     # Stage, Actor, Project, Card, Board, LedgerEntry types + zod schemas
packages/shared/src/events.ts     # ledger event type names + payload schemas
packages/shared/src/index.ts

packages/core/src/db.ts                       # openDatabase(path) — WAL, foreign keys, migrations
packages/core/src/ledger/canonical.ts         # canonicalJson(value)
packages/core/src/ledger/ledger.ts            # Ledger class: append/list/verify/onAppend
packages/core/src/board/projections.ts        # applyEvent(db, entry) — projection reducer
packages/core/src/board/board-service.ts      # BoardService commands + queries
packages/core/src/server/auth.ts              # token + Host-header guard
packages/core/src/server/routes.ts            # REST routes
packages/core/src/server/events-ws.ts         # WebSocket ledger stream
packages/core/src/server/server.ts            # createServer()
packages/core/src/paths.ts                    # defaultDataDir()
packages/core/src/cli.ts                      # `theterminal start`
packages/core/test/**                         # mirrors src

apps/ui/index.html
apps/ui/src/main.tsx
apps/ui/src/api.ts                # typed fetch client + subscribeLedger()
apps/ui/src/App.tsx               # project picker + board + ledger panel
apps/ui/src/components/ProjectList.tsx
apps/ui/src/components/Board.tsx
apps/ui/src/components/LedgerPanel.tsx
apps/ui/test/**

e2e/board.spec.ts                 # Playwright end-to-end
playwright.config.ts
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `LICENSE`, `.gitignore`, `.github/workflows/ci.yml`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/core/package.json`, `packages/core/tsconfig.json`, `apps/ui/package.json`, `apps/ui/tsconfig.json`, `apps/ui/vite.config.ts`
- Test: `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Produces: root scripts `pnpm build`, `pnpm test` (Vitest across workspaces), `pnpm e2e` (Playwright), `pnpm dev` (core + ui). Workspace packages `@theterminal/shared`, `@theterminal/core`, `@theterminal/ui`.

- [ ] **Step 1:** `git init`, then write all the config files above. The `.gitignore` must include `node_modules/`.
- [ ] **Step 2: Write the smoke test:** `smoke.test.ts` asserts `expect(1 + 1).toBe(2)` so the test harness is proven.
- [ ] **Step 3:** Run `pnpm install && pnpm test`. Expected: 1 test passes.
- [ ] **Step 4:** Make CI run `pnpm install --frozen-lockfile && pnpm build && pnpm test` on `macos-latest` and `windows-latest` with Node 22.
- [ ] **Step 5: Commit:** `chore: scaffold pnpm monorepo with shared, core, ui packages`

---

### Task 2: Shared domain types and schemas

**Files:**
- Create: `packages/shared/src/domain.ts`, `packages/shared/src/events.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/domain.test.ts`

**Interfaces:**
- Produces (exported from `@theterminal/shared`):
```ts
export const STAGES = ["plan", "design", "build", "ship", "operate"] as const;
export type Stage = (typeof STAGES)[number];
export type CardStatus = "todo" | "active" | "blocked" | "done";
export type Actor = { kind: "human" | "agent" | "system"; id: string };
export type Project = { id: string; name: string; pitch: string; createdAt: string };
export type Card = { id: string; projectId: string; title: string; stage: Stage;
  status: CardStatus; createdAt: string; updatedAt: string };
export type Board = { project: Project; columns: Record<Stage, Card[]> };
export type LedgerEntry = { seq: number; id: string; ts: string; projectId: string | null;
  actor: Actor; type: EventType; payload: unknown; prevHash: string; hash: string };
export type NewLedgerEntry = Pick<LedgerEntry, "projectId" | "actor" | "type" | "payload">;
export const GENESIS_HASH = "0".repeat(64);

// events.ts
export type EventType = "project.created" | "card.created" | "card.moved" | "card.status_changed";
export const eventPayloadSchemas: Record<EventType, z.ZodTypeAny>;
//  project.created      { projectId, name, pitch }
//  card.created         { cardId, title, stage }
//  card.moved           { cardId, from: Stage, to: Stage }
//  card.status_changed  { cardId, from: CardStatus, to: CardStatus }
export const actorSchema, projectInputSchema /* {name: 1..120 chars, pitch: 0..500} */,
  cardInputSchema /* {title: 1..200, stage: Stage} */;
```

- [ ] **Step 1: Write failing tests:** `STAGES` equals `["plan","design","build","ship","operate"]`. `projectInputSchema.safeParse({name:""}).success === false`. `cardInputSchema` rejects `stage: "deploy"`. `eventPayloadSchemas["card.moved"]` accepts `{cardId:"c1",from:"plan",to:"build"}` and rejects `to:"nope"`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `domain.ts`, `events.ts` and `index.ts` with zod.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): domain types, stages, event schemas`

---

### Task 3: Hash-chained append-only ledger

**Files:**
- Create: `packages/core/src/db.ts`, `packages/core/src/ledger/canonical.ts`, `packages/core/src/ledger/ledger.ts`
- Test: `packages/core/test/ledger/canonical.test.ts`, `packages/core/test/ledger/ledger.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry`, `NewLedgerEntry`, `GENESIS_HASH`, `eventPayloadSchemas` from Task 2.
- Produces:
```ts
// db.ts
export function openDatabase(file: string | ":memory:"): Database; // better-sqlite3, WAL, runs migrations
// canonical.ts
export function canonicalJson(value: unknown): string; // sorted keys, no whitespace, rejects undefined/functions
// ledger.ts
export type VerifyResult = { ok: true; count: number } | { ok: false; brokenAtSeq: number };
export class Ledger {
  constructor(db: Database, opts?: { now?: () => Date; newId?: () => string });
  append(e: NewLedgerEntry): LedgerEntry;            // throws LedgerReadOnlyError if readOnly
  list(q?: { projectId?: string; afterSeq?: number; limit?: number }): LedgerEntry[]; // ascending seq, default limit 500
  verify(): VerifyResult;
  readOnly: boolean;
  onAppend(fn: (e: LedgerEntry) => void): () => void; // returns unsubscribe
}
export class LedgerReadOnlyError extends Error {}
```
- Table `ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL, project_id TEXT, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`, plus SQL triggers `BEFORE UPDATE`/`BEFORE DELETE ON ledger` that `RAISE(ABORT, 'ledger is append-only')`.
- `hash = sha256(canonicalJson({ seq, id, ts, projectId, actor, type, payload, prevHash }))` as lowercase hex. The first entry's `prevHash` is `GENESIS_HASH`.

- [ ] **Step 1: Write failing tests:**
  - `canonicalJson({b:1,a:{d:2,c:3}}) === '{"a":{"c":3,"d":2},"b":1}'`
  - append 3 entries: `seq` is 1,2,3; `e2.prevHash === e1.hash`; `verify()` is `{ok:true,count:3}`
  - a payload that fails its event schema throws, and nothing is written
  - `db.prepare("UPDATE ledger SET payload='{}' WHERE seq=1").run()` throws `/append-only/`, and so does DELETE
  - tamper: drop the triggers in the test, rewrite seq 2's payload, then `verify()` is `{ok:false,brokenAtSeq:2}`
  - **(Review Focus 1)** 50 appends issued from `Promise.all` of async wrappers, with two `Ledger` instances on the same file: seqs 1..50 with no gaps, `verify().ok === true`
  - `onAppend` listener receives each new entry once; after unsubscribe it receives nothing
  - `readOnly = true` makes `append` throw `LedgerReadOnlyError`
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test ledger`. Expected: FAIL.
- [ ] **Step 3:** Implement. `append` runs inside `db.transaction(...).immediate()`: read the last row, build the entry, hash it, insert. This keeps the chain from forking across connections.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): append-only hash-chained ledger with tamper detection`

---

### Task 4: Event-sourced board (projections + BoardService)

**Files:**
- Create: `packages/core/src/board/projections.ts`, `packages/core/src/board/board-service.ts`
- Modify: `packages/core/src/db.ts` (migration for the `projects` and `cards` projection tables)
- Test: `packages/core/test/board/board-service.test.ts`

**Interfaces:**
- Consumes: `Ledger` (Task 3); `Actor`, `Project`, `Card`, `Board`, `Stage`, `CardStatus`, input schemas (Task 2).
- Produces:
```ts
export function applyEvent(db: Database, e: LedgerEntry): void; // pure projection reducer; ignores unknown types
export class NotFoundError extends Error {}
export class BoardService {
  constructor(db: Database, ledger: Ledger);
  createProject(actor: Actor, input: { name: string; pitch?: string }): Project;
  listProjects(): Project[];                       // newest first
  getBoard(projectId: string): Board;              // every stage key present, cards ordered by createdAt
  addCard(actor: Actor, projectId: string, input: { title: string; stage: Stage }): Card; // status "todo"
  moveCard(actor: Actor, cardId: string, to: Stage): Card;   // no-op (no entry) if already in `to`
  setCardStatus(actor: Actor, cardId: string, to: CardStatus): Card;
  rebuildProjections(): void;                      // truncate projections, replay ledger in seq order
}
```
- Each command validates its input, then in **one** transaction calls `ledger.append(...)` and `applyEvent(db, entry)`.

- [ ] **Step 1: Write failing tests:**
  - `createProject` returns a project, and `ledger.list()` has one `project.created` entry with matching `projectId`
  - `getBoard` on a new project has all 5 stage keys with empty arrays
  - add 2 cards in `plan`, move one to `build`: board shows 1 in plan and 1 in build; ledger has `card.moved {from:"plan",to:"build"}` with the actor
  - moving to the same stage writes no entry
  - unknown cardId or projectId throws `NotFoundError` and writes no entry
  - **rebuild equivalence:** after a mixed sequence of commands, snapshot `getBoard`, run `rebuildProjections()`, snapshot again, and the two are deep-equal
  - if `applyEvent` throws mid-command (inject via a spy), the ledger entry is rolled back too, so the count is unchanged
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test board`. Expected: FAIL.
- [ ] **Step 3:** Implement `projections.ts` and `board-service.ts`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): event-sourced projects and lifecycle board`

---

### Task 5: REST routes

**Files:**
- Create: `packages/core/src/server/routes.ts`
- Test: `packages/core/test/server/routes.test.ts` (Fastify `inject`, auth not registered here)

**Interfaces:**
- Consumes: `BoardService`, `Ledger`.
- Produces `registerRoutes(app: FastifyInstance, deps: { board: BoardService; ledger: Ledger }): void` with:

| Method & path | Body | 2xx response |
|---|---|---|
| `GET /api/health` | — | `{ ok: true, integrity: "ok" \| "broken", brokenAtSeq?: number, readOnly: boolean }` |
| `GET /api/projects` | — | `Project[]` |
| `POST /api/projects` | `{name, pitch?}` | 201 `Project` |
| `GET /api/projects/:id/board` | — | `Board` |
| `POST /api/projects/:id/cards` | `{title, stage}` | 201 `Card` |
| `POST /api/cards/:id/move` | `{to: Stage}` | `Card` |
| `POST /api/cards/:id/status` | `{to: CardStatus}` | `Card` |
| `GET /api/ledger?projectId=&afterSeq=&limit=` | — | `LedgerEntry[]` |

Errors: zod failure → 400 `{error:"invalid_input", issues}`; `NotFoundError` → 404 `{error:"not_found"}`; `LedgerReadOnlyError` → 423 `{error:"ledger_read_only"}`. The actor for every write is `{kind:"human", id:"owner"}`.

- [ ] **Step 1: Write failing tests**, one per row above, plus 400 for `{name:""}`, 404 for an unknown card move, and 423 when `ledger.readOnly = true`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test routes`. Expected: FAIL.
- [ ] **Step 3:** Implement `registerRoutes`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): REST API for projects, board and ledger`

---

### Task 6: Local security guard + live ledger WebSocket

**Files:**
- Create: `packages/core/src/server/auth.ts`, `packages/core/src/server/events-ws.ts`
- Test: `packages/core/test/server/auth.test.ts`, `packages/core/test/server/events-ws.test.ts`

**Interfaces:**
- Produces:
```ts
export const TOKEN_COOKIE = "tt_token";
export function registerAuth(app: FastifyInstance, opts: { token: string; port: () => number }): void;
//  onRequest hook: Host must be `127.0.0.1:<port>` or `localhost:<port>`, else 403 {error:"bad_host"}.
//  Accept the token via cookie tt_token, `Authorization: Bearer <token>`, or `?token=` on GET /.
//  `?token=` on GET / sets cookie (HttpOnly, SameSite=Strict, Path=/) then 302 to `/`.
//  Missing/wrong token on /api/* or the WS route → 401 {error:"unauthorized"}. Constant-time compare.
export function registerLedgerStream(app: FastifyInstance, ledger: Ledger): void;
//  WS GET /api/events?afterSeq=N: first sends every entry with seq > N, then each new
//  append as it happens. One JSON LedgerEntry per message.
```

- [ ] **Step 1: Write failing tests (Review Focus 3):**
  - `/api/projects` with no token → 401; with the Bearer token → 200
  - `Host: evil.example:PORT` with a valid token → 403 `bad_host`
  - `GET /?token=<right>` → 302 with a `Set-Cookie` containing `tt_token`, `HttpOnly` and `SameSite=Strict`; a follow-up request with that cookie → 200
  - wrong token in the query → 401 and no cookie set
  - WS: connect with `afterSeq=0` after 2 appends and receive 2 messages; append a 3rd and receive it; connecting without the token is refused
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server`. Expected: FAIL.
- [ ] **Step 3:** Implement with `@fastify/cookie` and `@fastify/websocket`. Use `crypto.timingSafeEqual` for the token compare.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): token + host guard and live ledger websocket`

---

### Task 7: Server bootstrap and `theterminal start` CLI

**Files:**
- Create: `packages/core/src/server/server.ts`, `packages/core/src/paths.ts`, `packages/core/src/cli.ts`
- Modify: `packages/core/package.json` (add `"bin": { "theterminal": "dist/cli.js" }`)
- Test: `packages/core/test/server/server.test.ts`, `packages/core/test/paths.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–6.
- Produces:
```ts
// paths.ts
export function defaultDataDir(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string;
//  darwin → ~/Library/Application Support/TheTerminal ; win32 → %APPDATA%\TheTerminal ; else ~/.local/share/theterminal
// server.ts
export type RunningServer = { url: string; port: number; token: string; integrity: VerifyResult; close(): Promise<void> };
export function createServer(opts: { dataDir: string; port?: number /* default 4317 */;
  uiDir?: string; token?: string }): Promise<RunningServer>;
//  - mkdir dataDir; open `<dataDir>/ledger.db`
//  - token: opts.token ?? read `<dataDir>/token` ?? generate 32 random bytes hex and write it (file mode 0o600)
//  - ledger.verify(): if broken → ledger.readOnly = true (do NOT throw); /api/health reports it
//  - listen on 127.0.0.1; if the port is in use, try port+1 … port+20
//  - serve uiDir statically at / if given
//  - url = `http://127.0.0.1:${port}/?token=${token}`
// cli.ts: `theterminal start [--port N] [--data-dir P]` → createServer, print the url, close on SIGINT/SIGTERM
```

- [ ] **Step 1: Write failing tests:**
  - `defaultDataDir("darwin", {HOME:"/Users/a"})` → `/Users/a/Library/Application Support/TheTerminal`; `defaultDataDir("win32", {APPDATA:"C:\\Users\\a\\AppData\\Roaming"})` → `C:\Users\a\AppData\Roaming\TheTerminal`
  - start in a temp dir, create a project via fetch with Bearer, close, start again on the same dir: the project is still listed and the token is unchanged
  - **(Review Focus 2)** after closing, open the db, drop the triggers, alter seq 1's payload, then restart: `integrity.ok === false`, `/api/health` reports `integrity:"broken"`, and POST `/api/projects` → 423
  - **(Review Focus 4)** occupy port P with a plain `net` server, start with `port: P`: `running.port === P+1` and the url contains it
  - **(Review Focus 5)** a dataDir under a temp folder named `Δοκιμή ünïcödé dir` starts and persists
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server paths`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then run `pnpm --filter @theterminal/core build && node packages/core/dist/cli.js start --data-dir ./.tmp-data`. Expected: it prints `The Terminal is running at http://127.0.0.1:4317/?token=…`.
- [ ] **Step 5: Commit:** `feat(core): server bootstrap, data dir, startup integrity check, CLI`

---

### Task 8: UI — API client, project list, lifecycle board, ledger panel

**Files:**
- Create: `apps/ui/index.html`, `apps/ui/src/main.tsx`, `apps/ui/src/api.ts`, `apps/ui/src/App.tsx`, `apps/ui/src/components/ProjectList.tsx`, `apps/ui/src/components/Board.tsx`, `apps/ui/src/components/LedgerPanel.tsx`
- Test: `apps/ui/test/Board.test.tsx`, `apps/ui/test/LedgerPanel.test.tsx`

**Interfaces:**
- Consumes: the REST + WS contract from Tasks 5–6 (same-origin; the cookie carries the token).
- Produces:
```ts
// api.ts
export const api: {
  listProjects(): Promise<Project[]>; createProject(i: {name: string; pitch?: string}): Promise<Project>;
  getBoard(id: string): Promise<Board>; addCard(projectId: string, i: {title: string; stage: Stage}): Promise<Card>;
  moveCard(cardId: string, to: Stage): Promise<Card>; health(): Promise<Health>;
};
export function subscribeLedger(afterSeq: number, onEntry: (e: LedgerEntry) => void): () => void; // reconnects with backoff 1s→10s, resumes from last seq
// components
<Board board={Board} onAddCard={(stage, title) => void} onMoveCard={(cardId, to) => void} />
<LedgerPanel entries={LedgerEntry[]} />   // newest first: time · actor · plain-language sentence
export function describeEntry(e: LedgerEntry): string;
//  project.created → `Owner created project "<name>"`
//  card.created    → `Owner added "<title>" to <Stage>`
//  card.moved      → `Owner moved a card from <From> to <To>`
//  card.status_changed → `Owner marked a card <to>`   (Stage names capitalised; agent actors show "Agent <id>")
```
- Layout: the five stage columns, in spec order, side by side. Each card shows its title and a status dot. Each column has an "+ Add" input. Each card has a "Move to…" select (stage moves only; drag-and-drop arrives in Plan 4). The ledger panel sits on the right. A red banner reading "Ledger integrity check failed at entry #N — workspace is read-only" shows whenever `health.integrity === "broken"`.

- [ ] **Step 1: Write failing tests:**
  - `Board` renders 5 column headings in the order Plan, Design, Build, Ship, Operate
  - typing "Detect GPU" in the Plan column's add input and submitting calls `onAddCard("plan","Detect GPU")`
  - choosing "Build" in a card's Move select calls `onMoveCard(id,"build")`
  - `describeEntry` returns the exact strings above for each event type, including the agent-actor variant
  - `LedgerPanel` lists entries newest first
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `App` loads the project list and opens the selected project's board. It updates the board on WS entries for that project by re-fetching `getBoard`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): lifecycle board, project list, live ledger panel`

---

### Task 9: End-to-end — the core serves the UI, and the full flow works

**Files:**
- Create: `playwright.config.ts`, `e2e/board.spec.ts`
- Modify: `packages/core/src/cli.ts` (when `--ui-dir` is omitted, default to the built `apps/ui/dist` resolved relative to the package), root `package.json` (`e2e` script builds first)

**Interfaces:**
- Consumes: `createServer` (Task 7), the built UI (Task 8).

- [ ] **Step 1: Write the failing e2e test:** a global setup starts `createServer({dataDir: tmp, port: 47000, uiDir})` (the port fallback from Task 7 handles collisions) and passes the url. The test then:
  1. opens the url and expects the URL to become `/` (token moved into the cookie)
  2. creates project "Local Model Hub" and sees it selected
  3. adds "Detect GPU" to Plan, then moves it to Build, and sees it in the Build column
  4. the ledger panel shows, newest first: `Owner moved a card from Plan to Build`, `Owner added "Detect GPU" to Plan`, `Owner created project "Local Model Hub"`
  5. a second browser context **without** the cookie, fetching `/api/projects`, gets 401
  6. reloads the page and everything is still there
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Wire the default ui dir and fix whatever the test exposes.
- [ ] **Step 4:** Run `pnpm e2e`. Expected: PASS on macOS. Push and confirm CI is green on both macOS and Windows.
- [ ] **Step 5: Commit:** `test(e2e): full board + ledger flow served by core`

---

## Done when

- `pnpm test` and `pnpm e2e` pass locally and in CI on macOS and Windows.
- `theterminal start` prints a URL. Opening it shows the lifecycle board. Every change appears in the ledger panel live.
- Editing `ledger.db` by hand is detected at the next start, and the workspace goes read-only with a visible banner.

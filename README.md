<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

### Local MongoDB must be a replica set

Claim decisions (approve, reject, withdraw) run in transactions, which
MongoDB allows only on a replica set or a sharded cluster. Atlas always is
one. A local single-node replica set is enough:

```bash
mongod --replSet rs0 --dbpath ./data/db
mongosh --eval "rs.initiate()"   # once
```

and point the app at it with `?replicaSet=rs0`, for example
`MONGODB_URI=mongodb://127.0.0.1:27017/org?replicaSet=rs0`. On a standalone
server the app still starts and logs one warning; claim decisions and the
admin dashboard's page decisions and inbox actions then answer 503. The real-database e2e suites need the same: set
`MONGO_TEST_URI=mongodb://127.0.0.1:27017/org-test?replicaSet=rs0`.

### MongoDB Atlas DNS

The backend normally uses the operating system's DNS configuration. If a local
router, VPN, or ISP resolver rejects the SRV lookup used by a
`mongodb+srv://` connection string, set `DNS_SERVERS` to comma-separated DNS
resolver IP addresses:

```dotenv
DNS_SERVERS=1.1.1.1,8.8.8.8
```

The override is applied before Mongoose starts its connection. Leave the
variable empty or unset on hosts whose normal DNS resolver supports Atlas SRV
records.

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov

# unit coverage followed by API end-to-end tests
$ npm run test:all
```

Unit coverage enforces 100% statements, branches, functions, and lines across
the controllers, guards, services, content rules, and other executable business
logic listed in `package.json`. Framework bootstrap/modules, DTO declarations,
Mongoose schema declarations, and static seed data are verified by builds,
validation tests, schema tests, and the API E2E suite rather than counted in the
unit coverage denominator.

## Member email notifications

Members get a **daily digest** of new activity (comments and replies, suggested
rewordings, beliefs reaching the agreed list) and **immediate** emails for claim
decisions and moderation of their comments; admins get the admin inbox's
notices (immediate for claims and reports, in the digest otherwise). Emails say
only that there is something new, with a link: never a member's text, name or
reason. Every email has a signed one-click unsubscribe link
(`POST /api/v1/notifications/unsubscribe`) and a link to the settings page.

There is no external scheduler. The server sends on start (so a sleeping free
instance catches up when it wakes), every hour while awake, and right after an
event that wants an immediate email. A digest is claimed by a unique
(member, UTC day) row in `notificationdigests`, so two instances never send the
same day twice. `emailbudget` counts sends per UTC day against
`EMAIL_DAILY_LIMIT`, digests stopping `EMAIL_IMMEDIATE_RESERVE` short; what
does not fit waits for the next day. Admins see the day's count in the
dashboard's Settings. Addresses are read from Clerk when an email is sent and
never stored. Sending is off until `RESEND_API_KEY` and a sender are set; until
then notifications are only queued. A notification still unsent three days
before its 30-day expiry is marked failed and counted on the dashboard; this
sweep runs first in every pass, at start-up too, even with sending off. A row
being sent at that moment is left alone. ⚠️ A server that sleeps longer than
those three days without waking can still have the database delete rows
before the sweep sees them (MongoDB's TTL monitor runs without the app).

A send that may have happened is retried byte for byte under the same key
only while every check (settings, the reader's access, admin status) still
allows exactly that email; otherwise nothing is sent and the row is marked
"withdrawn after unknown send". The 23-hour limit counts from when the first
send under a key started, recorded before the send.

On Render, set `NODE_ENV=production`: the Resend SDK and Express print more
detail when it is unset. This backend already routes the SDK's own error
lines through its logger, redacted, so that setting is a second guard.

Offering-order emails are counted in the same day (never refused), so
notifications yield to them. A send whose outcome is unknown (timeout,
network, 5xx) is retried under the same Resend idempotency key with the same
stored body; only a definite refusal (a 4xx with Resend's error) gets a new
key. Resend keeps keys 24 hours, so an ambiguous send is not retried after
23 hours: it is marked failed rather than risk a duplicate.

`PUBLIC_API_URL` is this backend's origin, e.g.
`https://org-backend.example.org`; a trailing slash or `/api/v1` is accepted
and removed. A bad value is logged at start-up and ignored (emails then link
to the website's unsubscribe page, without one-click).

## Search (Chunk 15)

`GET /api/v1/search?q=&type=all|members|beliefs|pages&page=` searches member
display names, belief titles and text, and the published ORG pages. Comments
are not searched. It is public; a signed-in reader is recognised from the
token. Answers are `no-store` and vary on `Origin, Authorization`; a visitor
gets 30 searches a minute; a query is at most 100 characters.

**Who sees what.** `MembersService.searchScope` runs `decideProfileAccess` on
every listable page: a page the directory lists can be found by its name (a
reader with name-only access gets the name and nothing else, as on its
directory card); a page the reader may read in full can be found by its
beliefs. Unlisted, pending, removed and deleted pages are found by nobody,
admins included. This filter runs INSIDE the aggregation, before grouping,
counting and paging (`search-pipeline.ts`), so neither page 2 nor the total
can reveal anything else. With it, each indexed copy must be exactly what the
site shows now: the current name; a live tab and its current title; the
newest version of a live block of that tab, and only a block the page shows
(once the tab's first text block has been edited, the others are leftovers
and are never returned: the page's own `visibleFieldBlocks` rule); the
published revision of a CMS page, in this site's copy. Snippets are cut only
from text that passed it. On the test site (`SITE_ENV=test`) CMS pages are
indexed with real payment accounts removed, exactly as the test site serves
them, and a copy made for the other site is never shown.

**Engines.** The copies live in `searchentries`, refreshed from the source
collections (at most every 15 s while searched; everything every 6 h, in the
background). Each copy keeps `folded`: lower case, accents folded, split into
words. Every engine searches that field with the query folded the same way,
so "café" and "cafe" find each other everywhere and a quote or a leading `-`
is never an operator. Atlas Search (`$search`) is used when its index exists
and is queryable; otherwise `$text`; otherwise, if even the text index is
missing, a regex. All three run behind the same filter. A missing or building
index is logged once and never fails a search.

**Indexes to create before production.** `npm run db:indexes -- --confirm
<database>` creates the managed indexes, including the `$text` fallback
`search_text_fallback` on `searchentries.folded`, and tries to create the Atlas
Search index too: it creates the collection first if needed, and reports
`unsupported` where the server refuses. With `MANAGE_INDEXES=create` the
server also tries at start-up and at every 5-minute check while the index is
missing (it never drops one). The Atlas Search index, if made by hand in the
Atlas UI (JSON editor), on database `<database>`, collection `searchentries`:

```json
{
  "name": "search_entries",
  "definition": {
    "mappings": {
      "dynamic": false,
      "fields": {
        "folded": { "type": "string", "analyzer": "lucene.whitespace" }
      }
    }
  }
}
```

`lucene.whitespace` because the text is already folded and split by the
backend; a folding analyzer would only repeat that, and could split words
differently from the `$text` and regex engines.

**Suggested Fragments.** `GET /api/v1/search/fragments`. A window is a fixed
run of `SEARCH_FRAGMENT_WINDOW_DAYS` days (default 30); a person counts once
per window, however many days they search and however often the server
restarts. Two things are stored:

- `searchtermwindows`: term, window number, number of different searchers.
  Deleted by TTL once the next window has ended.
- `searchfragmentpairs`: one row per (searcher, term, window) whose `_id` is
  `<window>|HMAC(windowKey, searcher + term)`, and an expiry one day after the
  window ends (the same for every row of a window). No term, no searcher and
  no other time is stored, and two rows of one person are unrelated hashes.

**Privacy property.** `windowKey = HMAC(serverSecret, "search-fragments|" +
window)`, and `serverSecret = HMAC(CLERK_SECRET_KEY, "org-search-fragments-v1")`
(`fragment-keys.ts`). The secret is in the host's settings, never in the
database, so the database alone cannot recover a searcher, cannot test whether
a given address or account searched a term, and cannot even tell which term a
pair row is about. Nothing outlives its window by more than a day.

- **No new setting:** `CLERK_SECRET_KEY` is already required on every site. The
  derivation is domain-separated, so the derived key is useless for anything
  else.
- **Rotating the Clerk secret resets the counting:** a new key, so everyone
  counts as new in the current window. Old pair rows simply expire.
- **Fragments stay off without it:** if `CLERK_SECRET_KEY` is empty, nothing
  is counted, the Perforated Index shows its built-in suggestions, and this is
  logged once.
- **Residual exposure, stated plainly:** anyone holding BOTH the database and
  the Clerk secret can recompute the keys and test, exhaustively:
  - every member (`user:<Clerk id>`; the ids are in the database) against
    every counted term;
  - every IPv4 address (about 4 billion) against a term, for guests.

  This reveals who searched which counted term in the current and previous
  windows; the TTL removes older rows. The Clerk secret already grants full
  administration of every user account, so whoever holds it has more than
  this anyway. On a replica set the oplog also briefly shows a pair row and a
  term count written together. The privacy property holds against the
  database ALONE (a leaked backup or a database user), not against the host's
  secrets.

**Per-searcher limit.** One searcher adds at most 50 different terms per
window. The limit is kept in memory only (a restart resets it), for up to
100,000 searchers per window. When that is full, the searcher first counted longest
ago is forgotten, so new searchers are always counted. A forgotten searcher could
add up to 50 terms again, but only after 100,000 other new searchers have
arrived. The store is therefore bounded by roughly 50 rows per searcher per
window, on top of the 30 searches a minute rate limit. A term is checked for public content before
anything is written, so searches for private or empty terms store nothing.

**When a term is suggested.** Its count in the current window, or in the
window just before it, reaches `SEARCH_FRAGMENT_MIN_SEARCHERS` (default 5).
The two counts are never added. The term must also:

- have EVERY word of it, as a phrase, in belief text or an ORG page a
  signed-out reader can see now. A member's name or a belief title never
  counts.
- pass the shape check (3–40 letters, digits, spaces, hyphens, apostrophes;
  at most four words; no long numbers or `@`);
- be neither hidden nor contain a hidden word or phrase (whole words).

The full check over the candidates is reused for at most a minute while
nothing it depends on changed: the candidates, the guest scope (read on every
request) and the search index (every write or delete counts). Even then, each
term it showed is checked again on every request through the same live
visibility filter as a search. A term whose page went private, or whose
belief was removed, edited or moderated, is never served, whether or not the
indexer has run. That is at most 8 small queries a request.

**Admins** see and hide terms at `/api/v1/admin/search-fragments`: any
fragment-shaped term, listed or not. Hiding a word also keeps out every term
containing it. Each change is in the moderation log.

**An earlier collection.** An earlier build of this chunk wrote
`searchtermdays`. Nothing reads it now; its TTL empties it within 31 days,
and it can then be dropped by hand.

## Timestamp anchoring (Chunk 16)

Every belief version (`blockversions`) and site comment version
(`commentversions`) is hash-chained when saved. Once a day the server puts
every version not yet anchored into a Merkle tree and gets two independent
time-stamps for its root: an RFC 3161 token from **FreeTSA** and an
**OpenTimestamps** proof (Bitcoin). Only the 32-byte root leaves the server,
then the calendars' own commitments when a pending proof is upgraded.

**One run at a time.** Every run (the hourly scheduler, an admin's
`POST /api/v1/admin/anchors/run`, any server instance) first takes a single
lock document (`anchorrunlocks`, `_id: anchoring-run`) under a 10-minute
lease. It renews the lease before each step (resume, sweep, build, each
FreeTSA or OpenTimestamps call) and before each anchor it resumes or sweeps,
so the lease runs out only when one such unit of work takes 10 minutes or
the run has died. A run that finds the lock held does nothing and reports
`busy: true` (the admin view says so); a run that loses it part-way stops
before its next unit of work and reports `interrupted: true`; a holder that
died is taken over once its lease runs out. If releasing the lock fails, the
failure is logged with the time the lock frees itself, and the run's own
result or error is returned unchanged. The per-anchor leases stay as a second
line of defence.

**What a receipt calls a time-stamp.** A FreeTSA token, or an OpenTimestamps
proof once it is confirmed in a Bitcoin block; an unconfirmed proof gives no
time yet, and the receipt says so. A receipt reads as time-stamped only when
every version in it holds at least one of these; versions holding different
ones are named as such.

**Version hash** (unchanged since Chunks 3 and 9). SHA-256 of the UTF-8 bytes
of `JSON.stringify([scheme, id, seq, text, authorUserId, createdAt, prevHash])`,
JavaScript's JSON with no spaces, `createdAt` as ISO-8601 UTC with
milliseconds (`2026-11-14T06:25:40.000Z`), `prevHash` the previous version's
hash (64 zeros for the first). `scheme` is `org-blockversion-v1` (`id` is the
block id), `org-commentversion-v1` (`id` is the comment id), or
`org-blockversion-v2-suggestion` for a belief version accepted from a
suggestion, which appends `suggestionId` and `suggestedBy` to the array. A
receipt carries this exact string when it may (see below), so no
reimplementation of the encoding is needed.

**Merkle tree, `org-anchor-merkle-v2`.**

- leaf = SHA-256(`0x00` ‖ versionHash ‖ salt), each as its 32 raw bytes;
  `salt` is 32 random bytes made for that version when it is anchored and
  kept only on the server (`anchorleaves.salt`). v1 (no salt) was never
  deployed: its leaves let a reader test a guessed author id offline;
- node = SHA-256(`0x01` ‖ left ‖ right);
- leaves are sorted ascending by leaf hash (bytes, i.e. lowercase hex
  order), duplicates removed;
- a level with an odd number of nodes carries its last node up unchanged; it
  is never paired with itself;
- one leaf: the root is the leaf.

A path is a list of `{side, hash}` from the leaf up: `L` means
parent = node(hash, current), `R` means parent = node(current, hash).

**Time-stamps.** The RFC 3161 request's message imprint is the root itself
(SHA-256 algorithm), with a 64-bit nonce and `certReq`. A token is stored only
after it verifies here: the imprint and nonce match, the CMS signature over
the signed attributes is valid, the signing-certificate attribute names the
signer, the signer has the time-stamping purpose and was valid at the stamped
time, and it chains to FreeTSA's root, which is pinned in
`src/anchoring/freetsa-certs.ts` (SHA-256 of `cacert.pem` 2151b611…4438, of
`tsa.crt` 8bfb0305…3467, as published on freetsa.org). The whole
TimeStampResp is stored, so `openssl ts -verify -in` reads it as is. The
OpenTimestamps root is submitted to the calendars in `OTS_CALENDARS` (each on
its own; one is enough); the answers are merged into one standard detached
`.ots` proof for the root (file-hash operation SHA-256, digest = root).

**Schedule.** No external scheduler: one run when the server starts (Render's
free instance sleeps, so a wake catches up) and hourly. From
`ANCHOR_HOUR_UTC` the day's anchor is made, at most one per UTC day:
`timestampanchors._id` is the date. Versions saved in the last two minutes
wait for the next day (inserts in flight). A failed provider is tried again
after 1 h, doubling up to 24 h; a pending OpenTimestamps proof is asked about
every 6 h until one calendar returns a Bitcoin attestation, then never again.
An admin can run it now (`POST /api/v1/admin/anchors/run`): today's anchor
without waiting for the hour, still one a day.

**Never lost, never twice.** No transaction is needed (it also runs on a
standalone server). A version is claimed by an `anchorleaves` row whose `_id`
names it (`b:<id>` or `c:<id>`), so a second claim is a duplicate key; both
collections of versions are append-only, so nothing is written on them. Every
step holds a lease on its anchor row and writes its result only while the
lease is still its own; a crashed holder's lease runs out (10 min building,
5 min per provider step) and the next run takes over. Every run first
finishes any EARLIER day's build that died after claiming its versions, from
those claims, before making today's. A batch looks back one day before the
previous anchor's cutoff, for an insert that landed late. One day holds at
most 50,000 versions, the oldest first, belief and comment versions merged by
time; when the cap is reached the anchor records the oldest version it had to
leave (`resumeFrom`) and the next day's batch starts there, so the rest go to
the next day and none falls out of every window. The health view reports any
version older than the newest cutoff that no BUILT anchor holds: never
claimed, or claimed by a build that never finished (a build still holding
its lease is in progress, not a failure).

**Verification.** `GET /api/v1/admin/anchors` re-runs every check on every
anchor and reports each as pass / fail / cannot-measure: the leaves rebuild
the stored root; every leaf's version exists, its fields still give its hash,
and that hash is the anchored one; the FreeTSA token verifies for the root;
the `.ots` proof commits to the root and holds at least one attestation
(one that commits but attests nothing is "cannot measure"). An empty anchor
(nothing to anchor that day) passes as "nothing to anchor" unless it holds
a claim or a reach-back point (then "cannot measure"); one that holds leaves,
a root, a TSA token or an OTS proof FAILS every check. Whether the
Bitcoin block itself contains the proof is always "cannot measure" here (no
Bitcoin node). The view is paged, 30 anchors a page (`?page=`); its totals
are labelled as being for that page only. Coverage is over every version.
Beside them, cheap counts over EVERY anchor: how many exist, how many are
unfinished (still building, FreeTSA not granted, or OpenTimestamps not yet
accepted), how many failed a check when last checked, and how many were never
checked, and how many could not be measured when last checked, with the
date of the oldest stored check. Each anchor's last check is stored on it
when its page is viewed, so these are only as fresh as the last view of that
page; the oldest date shows how stale they may be.

Checking the Bitcoin part yourself, as measured on 2026-11-14 with the
reference JavaScript client (`opentimestamps` 0.4.9) on a proof our calendars
had confirmed: `ots-cli.js verify <file>.ots` printed "Could not connect to
local Bitcoin node", then "Lite-client verification, assuming block … is
valid" and "Success! Bitcoin block 975755 attests existence", so that client
works without a node by trusting a public explorer. Without any client
feature: `ots-cli.js info <file>.ots` printed
`verify BitcoinBlockHeaderAttestation(975755)` and
`# Bitcoin block merkle root c484ebc9…0500d9`, and
`https://blockstream.info/api/block/<hash of block 975755>` gave the same
`merkle_root`. The receipt's README gives both routes. The Python client was
not run here (see Chunk 16 notes).

**Receipts.** `GET /api/v1/members/profiles/:slug/tabs/:tabId/receipt`
(`?field=text|title&seq=N`; omitted: the current text),
`GET /api/v1/members/profiles/:slug/comments/:commentId/receipt` and
`GET /api/v1/members/org-pages/:pageId/comments/:commentId/receipt`
(`?seq=N`) return the receipt as JSON; the same path plus `/download` returns
a zip with `receipt.json`, a `README.txt` of the exact commands, and per
version `text.txt`, `hash-input.json`, `root.txt`, `anchor.tsr`, `anchor.ots`,
with FreeTSA's two certificates. Who may have a receipt is decided by the
same code that decides who may read that history; anyone else gets the
history's own 404.

**Who gets the hash material.** A version hash covers its text, time,
previous hash and author's Clerk id. Given the text, the time and that hash
(or even a 12-character prefix of it), anyone holding a candidate Clerk id
could confirm the author offline with one SHA-256. Three levels:

- **Complete** (the exact hash input, which holds the Clerk id): only the
  author, an ORG admin, or a version with no person in it (imports, recorded
  first titles). Clerk ids never reach anyone else.
- **Hashes** (version hash, previous hash, salt, leaf, path, both proofs; no
  Clerk id): a reader who may know who the author is, i.e. the author's page
  is approved, NOT under a nickname, and visible to this reader at least by
  name (the rule that decides whether a comment shows its author's name).
  They can check hash → leaf → root → proofs; their receipt says the step
  from the text to the hash needs the author's complete receipt.
- **Leaf only** (text, time, salted leaf, path, both proofs): everyone else.
  The leaf cannot be tested against a guess without the salt; the receipt
  says it proves only that the version's sealed fingerprint existed by then.

**The whole chain counts.** Version k's hash commits to versions 1..k
through `prevHash`, and a reader knows every other input of later versions
(text, time, block or comment id, seq: all public). So any hash material of
version k, or a history hash prefix of it, lets them test a guess about the
author or suggester of ANY earlier version. Hash material for version k is
therefore given only when every person (author and suggester) on versions
1..k of that chain may be known to the reader (or is the reader, an admin,
or a system record); otherwise version k is "leaf only" for them, even for
its own author. Example: an owner who accepted a rewording from a member
with a nickname gets no hash material for that version or any later one;
an admin still does. The same rule now hides the 12-character
hash prefixes in belief and comment HISTORY (from Chunks 8 and 9) from readers
who may not know the author.

Remaining assumption, stated plainly: the salt stays secret on the server. A
reader who obtains the database (or a complete receipt from someone allowed
one) can still test guesses for that version.

Receipts are served from a per-anchor cache of the tree and the two proof
checks (built anchors never change; the key includes the root and both
proofs' bytes, at most 200,000 leaves in all). The admin health view never uses it and
re-checks everything, so a leaf list altered behind an unchanged root is
caught there. An
imported version says "imported from Apple Pages; originally written before
<import date>". A version not anchored yet says so. 20 receipts a minute per
visitor.

**Indexes to create before production** (`npm run db:indexes`):
`timestampanchors` `{tsa.status: 1}`, `{ots.status: 1}`; `anchorleaves`
`{anchorId: 1}`, `{versionId: 1}`. Chunk 16b adds `anchorlogleaves` `{day: 1}` (unique)
and the `anchorlogcheckpoints` collection. The `_id` of each is its key. The
`blockversions.createdAt` and `commentversions.createdAt` indexes already
exist (Chunks 3 and 9).

**Environment** (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `ANCHORING_ENABLED` | `true` | `false`: no timer, and "run now" answers 409 |
| `ANCHOR_HOUR_UTC` | `3` | UTC hour from which the day's anchor is made |
| `FREETSA_URL` | `https://freetsa.org/tsr` | https only; trust stays pinned to FreeTSA's root |
| `OTS_CALENDARS` | the four public calendars | comma-separated https addresses |
| `ANCHOR_HTTP_TIMEOUT_MS` | `20000` | per request; 2 tries per run |

Upgrades are fetched only from calendars on the reference client's whitelist
(`*.calendar.opentimestamps.org`, `*.calendar.eternitywall.com`,
`*.calendar.catallaxy.com`, https, no port), whatever a calendar answered.

## Anchor log (Chunk 16b)

Each daily anchor stands alone, and every anchor lives in the same database
as the content it vouches for. So a writer with full database access could
delete an honest day and re-stamp a forged one, and nothing left in the
database would contradict it (the Chunk 17 residual). The anchor log closes
that the way Certificate Transparency (RFC 9162), Go's checksum database and
Sigsum do: one append-only Merkle log, signed checkpoints, and a copy of the
latest checkpoint kept OUTSIDE this server, against which everything is
checked.

### What it is

- **One leaf per finished day**, in the order the days finished: the leaf is
  SHA-256(0x00 ‖ the canonical day record) and nodes are SHA-256(0x01 ‖ L ‖
  R), the RFC 6962 tree (`src/anchoring/tlog.ts`, inclusion and consistency
  proofs from RFC 9162 §2.1.3–2.1.4, tested against the RFC 6962 vectors of
  Google's Go library `transparency-dev/merkle`). The day trees of Chunk 16
  are unchanged.
- **The day record** (`src/anchoring/day-record.ts`, `org-anchor-day-v2`)
  holds only hashes, counts and a time, never text or ids:

  ```
  org-anchor-day-v2
  day 2026-11-14
  tree org-anchor-merkle-v2
  root <the day's Merkle root, hex>
  leaves <how many versions>
  leafset <SHA-256 of the day's whole leaf list, hex>
  appended <when this server appended it>
  ```

  An empty day is `tree none`, `root none`, `leaves 0`, `leafset none`.
  The tree scheme's version has at most three digits and the root is 64 hex
  digits (review round 3, L4): an anchor with anything else is never
  recorded, and the leaf-set audit reports it as unreadable.
  - `leafset` (review round 1, L3) is SHA-256 over the sorted lines
    `kind versionId versionHash leaf` of the anchor's stored leaves. The day
    root covers only the salted leaf values, so without it a writer could
    rewrite a leaf's version id behind an unchanged root: the honest holder
    of a redaction then hides from every lookup by version id, and a
    re-stamped forgery read as proven (measured: `purge-marks.service.spec.ts`,
    "L3"). The ids are inside a hash, never published.
  - `appended` is the server's clock when the day entered the log.
- **Checkpoints** are C2SP checkpoints (`c2sp.org/tlog-checkpoint`), origin
  `orgspirituality.org/anchors/v1` (or `ANCHOR_LOG_ORIGIN` after a key
  rotation), signed as C2SP signed notes with Ed25519 (node:crypto, no new
  dependency). Keys are in Go's `sumdb/note` formats.
- **When it signs.** A run appends every finished day not yet in the log,
  then signs the new size ONLY when all of these hold:
  - its copy still gives the newest checkpoint it signed (kept in
    `anchorlogcheckpoints`, verified with the key) and the one it signed
    earlier in this process;
  - `ANCHOR_LOG_PUBLISHED_URL` is set, and the published checkpoint was read
    and its copy gives it, and `ANCHOR_LOG_BOOTSTRAP` is NOT set;
  - **or**, for the very first checkpoint only, `ANCHOR_LOG_BOOTSTRAP=1` is
    set, the publication answered 404 (nothing published yet), and this
    server has never signed a checkpoint itself: no row in
    `anchorlogcheckpoints` and none signed by this process (review
    round 3, L1). Once it has signed one, a 404 is `published-missing`
    even with the flag on: publish, then remove the flag.
  - Anything else appends but signs nothing, with a structured reason in
    the run report (`signing: { state: 'blocked', reason }`) and an error in
    the log: `no-key`, `no-url`, `published-unreadable` (a timeout, a 5xx),
    `published-missing` (a 404 without the flag), `bootstrap-on` (the flag
    still set although a checkpoint is published), `inconsistent`.
  - Why a 404 is not "nothing published" (review round 2, H1): GitHub's raw
    host answers 404 for a missing file AND for a missing or renamed
    repository, so an attacker holding the database and the ORG's GitHub,
    or an honest misconfiguration, could make the head "vanish" and get a
    fork signed. Only the owner, in the server's environment, can say
    "nothing is published yet". And a flag left on once something is
    published blocks signing, so a forgotten flag cannot reopen the hole.
  - Review round 1, M1: a writer who rewrote the cache and deleted the
    stored checkpoints, a restart, and one 503 from GitHub used to be
    enough to sign a fork. Without a published URL it never signs: the
    stored checkpoints are in the same database a writer controls.
- **Mongo is only a cache.** `anchorlogleaves` (`_id` = index, `day`
  unique) and `anchorlogcheckpoints` (`_id` = size) are append-only. Each
  anchoring run, inside its run lock, appends and signs before asking
  FreeTSA for the day's stamp. A second appender gets a duplicate key and
  stops; the next run carries on. A log failure is reported in the run's
  report and never stops the anchoring.
- **Publication by pull.** A public repository fetches the checkpoint once
  a day, checks the signature, a consistency proof, and every new day
  record against the signed root, then commits the checkpoint AND the
  records, and OpenTimestamps-stamps it. The server holds no credential
  for it. With the records the repository alone can rebuild and audit the
  whole log, and restore this server's cache (Recovery).

### Endpoints (public, read-only, 20 a minute per visitor)

| Route | Answer |
|---|---|
| `GET /api/v1/anchors/checkpoint` | the newest signed checkpoint, `text/plain`, exactly the C2SP note; **503** with the reasons when none is signed |
| `GET /api/v1/anchors/log` | origin, public key, sizes (this server's, signed, published), the check against the published head, and `startup`: whether the run this start made is `running` or `done` |
| `GET /api/v1/anchors/entries?from=M&to=N` | the day records of entries M..N-1, at most 100 a page (a full page of the widest records is under 32 KB, half the publication job's answer cap; review round 2, M3) |
| `GET /api/v1/anchors/proof/inclusion?day=YYYY-MM-DD[&size=N]` | the day's record, index, leaf hash, audit path and root (base64), in the tree of `N` entries (default: all) |
| `GET /api/v1/anchors/proof/consistency?from=M&to=N` | the RFC 9162 consistency proof, `1 ≤ M ≤ N` |

Sizes are bounded at 1,000,000; a 409 means this server's copy does not
hold together and nothing is given from it (the publication job treats it
as REFUSED).

### How the checks use it

The trust anchors are the log's **public key** (`ANCHOR_LOG_VERIFIER_KEY`,
or derived from the signing key) and the latest **published** checkpoint
(`ANCHOR_LOG_PUBLISHED_URL`, read at most every 5 minutes, failures retried
after 1). Every check (admin health view, each anchor's report, receipts,
the purge marks of Chunk 17) asks where an anchor's day stands:

- Every answer carries a structured `state` (`published`, `pending`,
  `failed`, `cannot-measure`) and a `reason` code; pages decide from those,
  never from the detail text (review round 2, L3). The admin page shows
  `published-missing` and `bootstrap-on` as alerts, and a warning
  whenever `ANCHOR_LOG_BOOTSTRAP` is set (`bootstrap` in the health
  view's log summary and in `GET /anchors/log`, review round 3, L1).
- **published** (pass): its entry is inside the published head, this
  server's copy still gives the published root, the anchor row still gives
  the entry's day, tree, root and count, and the latest leaf-set audit
  found its whole leaf list unchanged. A day appended
  more than a week after its own date is still published, and its detail
  says "appended N days after its day" (review round 1, L2).
- **pending publication** (cannot measure): in this server's log after the
  published head, or finished and not yet appended.
- **fail**, when an anchor is missing from the log although the log holds,
  published, a day appended more than a day after that anchor's signed
  FreeTSA time: an honest run appends a day before stamping it, so this
  row did not come through an append before that publication.
- **fail**, and if ANY published day fails (its anchor deleted, re-rooted,
  relabelled, recounted, or its leaf list changed; entries removed; the
  copy rewritten; a checkpoint signed by another key, a bad signature, a
  fork), **every day fails**: a hidden honest day can back a forgery
  anywhere.
- **cannot measure** without a public key, without a published location,
  or when it cannot be read. Never a pass.

What the log proves, stated exactly (review round 1, L2): the ORDER in which
days entered it and each entry's `appended` time, from the moment that
entry is published. It does NOT prove that a day's activity happened on the
date in its id: a writer who plants an anchor under an unused, valid old
day id before the next run has it appended by the server itself, and it
then reads as published (with the "appended N days after its day" flag).
What it cannot do is hide or replace a day already published.

Purge marks (Chunk 17): an anchor gives a signed time only once its day is
published; before that the row is pending. So the residual "delete an
honest anchor document (or hide it by rewriting its leaves) and re-stamp a
forgery" now FAILS for any day at or before the published head. Receipts
carry `day-record.txt`, `checkpoint.txt` and step 6 (one `openssl` command
per hashing step, ending at the checkpoint's root), and tell the reader to
check the checkpoint with the key in the repository's `log.vkey` or the one
shipped in the website, never a key the receipt itself carries. A failing
log makes a receipt "could not be confirmed". The per-anchor log check is
reported beside the four Chunk 16 checks, not folded into `lastCheck`, so
the claim sweep keeps its rules.

**The leaf-set audit (review round 2, M2).** Catching a leaf list rewritten
behind an unchanged root means reading every anchored leaf (about 213 MB
and 1.7 s for a million leaves, measured by the reviewer). So it is not
done per request:

- each anchoring run audits every leaf list, a few anchors at a time
  (memory: one batch of leaf lists, plus one 64-character hash per day);
- a check whose audit is older than 2 hours starts a new one, at most once
  every 10 minutes whatever the traffic, and a burst shares one;
- with no fresh audit (or one that does not cover a published day yet),
  those days and the whole log check read **cannot measure**, never pass;
- a check that reads an anchor's leaves itself, fresh, on every request
  (the admin health view, the purge marks) compares them with the day's
  record at once.
- A **receipt** does not: it reads an anchor's leaves once and keeps the
  result, keyed by the anchor's root and proofs, not its leaves (re-reading
  every leaf list per receipt is the cost this cache exists to avoid). So
  for receipts a rewritten leaf list falls under the audit window like any
  other check (review round 3, L3; pinned by `receipt.log.spec.ts`, "L3
  (review 3)").

So a leaf list rewritten behind an unchanged root is caught at once by the
admin health view and the purge marks of that anchor, and everywhere else
(receipts included) at the next audit: within the next anchoring run
(hourly while the server is awake) or 2 hours. The
health view and `GET /anchors/log` show the audit's time (`auditedAt`).

### Threat model

Closed: a writer with full access to the database (not to the server's
environment, not to the ORG's GitHub) can no longer delete, rewrite, hide or
re-stamp any day at or before the published head without every check
failing (a rewritten leaf list behind an unchanged root: by the next
leaf-set audit, see above), and can no longer get a checkpoint signed that
forks from the published one. Neither can someone who ALSO holds the ORG's
GitHub but not the server's environment: making the published head vanish
(a 404) stops all signing instead of opening it (review round 2, H1). Only
the owner's `ANCHOR_LOG_BOOTSTRAP` turns a 404 into "nothing published
yet", and only while this server has no checkpoint stored and has signed
none since it started (review round 3, L1).

What remains, stated plainly:

- **The unpublished tail.** Days appended since the last publication are
  protected only by this server's own records: a database writer who
  rewrites those entries AND deletes the checkpoints signed over them
  before the next publication is not caught (the in-memory copy of the
  last checkpoint catches it until a restart). How long that tail is: the
  daily job wakes the server and waits for the run that start makes (it
  builds the day and signs it) before fetching, up to 4 minutes (review
  round 1, L1), so a day built by that wake is published within minutes;
  a day built earlier the same day (the server was already awake at 03:00
  UTC) waits until the 07:17 UTC job, about 4 hours. If that run is slower
  than the wait, or fails, its day waits a full day for the next job.
- **Server and GitHub together.** An attacker holding the signing key (the
  server's environment) and the ORG's GitHub can publish a rewritten log
  before the next daily publication. Even then the OpenTimestamps stamps of
  earlier checkpoints and anyone's clone of the repository expose it
  afterwards.
- **The bootstrap window.** While `ANCHOR_LOG_BOOTSTRAP=1` is set, the first
  checkpoint is signed with no published head to check against: whatever
  the database holds then becomes the start of the log. After that, with
  the flag still on, a 404 signs nothing (L1), and a published head blocks
  signing until the flag is removed. **What is left:** if the owner leaves
  the flag on after the first publication, an attacker who holds the ORG's
  GitHub (to make `latest.txt` 404) AND the database (to delete every row
  of `anchorlogcheckpoints` and rewrite the log), and who strikes after a
  server restart (so the process holds no memory of signing), gets a fork
  signed. The admin page shows a warning for as long as the flag is set;
  the fork would still contradict the repository's history and its
  OpenTimestamps stamps. Remove the flag right after the first publication.
- **Planted days** under unused valid day ids before the next run (above).
- **Publication stopping.** If the daily publication stops (GitHub disables
  scheduled workflows after 60 days with no repository activity; the daily
  commit should count as activity, NOT YET VERIFIED live), new days stay
  "pending publication" for good: honest, never a pass.
- No independent witness yet (c2sp.org/tlog-witness): the publication
  repository is the one outside copy.

### Recovery (review round 1, M2b)

If the anchor log's cache is lost or behind (the database restored from a
backup older than the last publication), rebuild it from a clone of the
publication repository:

```
git clone <the publication repository> /tmp/anchors
npm run build
MONGODB_URI=… ANCHOR_LOG_VERIFIER_KEY=<the key shipped in the website> \
  npm run anchor-log:restore -- /tmp/anchors --dry-run
MONGODB_URI=… ANCHOR_LOG_VERIFIER_KEY=… \
  npm run anchor-log:restore -- /tmp/anchors --confirm <database>
```

**Stop the server first.** The restore takes the anchoring run lock and
refuses while a run holds it (review round 2, L2).

It writes nothing unless the repository's `latest.txt` is signed by that key
(the repository's own `log.vkey` must be the same key) and its `entries/`
reproduce the checkpoint's root exactly. Then it inserts only the missing
entries and the published checkpoint; a cached entry that differs stops it
(back the database up, look, and drop `anchorlogleaves` by hand). Exit 0
done, 1 refused, 2 usage, 3 cannot measure.

After an honest restore from an older backup, the anchors of the days
between the backup and the last publication are gone, so those days FAIL
("in the published log but missing here"). That is the truth: they were
published, and the database lost them. Restore those anchors from a later
backup if one exists. If none does, the loss is permanent and every check
keeps failing: that is an operator decision for the owner, not a switch.
The way forward is a key rotation (below): a new log over what the
database still holds, with the old log frozen as the evidence of what was
lost. There is deliberately no "acknowledge the loss" setting: a database
writer could flip it.

### Key rotation (review round 1, M2c)

A key is never replaced inside a log: C2SP checkpoints are bound to their
origin and key. A rotation starts a NEW log and freezes the old one:

1. Check the old log passes (`/admin/anchors`, Anchor log), and let its
   job publish once more. Then switch its workflow off: v1 is frozen, its
   repository stays public, read-only.
2. Make the new key: `node scripts/anchor-log-keygen.mjs --origin
   orgspirituality.org/anchors/v2 <a new file>`.
3. Back the database up, then drop `anchorlogleaves` and
   `anchorlogcheckpoints` by hand (they are append-only to the app).
4. On Render: `ANCHOR_LOG_ORIGIN=orgspirituality.org/anchors/v2`, the new
   `ANCHOR_LOG_SIGNING_KEY` and `ANCHOR_LOG_VERIFIER_KEY`, and
   `ANCHOR_LOG_PUBLISHED_URL` pointing at a new repository for v2 (its
   `log.json` names v2, its `log.vkey` the new key). The next run appends
   every finished day again, in order, under v2.
5. The v2 repository refuses to publish unless v2 keeps v1 (review round
   2, M4): copy v1's frozen `latest.txt` and `entries/` into the v2
   repository's `previous/`, and pin v1 in its `log.json`:
   `"previous": { "origin": "orgspirituality.org/anchors/v1", "vkey": "<v1 key>", "size": <v1 size>, "root": "<v1 root, base64>" }`.
   Every publication then checks that the vendored v1 is exactly the
   pinned one, signed by the v1 key, and that every v1 day is in v2 with
   the same tree, root, count and leaf set (only `appended` is new);
   otherwise it is REFUSED. `node compare-logs.mjs <v1 clone> <v2 clone>`
   does the same by hand. So the rebuild from the database is re-trusted
   only for days v1 never published. A log's first append is not flagged
   "late": it takes in all of history by construction.
6. Ship the new key and origin in the website (`src/lib/anchor-log.ts`) in
   a commit, so the change is visible in its history.

The server checks only the current log; the frozen v1 repository keeps
proving the old days to anyone, offline, with step 5's script.

### Owner steps

1. **Make the key on your own machine:**
   `node scripts/anchor-log-keygen.mjs <path to a new file>`. It writes the
   private key to that file (refusing to overwrite one) and prints only the
   public key. Put the file's one line in Render as `ANCHOR_LOG_SIGNING_KEY`,
   keep a copy in your password manager, then delete the file (on Windows
   the file is readable by your account and administrators; there are no
   POSIX permissions).
2. **Create the public repository** (e.g. `org-anchor-checkpoints`) from the
   staged files, put the public key in its `log.vkey` and the API address in
   `log.json`, and add the workflow file `.github/workflows/publish.yml`
   yourself.
3. **Set on Render, together:** `ANCHOR_LOG_SIGNING_KEY`,
   `ANCHOR_LOG_VERIFIER_KEY` (the printed public key),
   `ANCHOR_LOG_PUBLISHED_URL` (the raw URL of `latest.txt` in the
   repository) and, for the first publication only, `ANCHOR_LOG_BOOTSTRAP=1`.
   Nothing is signed until the URL is set, and a 404 is "nothing published
   yet" only while the flag is set.
4. **After the first publication, remove `ANCHOR_LOG_BOOTSTRAP`.** While it
   is set, the admin page shows a warning; once a checkpoint is published,
   nothing is signed until it is removed. Publish the first checkpoint
   before the next anchoring run: until then, with the flag on, that run
   appends but signs nothing (`published-missing`).
5. `npm run db:indexes`: `anchorlogleaves {day}` (unique) and the
   `anchorlogcheckpoints` collection.
6. Run the workflow once by hand; ship the public key in the website
   (`src/lib/anchor-log.ts`).

## Data export and page deletion (Chunk 17)

ORG keeps a backend copy of everything for at least five years after a member
deletes their page (plan §2b, D22). This chunk adds the member's own controls
and the automatic purge after those five years.

### Routes

| Route | Who | What |
|---|---|---|
| `GET /me/data` | signed in | the member's page status, undo window, and the delete dialog's wording |
| `GET /me/data/export` | signed in | "Download my data": a zip (`READ-ME-FIRST.txt`, `my-data.txt`, `my-data.json`, `receipts/*.zip`, `picture.webp`). 3 a minute per address, 5 a day per account, `no-store` |
| `POST /me/data/delete-page` `{confirm}` | signed in | "Delete my page"; `confirm` must be the page's address |
| `POST /me/data/undo-delete` | signed in | brings the page back within 30 days |
| `GET /admin/deleted-pages?page=` | admin | deleted pages, next due for purge first |
| `GET /admin/deleted-pages/purge-due` | admin | dry run: the pages and deleted accounts the purge would remove now |
| `POST /admin/deleted-pages/:slug/restore` `{reason}` | admin | restore any deleted page until its five years are up (not one's own) |
| `POST /webhooks/clerk` | Clerk (Svix-signed) | `user.deleted` hides the page like "Delete my page" |

No route takes an account id: the export and deletion act on the signed-in
account only, and an admin's own export is a member's export.

### What deletion does

It sets `deletedAt` and `deletion {at, source, undoUntil?, purgeAfter}` on the
page. Every surface already treats `deletedAt` as gone (page, directory,
search scope, comment author names, notification targets and links). The
search indexer also drops the page's copies on each refresh. Emails waiting
about the page are withdrawn. The admin-removal state is left alone, so an
undo restores the page exactly as it was. Comments the member wrote on other
pages keep their place and text, shown as "A former member". Each change is
one transaction with its moderation-log entry (`page.deleted`,
`page.deletion-undone`, `page.account-deleted`, `page.deletion-restored`).

### The five-year purge

A daily job (an hourly tick that runs once per UTC day, under a run lock in
`purgerunlocks`, logged as `purge.ran`) works on two clocks:

- **A page**, five years after it was deleted (`deletion.purgeAfter`), by its
  member or with their account. The job removes the page's own content:
  - the page row, which stays as "Former member" at `former-<id>`, with no
    owner, contacts, pictures or Apple Pages link;
  - the text of its tabs, blocks and versions, plus tab groups and block
    labels;
  - the search copies and the import record;
  - in other people's comments on the page, what they quote or propose of
    its text (their own words stay).

  The person's comments, votes, claims, consents, settings and moderator
  actions elsewhere are NOT touched: their account may still be live.
- **An account**, five years after Clerk deleted it (`accountdeletions`,
  written by the verified webhook, page or no page). The job removes the
  person everywhere:
  - their comments and comment versions lose text and id but keep their
    place;
  - their id leaves versions they suggested on other pages;
  - their votes stay counted under ids that name no one (each slot stays
    taken, and the account can never vote again);
  - claims, reports filed, consents, inbox notices, contacts, settings and
    queued emails are purged;
  - log entries about them lose the id, the details and the free-text
    reason; other people's entries that merely name them (found by value,
    also inside longer text and up to two levels deep) lose only those
    keys;
  - their own moderator actions keep their place, reason and details under
    one stable label, `system:former-<id of the account row>`.

  From the moment the deletion is recorded the account can no longer write
  (403): comments, suggestions, votes, claims, org-page votes and
  comments, reports, its member page, the EaM request, the
  notification-settings change and joining the membership again (its
  member page cannot be read either). The data export and the 30-day undo
  stay open. So the record's comment list stays complete, also against a
  comment written while the webhook runs: a new comment or suggestion
  writes its account's gate (`userwritegates`, keyed by a hash of the
  Clerk id, expiring a day after its last write) after inserting its row,
  then re-reads `accountdeletions`; the webhook writes the same gate inside
  the transaction that reads the list. MongoDB orders the two writes, so
  either the list holds the comment or the comment is refused (403) and its
  row taken back. A row a repair deleted while its write stalled is put
  back through the same gate. Measured on a real replica set (`member-data-mongo`
  e2e). Like every write here it needs a replica set; on a standalone
  MongoDB the webhook refuses plainly (503).

The integrity structure stays. Version rows keep `seq`, `createdAt`,
`prevHash` and `hash`, and anchor claims (leaf hash and salt) are not
touched, so the chain links and every receipt already handed out still
proves its text.

A purged row can no longer be re-hashed. The anchor checks report it as
**cannot measure**, never pass or fail, but only when BOTH of these hold
(`anchoring/purge-marks.service.ts`):

1. It has the exact purged shape: empty text, `system:purged`, no
   suggester. For a version on a live page whose suggester's account was
   purged, the shape is: text and author intact, suggester removed.
2. Its owner is marked: the page's `deletion.purgeStartedAt`/`purgedAt`, or
   the comment's `purgedAt`.

Anything else, `purgedAt` included, is checked as usual and a mismatch
FAILS. A removed suggester also needs its redaction record, written before the
id is removed. It is accepted only when all of these hold:

- it names its account's `accountdeletions` row, the account's five years
  were up, and its time is one of that row's `purgeRuns` (each purge run adds
  its clock as its very first write, so a retry days later still counts);
- that account has an anchored deletion record (`account-deleted:<row id>`,
  written by the webhook in the same transaction as the row: the row id, the
  time and the sorted ids of the comments the account had authored, never
  the Clerk id), every part intact and anchored, and the suggestion is in
  that list;
- ages are measured by SIGNED time only, never by a date the database
  holds: each anchor's leaves must rebuild its stamped root and its FreeTSA
  token must verify (the Chunk 16 code); the redaction's anchor time (or
  now, while it is unanchored) must be at least five years less one year
  (`DELETION_ANCHOR_MARGIN_MS`, an owner decision) after the latest anchor
  time of the deletion record, and, once it is anchored, no more than five
  years plus one year after it. Put precisely: an honest redaction FAILS
  when the purge's lateness (from five years after the deletion record's
  signed anchor time to the purge run) plus the redaction's own anchoring
  delay (from the purge run to its anchor's signed time) exceeds
  `DELETION_ANCHOR_MARGIN_MS`. An anchor with no verified token leaves the
  row pending while its `builtAt` is within `SWEEP_DAYS` (30 days, Chunk
  16's stray-claim sweep window, NOT a retry cap) and not ahead of the
  clock (five minutes of skew). Chunk 16 never stops retrying the TSA, so
  an honest anchor still unsigned after 30 days reads FAIL from then until
  FreeTSA signs it, and is accepted again afterwards (its signed time is
  then checked like any other). A newer anchor being signed is not used as
  evidence: each anchor has its own TSA backoff and the server may sleep
  through a retry. A record dated more than five minutes in the future
  FAILS, and so does one dated more than five minutes after its anchor's
  signed time (the server's clock and FreeTSA's may differ by that much);
- the anchors are the memory: the redaction's id is derived from its
  version, and honestly that id is in exactly one anchor's tree. So EVERY
  anchor whose stored leaves hold it is checked, whatever its status: it
  must be built and rebuild its root; its entry must be exactly the row's
  hash, and its stored leaf the salted leaf of that hash under the claim's
  salt (the stored hash is outside the signed tree, the leaf is inside it);
  the claim must be in its own anchor's tree, and that anchor must be the
  earliest signed holder. Any other holder FAILS the row, so a redaction
  re-issued after its first anchoring, or a claim deleted while an anchor
  still holds the id, FAILS;
- exactly one block version names the suggestion, and it is this one; an
  accepted suggestion also records the block it wrote
  (`suggestion.resultBlockId`), checked when present;
- its own claim AND the anchor's own leaf for it carry exactly its hash and
  salted leaf. A mismatch FAILS. A claim outside its anchor's tree is stray
  and stays pending until the sweep releases it.

An unclaimed record stays pending, however long the server sleeps or
anchoring is off, until a finished anchor that should have claimed it did not
(built a day or more later, cutoff at or after it, not stopped at the cap
before it, not rescanning it) while no reach point the next build will
honour still reaches it: then it FAILS. Only the newest finished anchor's
rescan or resume point counts, or a rescan point released after that build
(`rescanAt`); a point left on any older anchor is ignored.

**Remaining limits:**

- honest FAIL cases: an honest anchor unsigned past `SWEEP_DAYS` (until
  FreeTSA signs it); a server clock more than five minutes off FreeTSA's;
- a database writer can keep such a row PENDING (never "suggester", never
  a pass) by pointing its claim at a planted anchor with no verified token
  and refreshing that anchor's `builtAt` within the 30-day window;
- someone with write access to the database who tampers with such a version
  of a genuinely deleted account, in the window between its five years
  ending and the honest purge removing the id (normally under a day), can
  turn that tampering into "cannot measure", never into "pass";
- the anchors live in the same database. A writer who DELETES the honest
  anchor document outright (or rewrites its leaves without the redaction and
  recomputes its root), then re-anchors a forged redaction under a fresh
  FreeTSA token (FreeTSA stamps any hash for anyone) whose signed time still
  falls within the upper bound above, is not caught by the per-version
  check: the row reads "cannot measure". The anchor health view FAILS a
  rewritten anchor (its root no longer matches its token); a deleted one
  shows only if other versions it held are left unanchored, which a writer
  can also hide. **Closed by the anchor log (Chunk 16b) for every day at or
  before the published head**: deleting or rewriting a published day's anchor
  FAILS every check, and an anchor gives a signed time only once its day is
  published. Still open: the unpublished tail (see "Anchor log", Threat
  model).

In the anchor health view, an anchor marked `empty` that still holds
leaves, a root, a TSA token or an OTS proof FAILS every check: an honest
empty anchor never had a tree.

Redaction and account-deletion records are ordinary comment-version rows, so
they count against the 50,000-version daily anchor cap and the leaf count like
any version. Receipts of purged versions never include the hash input (the hashes
tier at most), say the content was removed after the retention period, and
carry a "cannot measure" notice.

Each item is marked before the purge starts and marked done by its last
write. Every step is idempotent, and every id a later step needs is read
before the rows it comes from are rewritten, so a run that dies part-way is
finished by the next. Visitor addresses (`visitrecords.ip`) are removed
five years after the visit.

The append-only guard has ONE purge exception (`src/social/purge-rules.ts`).
An `updateMany` gets through only when all of these hold:

- it carries the `purgeExpiredPersonalData` option and is not an upsert;
- its filter is non-empty and limits it to rows not yet done
  (`purgedAt: { $exists: false }`, or a field the update itself rewrites);
- its `$set`/`$unset` holds only that collection's named fields with only
  the allowed values, plus `purgedAt`.

Anything else stays refused. Anchor claims have no purge rule at all.
Mongoose silently strips immutable fields from updates, so the purge passes
`overwriteImmutable` (measured on a real database in
`test/member-data-mongo.e2e-spec.ts`).

### Clerk webhook

In the Clerk dashboard, add an endpoint `https://<api host>/api/v1/webhooks/clerk`
subscribed to `user.deleted`, and set its signing secret as
`CLERK_WEBHOOK_SIGNING_SECRET`. Without it the route answers 503 and the rest
of the site runs as before. Verification uses `verifyWebhook` from
`@clerk/backend/webhooks` (MIT, already a dependency): the signature over the
exact raw bytes, and a timestamp within five minutes. Delivered ids are
remembered for 30 days (`webhookevents`, TTL), so a redelivery is answered
without repeating the work, which is idempotent anyway.

### Before production

`npm run db:indexes` creates `socialprofiles {deletion.purgeAfter}` (partial),
`webhookevents {expiresAt}` (TTL), `accountdeletions {userId}` (unique) and
`{purgeAfter}` (partial), `userwritegates {at}` (TTL, one day), and the
`purgerunlocks` collection. A gate row whose TTL index is missing is still
removed by its account's purge. The account
purge's person indexes (`comments` author, linked user and decider,
`blockversions.suggestedBy`, `notificationqueue.actorUserId`, the log's
person details keys) are plain, not partial: the purge matches by plain
equality, which a `$type` partial index cannot serve.

## Connection requests (Chunk 18)

Members ask to see each other's contact rows (plan §2d item 3). Accepting
changes nothing else: page visibility stays as it is. Not anchored: these are
relationships, not beliefs or comments.

### Routes

| Route | Who | What |
|---|---|---|
| `GET /connections/terms` | anyone | the feature's name, `{singular, plural}` (default "connection request") |
| `GET /me/connections` | signed in | the member's settings and four lists: incoming, outgoing, connected (with contact rows), blocked |
| `GET /me/connections/with/:slug` | signed in | where the member stands with that page's owner: the profile button |
| `POST /me/connections` `{slug, note?}` | member | send a request; the note is at most 500 characters |
| `POST /me/connections/:id/accept\|decline\|withdraw\|disconnect` | member | answer, take back, or end |
| `POST /me/connections/blocks` `{slug}` or `{connectionId}` | member | block; ends everything between the two |
| `DELETE /me/connections/blocks/:id` | member | unblock |
| `PUT /me/connections/settings` `{openTo?, contacts?}` | member | who may send requests; contact rows for connections only |
| `PUT /admin/settings/connection-name` `{singular, plural}` | admin | rename the feature; both empty puts the default back |

Writes are on the member-write ration and the per-visitor limit, and refused
for a deleted account. A note is reported through `POST /me/reports` with
`{targetType: "connection-note", connectionId}` (recipient only); admins hide
it with `POST /admin/moderation/connection-notes/:id/hide {reason}`.

### Rules

- Only a member with an approved page (not removed or deleted, account not
  deleted) sends or receives.
- A Private (unlisted) member may request only a member whose page is Public.
- The recipient's "open to": `nobody`, `public-members` or `any-member`. With
  no choice made, the default follows the page's CURRENT visibility: nobody
  for Private, any member otherwise. Once the member chooses, the choice
  stands across visibility changes.
- At most 20 requests waiting per sender, counting only requests to members
  who still have an approved page; one to a member whose page was removed
  stays in the sender's list as unavailable, and can be withdrawn. If an
  admin restores such a page, its requests count again, so a sender can be
  briefly above 20 (an accepted soft overshoot): further sends are refused
  until the count drops below 20. After a
  decline, the same sender waits 30 days before asking the same member
  again. A withdrawal or an end starts no wait.
- A request nobody answers expires 90 days after it was sent: it leaves the
  recipient's list, stops counting, and starts no wait. An hourly in-app job
  (`ConnectionExpiryScheduler`) expires them, and every read or write that
  depends on it expires the records it touches first.
- A page the requester cannot see is never reachable: every send to it is
  the same 404 as an address with no page (`profile-access.ts`: unlisted is
  owner and admins only). So a Private member only ever sends requests, to
  Public members; their "open to" setting is kept for when they change
  visibility. Lists name a member the reader cannot see only when that
  member wrote to them or they are connected; otherwise "A member".
- On a page the requester can see, the answers come in a fixed order: the
  Private rule (a Private requester and a page that is not Public), then
  the 30-day decline wait, then ONE "not open" for every reason on the
  recipient's side (closed, no approved page, a block either way, one
  landing mid-send). Everything a block could hide is answered first, so a
  block always gives the answer "open to nobody" would give.
  `src/connections/connections.review2.spec.ts` checks every requester ×
  target visibility × open-to × decline wait × block combination.
- A duplicate key on the send counts as a crossing only when it comes from
  the pair index; any other duplicate is passed on.
- A block ends what stands between the two the way a non-block story would,
  as the blocked member sees it: their waiting request as a decline (with
  the 30-day wait), the blocker's request to them as a withdrawal, a
  connection as a disconnect. The end reason "block" is for admins only.
  `connections.review3.spec.ts` compares everything the blocked member can
  observe (button, send, answers on old ids, lists, export, emails) for
  every state a block can land on.
- The send and the profile button share one refusal order
  (`requestRefusal`, `noMemberRefusal`, `liveWith`), checked to agree on
  every combination, a member whose account is gone included: nothing is
  live with a member who no longer counts.
- Expire before act: every entry point that reads or writes connection rows
  (send, answers, disconnect, block, unblock, settings, both views, the
  deletion, the export, reports and the moderation queue) first expires the
  stale requests it touches (`ConnectionRecords.fresh`), so a request past
  its 90 days is never declined, withdrawn, ended, shown or emailed as if it
  still waited. `connections.expire-first.spec.ts` runs every method on a
  stale, unswept request in each direction, beside an unrelated stale pair,
  and checks the method's answer, the request and the other pair.
- "Delete my page" and the account webhook write the member's gate row in
  their transaction. Every write that makes a row live or makes a
  connection (send, a send that crosses a waiting request, accept) runs in
  one transaction that writes both members' gate rows and then checks that
  BOTH still have an approved page on a live account; such a write racing
  a deletion of either member is either ended by it or refused. The
  real-Mongo e2e forces each of those writes against "Delete my page" and
  the account webhook for each party. Decline, withdraw, disconnect and
  block only end rows; unblock and the settings save make no row live
  (shared contacts are read at view time, for connected members who still
  count). An undo within the window brings the page back, never a request.
- A connection email is dropped when the member it is about (the sender of
  a request, the member who accepted) or the member it goes to no longer
  has an approved page. Other email categories are unchanged.
- In the blocker's own export a record their block ended reads "ended",
  with `youBlockedThisMember`; the blocked member's view is unchanged.
  Admins see why a record ended (`endReason`) in the moderation queue; no
  member view or export carries it.
- The Private-to-Public rule holds again at accept time: if the recipient's
  page is no longer Public, the accept is refused and the request closed.
- In a member's own data, a request stopped by a decline (as its sender),
  an expiry, a block, a page gone or that rule reads as one `closed` with one
  `closedAt`, so a blocked member cannot tell. The real status is kept for
  admins.
- One live record per pair, either way round: a partial unique index on the
  sorted pair key where `live` is true. A request crossing one already
  waiting from the other member ACCEPTS that one (both asked); its note is
  dropped. Concurrent sends are measured in
  `test/connections-mongo.e2e-spec.ts`.
- A send runs in a transaction that first writes the sender's
  `connectionsettings.gateAt`, so two sends at once are ordered and the cap
  holds; a block writes both members' gate rows, so a send racing a block
  sees it. Both are fault-injected in the same file.

### Contacts

A connected member sees the other's page contact rows plus the rows kept in
`connectionsettings.contacts` (connections only, never on the page), while
both members have an approved page. Admin-only backup contacts
(`membercontacts`) are never read by this module. A disconnect, a block or a
deletion ends it at once.

### Emails, deletion, export, purge

- Emails (Chunk 14), categories `connectionRequests` and `connectionAccepts`,
  each with its own opt-out and unsubscribe link; digest only. A new-request
  email is at most one per sender, recipient and day; if the request is
  withdrawn and sent again that day, the day's email points at the live
  one, queued again if the digest had dropped it as no longer visible
  (never one more sent email per pair and day). A re-point bumps the queue
  row's `refsVersion`; the digest and the dispatcher drop a row as "no
  longer visible" only while its refs are still what they described. No
  note text, no name.
  The lines and unsubscribe words use the admins' name, read when the email
  is written.
- "Delete my page" and the account webhook end every live request and
  connection (`endReason: page-deleted`) in the deletion's transaction. An
  undo brings the page back, not the connections.
- The export has `connections`: settings, connected members, requests sent
  and received (a received note unless a moderator hid it), and only the
  blocks the member made. Other members appear as the member sees them now.
- The purge: a page's purge removes its owner's requests, settings and own
  blocks, and keeps blocks others made against them (they protect those
  members if the person joins again); an account's purge removes every
  record naming the person.

### Before production

`npm run db:indexes` creates `connections {pairKey}` (unique, partial on
`live: true`), `{fromUserId, status, createdAt}`, `{toUserId, status,
createdAt}`, `{pairKey, status, decidedAt}`, `{createdAt}` (partial on
`live: true, status: pending`, for the expiry sweep; the real-Mongo e2e
checks it is an index scan); `connectionblocks
{blockerUserId, blockedUserId}` (unique) and `{blockedUserId}`;
`connectionsettings {userId}` (unique).

## Heroku deployment

The repository includes a `Procfile` that starts the compiled application with
`npm run start:prod`. Heroku runs `npm run build` during the Node.js build and
provides the runtime `PORT` automatically.

Configure every required value from `.env.example` as a Heroku config var. Do
not set `PORT` yourself. Set `NODE_ENV=production`, and leave optional email
values empty when outbound order email is not configured.

```bash
heroku config:set NODE_ENV=production --app <app-name>
git push heroku main
```

After a deploy, verify both the dyno and the public health endpoint:

```bash
heroku ps --app <app-name>
curl https://<app-name>.herokuapp.com/api/v1/health
```

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

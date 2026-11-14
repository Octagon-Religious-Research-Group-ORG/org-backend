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
(one that commits but attests nothing is "cannot measure"). Whether the
Bitcoin block itself contains the proof is always "cannot measure" here (no
Bitcoin node). The view is paged, 30 anchors a page (`?page=`); its totals
are labelled as being for that page only. Coverage is over every version.
Beside them, cheap counts over EVERY anchor: how many exist, how many are
unfinished (still building, FreeTSA not granted, or OpenTimestamps not yet
accepted), how many failed a check when last checked, and how many were never
checked. Each anchor's last check is stored on it when its page is viewed, so
"failed when last checked" is only as fresh as the last view of that page.

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
could confirm the author offline with one SHA-256. So the hash, the previous
hash, the salt and the exact hash input go only to a reader who may know who
the author is: the author, an admin, a version with no person in it (imports,
recorded first titles), or an author whose page is approved, NOT under a
nickname, and visible to this reader at least by name (the rule that decides
whether a comment shows its author's name). The Clerk id is then visible to
that reader inside the hash input. Anyone else gets the text, the time, the
salted leaf, the path and both proofs: the leaf cannot be tested against a
guess without the salt. Such a receipt says plainly that it proves only that
the version's sealed fingerprint existed by then, and that the link from the
text to it needs the complete receipt. The same rule now hides the 12-character
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
`{anchorId: 1}`, `{versionId: 1}`. The `_id` of each is its key. The
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

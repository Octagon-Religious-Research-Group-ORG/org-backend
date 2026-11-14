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

**Suggested Fragments.** `GET /api/v1/search/fragments`. Only aggregate counts
are stored (`searchtermwindows`: term, window number, number of different
searchers; deleted by TTL once the next window has ended). A window is a
fixed run of `SEARCH_FRAGMENT_WINDOW_DAYS` days (default 30), and a person
counts once per window however many days they search. They are told apart in
memory only, by an HMAC with a random key made when the window starts and
never written down (`searcher-counter.ts`).

*Trade-off.* A truly rolling window would need to remember, for 30 days,
something linkable to each person's searches, on disk or in a sketch whose
key outlives a day. Fixed windows keep that link only in memory and only
until the window ends. In exchange:
- a restart forgets who was already counted (a person searching before and
  after it counts twice);
- each server instance counts on its own;
- up to 50,000 pairs per window are held, after which nobody new is counted.

A term is suggested while its count in the current window, or in the window
just before it, reaches `SEARCH_FRAGMENT_MIN_SEARCHERS` (default 5). The two
counts are never added, so nobody is counted twice. The term must also:
- have EVERY word of it, as a phrase, in content a signed-out reader can see
  now, checked on every request (counted only when this held too);
- pass the shape check (3–40 letters, digits, spaces, hyphens, apostrophes;
  at most four words; no long numbers or `@`);
- not be hidden.

Admins see and hide terms at `/api/v1/admin/search-fragments` (any
fragment-shaped term, listed or not); each change is in the moderation log.

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

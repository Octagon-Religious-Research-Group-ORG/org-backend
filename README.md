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
server the app still starts and logs one warning; claim decisions then
answer 503. The real-database e2e suites need the same: set
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

// The site-replies query must be served by the partial `parentCommentId_1`
// index (Chunk 9 review round 3). Only a real MongoDB can say which index a
// query uses, so this spec needs MONGO_TEST_URI (a throwaway database; it is
// dropped). Without it the suite is reported as SKIPPED, never as passed;
// the query's shape is also asserted in comment-store.spec.ts, which runs
// everywhere.
import mongoose, { Types } from 'mongoose';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { CommentStore } from '../src/members/comments/comment-store';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;

describeWithMongo('comment replies use their index (real MongoDB)', () => {
  let conn: mongoose.Connection;

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) conn.model(name, schema);
    await conn.model('Comment').createCollection();
    await conn.model('Comment').createIndexes();
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('reads the replies of two comments among 5,000 through parentCommentId_1', async () => {
    const profileId = new Types.ObjectId();
    const at = new Date('2026-11-01T00:00:00.000Z');
    const row = (commentId: string, extra: object = {}) => ({
      commentId,
      profileId,
      tabId: 't',
      authorUserId: 'u',
      body: 'x',
      bodySeq: 1,
      source: 'native',
      kind: 'comment',
      createdAt: at,
      updatedAt: at,
      ...extra,
    });
    const docs = Array.from({ length: 5000 }, (_, i) => row(`c${i}`));
    for (const parent of ['c1', 'c2']) {
      for (let i = 0; i < 3; i++) {
        docs.push(row(`${parent}_r${i}`, { parentCommentId: parent }));
      }
    }
    const model = conn.model('Comment');
    await model.collection.insertMany(docs);

    const queries: unknown[] = [];
    const spied = new Proxy(model, {
      get(target, key, receiver) {
        if (key === 'find') {
          return (filter: unknown) => {
            queries.push(filter);
            return target.find(filter as object);
          };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const store = new CommentStore(spied as never);
    const replies = await store.replies(profileId, ['c1', 'c2']);
    expect(replies.get('c1')).toHaveLength(3);

    const siteReplies = queries.find(
      (filter) => (filter as { source?: string }).source === 'native',
    );
    const plan = (await model
      .find(siteReplies as object)
      .explain('executionStats')) as unknown as {
      executionStats: { totalDocsExamined: number; nReturned: number };
      queryPlanner: { winningPlan: unknown };
    };
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
      '"indexName":"parentCommentId_1"',
    );
    expect(plan.executionStats.nReturned).toBe(6);
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(6);
  });
});

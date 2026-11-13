// A fake Mongo connection for services that use `inTransaction`. Named so
// neither the build nor Jest treats it as code or as a test.
/** A session whose `withTransaction` runs the work once, like a commit. */
export function fakeConnection(failure?: unknown) {
  const session = {
    attempts: 0,
    committed: 0,
    aborted: 0,
    ended: 0,
    async withTransaction(work: () => Promise<unknown>) {
      session.attempts += 1;
      // The driver can throw anything; the fake throws what it was given.
      if (failure) throw failure as Error;
      try {
        await work();
        session.committed += 1;
      } catch (error) {
        session.aborted += 1;
        throw error;
      }
    },
    endSession: jest.fn(() => {
      session.ended += 1;
      return Promise.resolve();
    }),
  };
  return {
    session,
    connection: { startSession: jest.fn(() => Promise.resolve(session)) },
  };
}

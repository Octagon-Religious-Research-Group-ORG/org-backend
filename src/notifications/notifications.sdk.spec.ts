// Chunk 14 review N7: the real Resend SDK (not mocked) prints its API
// errors with console.error whenever NODE_ENV is not "production", and the
// server starts with no NODE_ENV. Those lines must go through our logger,
// redacted, instead. Fetch is stubbed: nothing leaves the machine.
import { Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

function config(values: Record<string, string>) {
  return {
    get: (key: string) => values[key],
    getOrThrow: () => 'https://org.example.test',
  } as never;
}

describe('NotificationsService with the real Resend SDK (review N7)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('keeps the SDK’s own error lines off the console, and logs them redacted', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            statusCode: 422,
            name: 'validation_error',
            message: 'Invalid `to` field: someone@example.test',
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ) as never;
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const logged = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const service = new NotificationsService(
      config({
        RESEND_API_KEY: 're_synthetic',
        NOTIFICATION_FROM_EMAIL: 'notices@example.test',
      }),
    );
    const outcome = await service.sendNotice({
      to: 'someone@example.test',
      subject: 'S',
      lines: ['L'],
      headers: {},
      idempotencyKey: 'org-notice-x-0',
    });
    expect(outcome).toBe('refused');
    expect(consoleError).not.toHaveBeenCalled();
    const text = JSON.stringify(logged.mock.calls);
    expect(text).toContain('422');
    expect(text).not.toContain('@example.test');
  });
});

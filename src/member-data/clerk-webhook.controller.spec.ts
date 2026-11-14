import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  ClerkWebhookController,
  WEBHOOK_OFF,
  WEBHOOK_REFUSED,
  WEBHOOK_SECRET_VAR,
} from './clerk-webhook.controller';

// A synthetic signing secret in Clerk's format; never a real one.
const SECRET = `whsec_${Buffer.from('synthetic-test-secret-32-bytes!!').toString('base64')}`;

function signed(
  payload: unknown,
  { id = 'msg_1', at = new Date(), secret = SECRET } = {},
) {
  const body = JSON.stringify(payload);
  const signature = new Webhook(secret).sign(id, at, body);
  return {
    body: Buffer.from(body),
    headers: {
      'svix-id': id,
      'svix-timestamp': String(Math.floor(at.getTime() / 1000)),
      'svix-signature': signature,
    } as Record<string, string | undefined>,
  };
}

const DELETED = {
  type: 'user.deleted',
  data: { id: 'user_gone', deleted: true },
};

function build(secret: string | null = SECRET) {
  const events = fakeModel([], { unique: [['_id']] });
  const deletion = {
    accountDeleted: jest.fn(() => Promise.resolve('deleted')),
  };
  const config = {
    get: jest.fn((name: string) =>
      name === WEBHOOK_SECRET_VAR ? secret : undefined,
    ),
  };
  const controller = new ClerkWebhookController(
    config as never,
    deletion as never,
    events as never,
  );
  return { controller, events, deletion };
}

describe('ClerkWebhookController', () => {
  it('is off, with a 503, while no signing secret is set', async () => {
    for (const secret of [null, '']) {
      const { controller, deletion } = build(secret);
      await expect(
        controller.receive(signed(DELETED) as never),
      ).rejects.toThrow(new ServiceUnavailableException(WEBHOOK_OFF));
      expect(deletion.accountDeleted).not.toHaveBeenCalled();
    }
  });

  it('hides the page of a deleted account, once per delivery id', async () => {
    const { controller, events, deletion } = build();
    await expect(controller.receive(signed(DELETED) as never)).resolves.toEqual(
      {
        received: true,
      },
    );
    expect(deletion.accountDeleted).toHaveBeenCalledWith('user_gone');
    expect(events.docs).toEqual([
      expect.objectContaining({ _id: 'msg_1', type: 'user.deleted' }),
    ]);
    expect(
      (events.docs[0].expiresAt as Date).getTime() -
        (events.docs[0].receivedAt as Date).getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000);
    // Svix redelivers: answered, not repeated.
    await expect(controller.receive(signed(DELETED) as never)).resolves.toEqual(
      {
        received: true,
        duplicate: true,
      },
    );
    expect(deletion.accountDeleted).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad signature, another secret’s signature, and a missing header', async () => {
    const { controller, deletion } = build();
    const tampered = signed(DELETED);
    tampered.body = Buffer.from(
      JSON.stringify({ ...DELETED, data: { id: 'user_victim' } }),
    );
    await expect(controller.receive(tampered as never)).rejects.toThrow(
      new BadRequestException(WEBHOOK_REFUSED),
    );
    const otherSecret = signed(DELETED, {
      secret: `whsec_${Buffer.from('another-synthetic-secret-32bytes').toString('base64')}`,
    });
    await expect(controller.receive(otherSecret as never)).rejects.toThrow(
      new BadRequestException(WEBHOOK_REFUSED),
    );
    const missing = signed(DELETED);
    missing.headers['svix-signature'] = undefined;
    await expect(controller.receive(missing as never)).rejects.toThrow(
      new BadRequestException(WEBHOOK_REFUSED),
    );
    expect(deletion.accountDeleted).not.toHaveBeenCalled();
  });

  it('refuses a replay outside the five-minute window, either side', async () => {
    const { controller, deletion } = build();
    const old = signed(DELETED, { at: new Date(Date.now() - 6 * 60_000) });
    await expect(controller.receive(old as never)).rejects.toThrow(
      new BadRequestException(WEBHOOK_REFUSED),
    );
    const future = signed(DELETED, { at: new Date(Date.now() + 6 * 60_000) });
    await expect(controller.receive(future as never)).rejects.toThrow(
      new BadRequestException(WEBHOOK_REFUSED),
    );
    expect(deletion.accountDeleted).not.toHaveBeenCalled();
  });

  it('refuses a body that was parsed instead of kept raw', async () => {
    const { controller } = build();
    const parsed = { ...signed(DELETED), body: DELETED };
    await expect(controller.receive(parsed as never)).rejects.toThrow(
      new BadRequestException(WEBHOOK_REFUSED),
    );
  });

  it('acknowledges and ignores every other event, and a deletion with no id', async () => {
    const { controller, deletion } = build();
    await expect(
      controller.receive(
        signed(
          { type: 'user.updated', data: { id: 'user_x' } },
          { id: 'msg_2' },
        ) as never,
      ),
    ).resolves.toEqual({ received: true });
    await expect(
      controller.receive(
        signed({ type: 'user.deleted', data: {} }, { id: 'msg_3' }) as never,
      ),
    ).resolves.toEqual({ received: true });
    await expect(
      controller.receive(
        signed(
          { type: 'user.deleted', data: { id: '' } },
          { id: 'msg_4' },
        ) as never,
      ),
    ).resolves.toEqual({ received: true });
    expect(deletion.accountDeleted).not.toHaveBeenCalled();
  });

  it('accepts two deliveries racing to record the same id, and passes on other errors', async () => {
    const { controller, events } = build();
    events.create = () =>
      Promise.reject(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(controller.receive(signed(DELETED) as never)).resolves.toEqual(
      {
        received: true,
      },
    );
    events.create = () => Promise.reject(new Error('db down'));
    await expect(
      controller.receive(signed(DELETED, { id: 'msg_9' }) as never),
    ).rejects.toThrow('db down');
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error on purpose
    events.create = () => Promise.reject(null);
    await expect(
      controller.receive(signed(DELETED, { id: 'msg_10' }) as never),
    ).rejects.toBeNull();
  });
});

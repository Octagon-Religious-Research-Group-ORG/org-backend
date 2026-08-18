/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OrdersService, isOrderTransitionAllowed } from './orders.service';

function query<T>(value: T) {
  const chain = {
    sort: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  chain.sort.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    preferredName: 'Member',
    email: 'member@example.test',
    contactMethod: 'email',
    contactHandle: 'member@example.test',
    shippingAddress: {
      recipientName: 'Member',
      line1: '1 Main St',
      line2: 'Apt 2',
      city: 'Nashville',
      state: 'TN',
      postalCode: '37201',
      country: 'US',
      phone: '555-0100',
    },
    ...overrides,
  };
}

function cartSummary(items: unknown[] = [{ productSlug: 'mesh-tool' }]) {
  return {
    items: items.map((item) => ({
      productSlug: 'mesh-tool',
      productName: 'Mesh Tool',
      variantId: 'standard',
      variantLabel: 'Standard',
      quantity: 2,
      note: 'Blue',
      unitSuggestedDonationCents: 1200,
      lineSuggestedDonationCents: 2400,
      imageUrl: '/mesh.webp',
      ...(item as object),
    })),
    suggestedItemsCents: items.length ? 2400 : 0,
    suggestedShippingCents: items.length ? 1500 : 0,
    suggestedTotalCents: items.length ? 3900 : 0,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'ORG-20260723-ABC123',
    donationMemo: 'ORG ORDER ORG-20260723-ABC123',
    contact: {
      preferredName: 'Member',
      email: 'member@example.test',
    },
    items: [],
    suggestedTotalCents: 3900,
    status: 'awaiting_donation',
    statusHistory: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function dependencies(options?: {
  prior?: unknown;
  created?: unknown;
  profile?: unknown;
  summary?: ReturnType<typeof cartSummary>;
}) {
  const created = options?.created ?? order();
  const model = {
    findOne: jest.fn(() => query(options?.prior ?? null)),
    create: jest.fn().mockResolvedValue(created),
    find: jest.fn(() => query([])),
    findById: jest.fn(() => query(null)),
  };
  const profiles = {
    getDocument: jest.fn().mockResolvedValue(options?.profile ?? profile()),
  };
  const carts = {
    getUserDocument: jest.fn().mockResolvedValue({ id: 'cart-1' }),
    toResponse: jest.fn().mockResolvedValue(options?.summary ?? cartSummary()),
    clearUserCart: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = {
    sendOrderCreated: jest.fn().mockResolvedValue('sent'),
    sendStatusChanged: jest.fn().mockResolvedValue(undefined),
  };
  return { model, profiles, carts, notifications, created };
}

function serviceOf(deps: ReturnType<typeof dependencies>) {
  return new OrdersService(
    deps.model as never,
    deps.profiles as never,
    deps.carts as never,
    deps.notifications as never,
  );
}

describe('order status transitions', () => {
  it('allows the fulfillment happy path, cancellation, and no-op updates', () => {
    expect(
      isOrderTransitionAllowed('awaiting_donation', 'donation_reported'),
    ).toBe(true);
    expect(
      isOrderTransitionAllowed('donation_reported', 'donation_confirmed'),
    ).toBe(true);
    expect(isOrderTransitionAllowed('donation_confirmed', 'preparing')).toBe(
      true,
    );
    expect(isOrderTransitionAllowed('preparing', 'shipped')).toBe(true);
    expect(isOrderTransitionAllowed('shipped', 'completed')).toBe(true);
    expect(isOrderTransitionAllowed('preparing', 'cancelled')).toBe(true);
    expect(isOrderTransitionAllowed('completed', 'completed')).toBe(true);
  });

  it('prevents skipping backward or reopening terminal orders', () => {
    expect(isOrderTransitionAllowed('awaiting_donation', 'shipped')).toBe(
      false,
    );
    expect(isOrderTransitionAllowed('completed', 'preparing')).toBe(false);
    expect(isOrderTransitionAllowed('cancelled', 'awaiting_donation')).toBe(
      false,
    );
  });
});

describe('OrdersService.create', () => {
  it.each([undefined, '', '   '])(
    'requires a non-empty idempotency key',
    async (key) => {
      const deps = dependencies();

      await expect(
        serviceOf(deps).create('user_member', key as string, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deps.model.findOne).not.toHaveBeenCalled();
    },
  );

  it('returns an order previously created with the same key', async () => {
    const prior = order();
    const deps = dependencies({ prior });

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {}),
    ).resolves.toBe(prior);
    expect(deps.profiles.getDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['preferred name', { preferredName: '' }],
    ['email', { email: '' }],
    ['contact handle', { contactHandle: '' }],
  ])('requires the member profile %s', async (_name, missing) => {
    const deps = dependencies({ profile: profile(missing) });

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {}),
    ).rejects.toThrow('Complete your member profile');
  });

  it('requires a shipping address', async () => {
    const deps = dependencies({ profile: profile({ shippingAddress: null }) });

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {}),
    ).rejects.toThrow('Add a U.S. shipping address');
  });

  it('requires at least one cart selection', async () => {
    const deps = dependencies({ summary: cartSummary([]) });

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {}),
    ).rejects.toThrow('offering docket is empty');
  });

  it('snapshots the profile and cart, clears the cart, and sends email', async () => {
    const created = order();
    const deps = dependencies({ created });

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {
        declaredDonationCents: 4000,
      }),
    ).resolves.toBe(created);

    expect(deps.model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderNumber: expect.stringMatching(/^ORG-\d{8}-[A-F0-9]{6}$/),
        ownerSub: 'user_member',
        idempotencyKey: 'key-1',
        declaredDonationCents: 4000,
        status: 'awaiting_donation',
        items: [
          {
            productSlug: 'mesh-tool',
            productName: 'Mesh Tool',
            variantId: 'standard',
            variantLabel: 'Standard',
            quantity: 2,
            note: 'Blue',
            unitSuggestedDonationCents: 1200,
            lineSuggestedDonationCents: 2400,
            imageUrl: '/mesh.webp',
          },
        ],
        contact: {
          preferredName: 'Member',
          email: 'member@example.test',
          contactMethod: 'email',
          contactHandle: 'member@example.test',
        },
        shippingAddress: {
          recipientName: 'Member',
          line1: '1 Main St',
          line2: 'Apt 2',
          city: 'Nashville',
          state: 'TN',
          postalCode: '37201',
          country: 'US',
          phone: '555-0100',
        },
      }),
    );
    expect(deps.carts.clearUserCart).toHaveBeenCalledWith('user_member');
    expect(deps.notifications.sendOrderCreated).toHaveBeenCalledWith(created);
    expect(created.emailState).toBe('sent');
    expect(created.save).toHaveBeenCalled();
  });

  it('recovers the winning order after a duplicate-key race', async () => {
    const winner = order({ id: 'winner' });
    const deps = dependencies();
    deps.model.create.mockRejectedValue({ code: 11000 });
    deps.model.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(winner));

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {}),
    ).resolves.toBe(winner);
  });

  it.each([
    ['duplicate without winner', { code: 11000 }],
    ['ordinary object', { code: 42 }],
    ['null', null],
    ['primitive', 'failure'],
  ])('rethrows a %s create failure', async (_name, failure) => {
    const deps = dependencies();
    deps.model.create.mockRejectedValue(failure);
    if ((failure as { code?: number } | null)?.code === 11000) {
      deps.model.findOne
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(null));
    }

    await expect(
      serviceOf(deps).create('user_member', 'key-1', {}),
    ).rejects.toBe(failure);
  });
});

describe('OrdersService queries and updates', () => {
  it('lists member and administrator orders with filters', async () => {
    const deps = dependencies();
    const memberQuery = query([{ id: 'member-order' }]);
    const allAdminQuery = query([{ id: 'admin-order' }]);
    const filteredAdminQuery = query([{ id: 'filtered-order' }]);
    deps.model.find
      .mockReturnValueOnce(memberQuery)
      .mockReturnValueOnce(allAdminQuery)
      .mockReturnValueOnce(filteredAdminQuery);
    const service = serviceOf(deps);

    await expect(service.listForMember('user_member')).resolves.toEqual([
      { id: 'member-order' },
    ]);
    await expect(service.listForAdmin()).resolves.toEqual([
      { id: 'admin-order' },
    ]);
    await expect(service.listForAdmin('preparing')).resolves.toEqual([
      { id: 'filtered-order' },
    ]);
    expect(deps.model.find).toHaveBeenNthCalledWith(1, {
      ownerSub: 'user_member',
    });
    expect(deps.model.find).toHaveBeenNthCalledWith(2, {});
    expect(deps.model.find).toHaveBeenNthCalledWith(3, {
      status: 'preparing',
    });
  });

  it.each([
    ['member', 'findForMember', 'findOne'],
    ['administrator', 'findForAdmin', 'findById'],
  ])('finds an order for a %s', async (_name, method, modelMethod) => {
    const deps = dependencies();
    deps.model[modelMethod].mockReturnValue(query({ id: 'order-1' }));

    const result =
      method === 'findForMember'
        ? await serviceOf(deps).findForMember('user_member', 'order-1')
        : await serviceOf(deps).findForAdmin('order-1');

    expect(result).toEqual({ id: 'order-1' });
  });

  it.each([
    ['member', 'findForMember', 'findOne'],
    ['administrator', 'findForAdmin', 'findById'],
  ])('rejects a missing %s order', async (_name, method, modelMethod) => {
    const deps = dependencies();
    deps.model[modelMethod].mockReturnValue(query(null));
    const promise =
      method === 'findForMember'
        ? serviceOf(deps).findForMember('user_member', 'missing')
        : serviceOf(deps).findForAdmin('missing');

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
  });

  it('records a member donation report and advances its status once', async () => {
    const current = order({ status: 'awaiting_donation', statusHistory: [] });
    const deps = dependencies();
    deps.model.findOne.mockReturnValue(query(current));
    const service = serviceOf(deps);

    await service.reportDonation('user_member', 'order-1', {
      method: 'paypal',
      amountCents: 4000,
    });

    expect(current.donationReport).toMatchObject({
      method: 'paypal',
      amountCents: 4000,
      reportedAt: expect.any(Date),
    });
    expect(current.status).toBe('donation_reported');
    expect(current.statusHistory).toEqual([
      expect.objectContaining({
        status: 'donation_reported',
        actor: 'member',
      }),
    ]);
    expect(current.save).toHaveBeenCalled();

    await service.reportDonation('user_member', 'order-1', {
      method: 'venmo',
    });
    expect(current.statusHistory).toHaveLength(1);
  });

  it.each([
    ['missing', null, NotFoundException],
    [
      'past donation reporting',
      order({ status: 'preparing' }),
      ConflictException,
    ],
  ])(
    'rejects a donation report for an order that is %s',
    async (_name, value, type) => {
      const deps = dependencies();
      deps.model.findOne.mockReturnValue(query(value));

      await expect(
        serviceOf(deps).reportDonation('user_member', 'order-1', {
          method: 'paypal',
        }),
      ).rejects.toBeInstanceOf(type);
    },
  );

  it('updates status, trims tracking, records history, and sends email', async () => {
    const current = order({ status: 'preparing', statusHistory: [] });
    const deps = dependencies();
    deps.model.findById.mockReturnValue(query(current));

    await expect(
      serviceOf(deps).updateStatus('order-1', {
        status: 'shipped',
        trackingNumber: ' TRACK-1 ',
      }),
    ).resolves.toBe(current);

    expect(current.status).toBe('shipped');
    expect(current.trackingNumber).toBe('TRACK-1');
    expect(current.statusHistory).toEqual([
      expect.objectContaining({ status: 'shipped', actor: 'admin' }),
    ]);
    expect(deps.notifications.sendStatusChanged).toHaveBeenCalledWith(current);
  });

  it('allows a no-op status update without adding history or tracking', async () => {
    const current = order({ status: 'preparing', statusHistory: [] });
    const deps = dependencies();
    deps.model.findById.mockReturnValue(query(current));

    await serviceOf(deps).updateStatus('order-1', { status: 'preparing' });

    expect(current.statusHistory).toEqual([]);
    expect(current).not.toHaveProperty('trackingNumber');
  });

  it.each([
    ['missing order', null, { status: 'preparing' }, NotFoundException],
    [
      'invalid transition',
      order({ status: 'completed' }),
      { status: 'preparing' },
      ConflictException,
    ],
    [
      'shipped without tracking',
      order({ status: 'preparing' }),
      { status: 'shipped', trackingNumber: ' ' },
      BadRequestException,
    ],
  ])('rejects a status update for a %s', async (_name, value, input, type) => {
    const deps = dependencies();
    deps.model.findById.mockReturnValue(query(value));

    await expect(
      serviceOf(deps).updateStatus('order-1', input as never),
    ).rejects.toBeInstanceOf(type);
  });
});

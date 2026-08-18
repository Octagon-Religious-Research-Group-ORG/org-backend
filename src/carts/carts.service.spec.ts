/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { CartsService } from './carts.service';

function query<T>(value: T) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

function request(options?: {
  sub?: string;
  guestToken?: string | string[];
}): AuthenticatedRequest {
  return {
    auth: options?.sub ? { payload: { sub: options.sub } } : undefined,
    headers: options?.guestToken ? { 'x-cart-token': options.guestToken } : {},
  } as AuthenticatedRequest;
}

function cart(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cart-1',
    items: [],
    save: jest.fn().mockResolvedValue(undefined),
    deleteOne: jest.fn().mockResolvedValue(undefined),
    updatedAt: new Date('2026-07-23T00:00:00.000Z'),
    ...overrides,
  };
}

function products(suggestedDonationCents?: number) {
  return {
    findOrderableVariant: jest.fn().mockResolvedValue({
      product: {
        name: 'Mesh Tool',
        imageUrl: '/offerings/mesh.webp',
        imageAlt: 'Mesh tool',
      },
      variant: {
        id: 'standard',
        label: 'Standard',
        suggestedDonationCents,
      },
    }),
  };
}

describe('CartsService', () => {
  it('creates a guest cart with a hashed expiring token', async () => {
    const created = cart();
    const model = { create: jest.fn().mockResolvedValue(created) };
    const service = new CartsService(model as never, products() as never);

    const result = await service.createGuestCart();

    expect(result.guestToken).toEqual(expect.any(String));
    expect(result.cart).toMatchObject({
      id: 'cart-1',
      items: [],
      suggestedTotalCents: 0,
    });
    expect(model.create).toHaveBeenCalledWith({
      guestTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      items: [],
      expiresAt: expect.any(Date),
    });
  });

  it.each([
    ['member', request({ sub: 'user_member' }), { ownerSub: 'user_member' }],
    [
      'guest',
      request({ guestToken: 'guest-token' }),
      { guestTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ],
    [
      'guest header array',
      request({ guestToken: ['guest-token', 'ignored'] }),
      { guestTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ],
  ])(
    'gets or creates the current %s cart',
    async (_name, ownerRequest, owner) => {
      const current = cart();
      const model = {
        findOneAndUpdate: jest.fn(() => query(current)),
      };
      const service = new CartsService(model as never, products() as never);

      await expect(service.getCurrent(ownerRequest)).resolves.toMatchObject({
        id: 'cart-1',
      });

      expect(model.findOneAndUpdate.mock.calls[0][0]).toEqual(owner);
      const insert = model.findOneAndUpdate.mock.calls[0][1].$setOnInsert;
      expect(insert).toMatchObject({ ...owner, items: [] });
      if ('guestTokenHash' in owner) {
        expect(insert.expiresAt).toBeInstanceOf(Date);
      } else {
        expect(insert).not.toHaveProperty('expiresAt');
      }
    },
  );

  it('requires a guest token or authenticated subject', async () => {
    const service = new CartsService({} as never, products() as never);

    await expect(service.getCurrent(request())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('gets a mutable member cart document', async () => {
    const current = cart();
    const model = { findOneAndUpdate: jest.fn(() => query(current)) };
    const service = new CartsService(model as never, products() as never);

    await expect(service.getUserDocument('user_member')).resolves.toBe(current);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { ownerSub: 'user_member' },
      { $setOnInsert: { ownerSub: 'user_member', items: [] } },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      },
    );
  });

  it('updates an existing selection with a normalized note', async () => {
    const existing = {
      itemId: 'line-1',
      productSlug: 'mesh-tool',
      variantId: 'standard',
      quantity: 1,
      note: 'Blue',
    };
    const current = cart({ items: [existing] });
    const model = { findOneAndUpdate: jest.fn(() => query(current)) };
    const productService = products(1200);
    const service = new CartsService(model as never, productService as never);

    const response = await service.setItem(request({ sub: 'user_member' }), {
      productSlug: 'mesh-tool',
      variantId: 'standard',
      quantity: 3,
      note: ' Blue ',
    });

    expect(existing.quantity).toBe(3);
    expect(current.save).toHaveBeenCalled();
    expect(response.suggestedTotalCents).toBe(5100);
  });

  it('matches an existing selection when both notes are absent', async () => {
    const existing = {
      itemId: 'line-1',
      productSlug: 'mesh-tool',
      variantId: 'standard',
      quantity: 1,
    };
    const current = cart({ items: [existing] });
    const model = { findOneAndUpdate: jest.fn(() => query(current)) };
    const service = new CartsService(model as never, products(100) as never);

    await service.setItem(request({ sub: 'user_member' }), {
      productSlug: 'mesh-tool',
      variantId: 'standard',
      quantity: 4,
    });

    expect(existing.quantity).toBe(4);
  });

  it.each([
    ['trimmed note', ' Blue ', 'Blue'],
    ['empty note', '   ', undefined],
    ['missing note', undefined, undefined],
  ])(
    'adds a new guest selection with a %s',
    async (_name, note, expectedNote) => {
      const current = cart({
        guestTokenHash: 'hash',
        expiresAt: new Date(0),
      });
      const model = { findOneAndUpdate: jest.fn(() => query(current)) };
      const service = new CartsService(model as never, products(1200) as never);

      await service.setItem(request({ guestToken: 'guest-token' }), {
        productSlug: 'mesh-tool',
        variantId: 'standard',
        quantity: 1,
        note,
      });

      expect(current.items).toEqual([
        expect.objectContaining({
          itemId: expect.any(String),
          note: expectedNote,
        }),
      ]);
      expect(current.expiresAt.getTime()).toBeGreaterThan(0);
    },
  );

  it('rejects a twenty-sixth distinct selection', async () => {
    const current = cart({
      items: Array.from({ length: 25 }, (_, index) => ({
        itemId: `line-${index}`,
        productSlug: 'other',
        variantId: `${index}`,
        quantity: 1,
      })),
    });
    const model = { findOneAndUpdate: jest.fn(() => query(current)) };
    const service = new CartsService(model as never, products() as never);

    await expect(
      service.setItem(request({ sub: 'user_member' }), {
        productSlug: 'mesh-tool',
        variantId: 'standard',
        quantity: 1,
      }),
    ).rejects.toThrow('at most 25 distinct selections');
  });

  it('deletes an existing selection', async () => {
    const current = cart({
      items: [
        {
          itemId: 'line-1',
          productSlug: 'mesh-tool',
          variantId: 'standard',
          quantity: 1,
        },
      ],
    });
    const model = { findOne: jest.fn(() => query(current)) };
    const service = new CartsService(model as never, products(1200) as never);

    const response = await service.deleteItem(
      request({ sub: 'user_member' }),
      'line-1',
    );

    expect(current.items).toEqual([]);
    expect(current.save).toHaveBeenCalled();
    expect(response.suggestedShippingCents).toBe(0);
  });

  it.each([
    ['missing cart', null, 'Cart not found.'],
    ['missing item', cart(), 'Cart item not found.'],
  ])('rejects deleting from a %s', async (_name, current, message) => {
    const model = { findOne: jest.fn(() => query(current)) };
    const service = new CartsService(model as never, products() as never);

    await expect(
      service.deleteItem(request({ sub: 'user_member' }), 'missing'),
    ).rejects.toMatchObject({ message });
  });

  it('returns the member cart unchanged when the guest cart is gone', async () => {
    const userCart = cart();
    const model = {
      findOne: jest.fn(() => query(null)),
      findOneAndUpdate: jest.fn(() => query(userCart)),
    };
    const service = new CartsService(model as never, products() as never);

    await expect(
      service.merge('user_member', 'guest-token'),
    ).resolves.toMatchObject({ id: 'cart-1', items: [] });
    expect(userCart.save).not.toHaveBeenCalled();
  });

  it('merges matching and new guest selections and caps quantities at ten', async () => {
    const userCart = cart({
      items: [
        {
          itemId: 'user-1',
          productSlug: 'mesh-tool',
          variantId: 'standard',
          quantity: 8,
          note: 'Blue',
        },
      ],
    });
    const guestCart = cart({
      items: [
        {
          itemId: 'guest-1',
          productSlug: 'mesh-tool',
          variantId: 'standard',
          quantity: 5,
          note: 'Blue',
        },
        {
          itemId: 'guest-2',
          productSlug: 'other-tool',
          variantId: 'standard',
          quantity: 1,
        },
      ],
    });
    const productService = products(100);
    const model = {
      findOne: jest.fn(() => query(guestCart)),
      findOneAndUpdate: jest.fn(() => query(userCart)),
    };
    const service = new CartsService(model as never, productService as never);

    const response = await service.merge('user_member', 'guest-token');

    expect(userCart.items[0].quantity).toBe(10);
    expect(userCart.items[1]).toMatchObject({
      productSlug: 'other-tool',
      quantity: 1,
    });
    expect(response.suggestedItemsCents).toBe(1100);
    expect(userCart.save).toHaveBeenCalled();
    expect(guestCart.deleteOne).toHaveBeenCalled();
  });

  it('merges matching selections without notes below the quantity cap', async () => {
    const userCart = cart({
      items: [
        {
          itemId: 'user-1',
          productSlug: 'mesh-tool',
          variantId: 'standard',
          quantity: 2,
        },
      ],
    });
    const guestCart = cart({
      items: [
        {
          itemId: 'guest-1',
          productSlug: 'mesh-tool',
          variantId: 'standard',
          quantity: 3,
        },
      ],
    });
    const model = {
      findOne: jest.fn(() => query(guestCart)),
      findOneAndUpdate: jest.fn(() => query(userCart)),
    };
    const service = new CartsService(model as never, products(100) as never);

    await service.merge('user_member', 'guest-token');

    expect(userCart.items[0].quantity).toBe(5);
  });

  it('does not add guest selections after the member cart reaches its limit', async () => {
    const userCart = cart({
      items: Array.from({ length: 25 }, (_, index) => ({
        itemId: `line-${index}`,
        productSlug: `product-${index}`,
        variantId: 'standard',
        quantity: 1,
      })),
    });
    const guestCart = cart({
      items: [
        {
          itemId: 'guest-1',
          productSlug: 'extra',
          variantId: 'standard',
          quantity: 1,
        },
      ],
    });
    const model = {
      findOne: jest.fn(() => query(guestCart)),
      findOneAndUpdate: jest.fn(() => query(userCart)),
    };
    const service = new CartsService(model as never, products(0) as never);

    await service.merge('user_member', 'guest-token');

    expect(userCart.items).toHaveLength(25);
  });

  it('clears a member cart', async () => {
    const update = query(undefined);
    const model = { updateOne: jest.fn(() => update) };
    const service = new CartsService(model as never, products() as never);

    await service.clearUserCart('user_member');

    expect(model.updateOne).toHaveBeenCalledWith(
      { ownerSub: 'user_member' },
      { $set: { items: [] } },
    );
  });

  it('uses zero when a variant has no suggested donation', async () => {
    const service = new CartsService({} as never, products() as never);

    const response = await service.toResponse(
      cart({
        items: [
          {
            itemId: 'line-1',
            productSlug: 'mesh-tool',
            variantId: 'standard',
            quantity: 2,
          },
        ],
      }) as never,
    );

    expect(response).toMatchObject({
      suggestedItemsCents: 0,
      suggestedShippingCents: 1500,
      suggestedTotalCents: 1500,
    });
  });
});

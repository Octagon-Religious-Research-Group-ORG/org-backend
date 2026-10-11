import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth/auth.types';
import { CartsController } from './carts/carts.controller';
import {
  AdminContentController,
  PublicContentController,
} from './content/content.controller';
import {
  AdminOrdersController,
  OrdersController,
} from './orders/orders.controller';
import { ProductsController } from './products/products.controller';
import { ProfilesController } from './profiles/profiles.controller';

const request = {
  auth: {
    payload: {
      sub: 'user_member',
      permissions: ['read:orders'],
    },
  },
  headers: {},
} as unknown as AuthenticatedRequest;

describe('thin HTTP controllers', () => {
  it('delegates cart operations with the authenticated request', () => {
    const carts = {
      createGuestCart: jest.fn().mockReturnValue('guest'),
      getCurrent: jest.fn().mockReturnValue('current'),
      setItem: jest.fn().mockReturnValue('set'),
      deleteItem: jest.fn().mockReturnValue('deleted'),
      merge: jest.fn().mockReturnValue('merged'),
    };
    const controller = new CartsController(carts as never);
    const item = {
      productSlug: 'mesh-tool',
      variantId: 'standard',
      quantity: 2,
    };

    expect(controller.createGuestCart()).toBe('guest');
    expect(controller.getCart(request)).toBe('current');
    expect(controller.setItem(request, item)).toBe('set');
    expect(controller.deleteItem(request, 'line-1')).toBe('deleted');
    expect(controller.merge(request, { guestToken: 'guest-token' })).toBe(
      'merged',
    );
    expect(carts.setItem).toHaveBeenCalledWith(request, item);
    expect(carts.deleteItem).toHaveBeenCalledWith(request, 'line-1');
    expect(carts.merge).toHaveBeenCalledWith('user_member', 'guest-token');
  });

  it('validates product categories and returns donation configuration', () => {
    const products = {
      findAll: jest.fn().mockReturnValue('products'),
      findBySlug: jest.fn().mockReturnValue('product'),
    };
    const config = {
      get: jest.fn(() => undefined),
      getOrThrow: jest.fn((key: string) => `${key}-value`),
    };
    const controller = new ProductsController(
      products as never,
      config as never,
    );

    expect(controller.findAll()).toBe('products');
    expect(controller.findAll('laboratory-tools')).toBe('products');
    expect(() => controller.findAll('unknown')).toThrow(BadRequestException);
    expect(controller.findOne('mesh-tool')).toBe('product');
    expect(products.findAll).toHaveBeenNthCalledWith(1, undefined);
    expect(products.findAll).toHaveBeenNthCalledWith(2, 'laboratory-tools');
    expect(controller.getDonationConfig()).toEqual({
      currency: 'USD',
      suggestedShippingCents: 1500,
      paypalUrl: 'PAYPAL_DONATION_URL-value',
      venmoUrl: 'VENMO_DONATION_URL-value',
      paypalHandle: '@trippaardema',
      venmoHandle: '@the_org',
      verification: 'manual',
      testSite: false,
    });
  });

  it('never returns the real payment accounts on the test site', () => {
    const config = {
      get: jest.fn((key: string) => (key === 'SITE_ENV' ? 'test' : undefined)),
      getOrThrow: jest.fn((key: string) =>
        key === 'PUBLIC_APP_URL'
          ? 'https://test.example.test'
          : 'https://paypal.example.test/real-account',
      ),
    };
    const controller = new ProductsController({} as never, config as never);

    const donation = controller.getDonationConfig();

    expect(donation).toEqual({
      currency: 'USD',
      suggestedShippingCents: 1500,
      verification: 'manual',
      testSite: true,
      paypalUrl: 'https://test.example.test/offerings',
      venmoUrl: 'https://test.example.test/offerings',
      paypalHandle: '(test site: no real payment)',
      venmoHandle: '(test site: no real payment)',
    });
    expect(JSON.stringify(donation)).not.toMatch(
      /real-account|trippaardema|the_org/,
    );
    expect(config.getOrThrow).not.toHaveBeenCalledWith('PAYPAL_DONATION_URL');
    expect(config.getOrThrow).not.toHaveBeenCalledWith('VENMO_DONATION_URL');
  });

  it('delegates profile operations and exposes capabilities', async () => {
    // A stored document as Mongo returns it, server-only fields included.
    const stored = {
      _id: 'mongo-id',
      __v: 0,
      authProviderId: 'user_member',
      authEmail: 'member@example.test',
      authEmailVerified: true,
      authEmailTokenHash: 'a'.repeat(64),
      isAdmin: true,
      preferredName: 'Member',
      email: 'member@example.test',
      membershipType: 'public' as const,
      contactMethod: 'email' as const,
      contactHandle: 'member@example.test',
      beliefsSummary: '',
      shippingAddress: { city: 'Nashville' },
    };
    const expectedPublic = {
      preferredName: 'Member',
      email: 'member@example.test',
      membershipType: 'public',
      contactMethod: 'email',
      contactHandle: 'member@example.test',
      beliefsSummary: '',
      shippingAddress: { city: 'Nashville' },
    };
    const synchronizedProfile = stored;
    const adminAccess = {
      synchronizeProfile: jest.fn().mockResolvedValue(synchronizedProfile),
      hasAdminAccess: jest.fn().mockResolvedValue(true),
    };
    const profiles = {
      getOrCreate: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue(stored),
      updateShipping: jest.fn().mockResolvedValue(stored),
      deleteShipping: jest.fn().mockResolvedValue(null),
    };
    const controller = new ProfilesController(
      profiles as never,
      adminAccess as never,
    );
    const profile = {
      preferredName: 'Member',
      email: 'member@example.test',
      membershipType: 'public' as const,
      contactMethod: 'email' as const,
      contactHandle: 'member@example.test',
      beliefsSummary: '',
    };
    const shipping = {
      recipientName: 'Member',
      line1: '1 Main St',
      city: 'Nashville',
      state: 'TN',
      postalCode: '37201',
      country: 'US' as const,
    };

    const me = await controller.getMe(request);
    expect(me).toEqual(expectedPublic);
    expect(me).not.toHaveProperty('authEmailTokenHash');
    expect(me).not.toHaveProperty('isAdmin');
    await expect(controller.getCapabilities(request)).resolves.toEqual({
      canManageOrders: true,
      canEditWebsite: true,
      canPublishWebsite: true,
    });
    await expect(controller.updateMe(request, profile)).resolves.toEqual(
      expectedPublic,
    );
    await expect(controller.getShipping(request)).resolves.toBeNull();
    await expect(controller.updateShipping(request, shipping)).resolves.toEqual(
      expectedPublic,
    );
    await expect(controller.deleteShipping(request)).resolves.toBeNull();
    expect(profiles.update).toHaveBeenCalledWith('user_member', profile);
    expect(adminAccess.synchronizeProfile).toHaveBeenCalledWith(request);
    expect(adminAccess.hasAdminAccess).toHaveBeenCalledWith(request);
    expect(profiles.getOrCreate).toHaveBeenCalledWith('user_member');
    expect(profiles.updateShipping).toHaveBeenCalledWith(
      'user_member',
      shipping,
    );
  });

  it('uses complete Clerk token capabilities without an allowlist lookup', async () => {
    const adminAccess = {
      hasAdminAccess: jest.fn(),
    };
    const controller = new ProfilesController(
      {} as never,
      adminAccess as never,
    );
    const administratorRequest = {
      auth: {
        payload: {
          sub: 'user_admin',
          permissions: [
            'read:orders',
            'update:orders',
            'read:content',
            'update:content',
            'publish:content',
          ],
        },
      },
    } as unknown as AuthenticatedRequest;

    await expect(
      controller.getCapabilities(administratorRequest),
    ).resolves.toEqual({
      canManageOrders: true,
      canEditWebsite: true,
      canPublishWebsite: true,
    });
    expect(adminAccess.hasAdminAccess).not.toHaveBeenCalled();
  });

  it('returns a profile shipping address when one exists', async () => {
    const profiles = {
      getOrCreate: jest
        .fn()
        .mockResolvedValue({ shippingAddress: { city: 'Nashville' } }),
    };
    const controller = new ProfilesController(profiles as never, {} as never);

    await expect(controller.getShipping(request)).resolves.toEqual({
      city: 'Nashville',
    });
  });

  it('delegates member and administrator order operations', () => {
    const orders = {
      listForMember: jest.fn().mockReturnValue('member-list'),
      findForMember: jest.fn().mockReturnValue('member-order'),
      create: jest.fn().mockReturnValue('created'),
      reportDonation: jest.fn().mockReturnValue('reported'),
      listForAdmin: jest.fn().mockReturnValue('admin-list'),
      findForAdmin: jest.fn().mockReturnValue('admin-order'),
      updateStatus: jest.fn().mockReturnValue('updated'),
    };
    const member = new OrdersController(orders as never);
    const admin = new AdminOrdersController(orders as never);
    const createInput = { declaredDonationCents: 1000 };
    const report = { method: 'paypal' as const, amountCents: 1000 };
    const status = { status: 'preparing' as const };

    expect(member.list(request)).toBe('member-list');
    expect(member.findOne(request, 'order-1')).toBe('member-order');
    expect(member.create(request, 'key-1', createInput)).toBe('created');
    expect(member.reportDonation(request, 'order-1', report)).toBe('reported');
    expect(admin.list()).toBe('admin-list');
    expect(admin.list('preparing')).toBe('admin-list');
    expect(() => admin.list('unknown')).toThrow(BadRequestException);
    expect(admin.findOne('order-1')).toBe('admin-order');
    expect(admin.updateStatus('order-1', status)).toBe('updated');
    expect(orders.create).toHaveBeenCalledWith(
      'user_member',
      'key-1',
      createInput,
    );
    expect(orders.listForAdmin).toHaveBeenNthCalledWith(1, undefined);
    expect(orders.listForAdmin).toHaveBeenNthCalledWith(2, 'preparing');
  });

  it('delegates public and administrator content operations', () => {
    const content = {
      listPublic: jest.fn().mockReturnValue('public-list'),
      getPublic: jest.fn().mockReturnValue('public-page'),
      listAdmin: jest.fn().mockReturnValue('admin-list'),
      getAdmin: jest.fn().mockReturnValue('admin-page'),
      saveDraft: jest.fn().mockReturnValue('saved'),
      publish: jest.fn().mockReturnValue('published'),
      discardDraft: jest.fn().mockReturnValue('discarded'),
      restoreRevision: jest.fn().mockReturnValue('restored'),
    };
    const publicController = new PublicContentController(content as never);
    const admin = new AdminContentController(content as never);
    const body = { expectedDraftRevision: 2 };
    const saveBody = {
      expectedDraftRevision: 2,
      content: { title: 'Draft' },
    };

    expect(publicController.list()).toBe('public-list');
    expect(publicController.findOne('community')).toBe('public-page');
    expect(admin.list()).toBe('admin-list');
    expect(admin.findOne('community')).toBe('admin-page');
    expect(admin.saveDraft(request, 'community', saveBody as never)).toBe(
      'saved',
    );
    expect(admin.publish(request, 'community', body)).toBe('published');
    expect(admin.discardDraft('community', body)).toBe('discarded');
    expect(admin.restoreRevision(request, 'community', 1, body)).toBe(
      'restored',
    );
    expect(content.saveDraft).toHaveBeenCalledWith(
      'community',
      2,
      saveBody.content,
      'user_member',
    );
    expect(content.restoreRevision).toHaveBeenCalledWith(
      'community',
      1,
      2,
      'user_member',
    );
  });
});

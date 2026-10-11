/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from '../src/app.controller';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../src/auth/auth.guard';
import { PermissionsGuard } from '../src/auth/permissions.guard';
import { CartsController } from '../src/carts/carts.controller';
import { CartsService } from '../src/carts/carts.service';
import {
  AdminContentController,
  PublicContentController,
} from '../src/content/content.controller';
import { ContentService } from '../src/content/content.service';
import {
  AdminOrdersController,
  OrdersController,
} from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { ProductsController } from '../src/products/products.controller';
import { ProductsService } from '../src/products/products.service';
import { ProfilesController } from '../src/profiles/profiles.controller';
import { ProfilesService } from '../src/profiles/profiles.service';
import { configureHttpApp } from '../src/config/http-app';
import type { NestExpressApplication } from '@nestjs/platform-express';

const product = {
  slug: 'mesh-tool',
  name: 'Mesh Tool',
  category: 'laboratory-tools',
};

describe('ORG API (e2e)', () => {
  let app: INestApplication<App>;

  const carts = {
    createGuestCart: jest.fn().mockResolvedValue({
      guestToken: 'g'.repeat(48),
      cart: { id: 'cart-1', items: [] },
    }),
    getCurrent: jest.fn().mockResolvedValue({ id: 'cart-1', items: [] }),
    setItem: jest.fn().mockResolvedValue({ id: 'cart-1', items: [{}] }),
    deleteItem: jest.fn(),
    merge: jest.fn(),
  };
  const products = {
    findAll: jest.fn().mockResolvedValue([product]),
    findBySlug: jest.fn().mockResolvedValue(product),
  };
  const profiles = {
    getOrCreate: jest.fn().mockResolvedValue({
      authProviderId: 'user_e2e',
      preferredName: 'Member',
    }),
    update: jest.fn().mockResolvedValue({ authProviderId: 'user_e2e' }),
    updateShipping: jest.fn(),
    deleteShipping: jest.fn(),
  };
  const adminAccess = {
    synchronizeProfile: jest.fn().mockResolvedValue({
      authProviderId: 'user_e2e',
      authEmail: 'admin@example.test',
      authEmailTokenHash: 'a'.repeat(64),
      isAdmin: true,
      preferredName: 'Member',
    }),
    hasAdminAccess: jest.fn().mockResolvedValue(true),
  };
  const orders = {
    listForMember: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
    findForMember: jest.fn(),
    create: jest.fn(),
    reportDonation: jest.fn(),
    listForAdmin: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
    findForAdmin: jest.fn(),
    updateStatus: jest
      .fn()
      .mockResolvedValue({ id: 'order-1', status: 'preparing' }),
  };
  const content = {
    listPublic: jest
      .fn()
      .mockResolvedValue([{ pageId: 'community', revision: 1 }]),
    getPublic: jest
      .fn()
      .mockResolvedValue({ pageId: 'community', revision: 1 }),
    listAdmin: jest.fn().mockResolvedValue([{ pageId: 'community' }]),
    getAdmin: jest.fn(),
    saveDraft: jest
      .fn()
      .mockResolvedValue({ pageId: 'community', draft: { revision: 1 } }),
    publish: jest.fn(),
    discardDraft: jest.fn(),
    restoreRevision: jest.fn(),
  };

  const authenticatedGuard: CanActivate = {
    canActivate(context: ExecutionContext) {
      const memberRequest = context.switchToHttp().getRequest();
      memberRequest.auth = {
        payload: {
          sub: 'user_e2e',
          permissions: [
            'read:orders',
            'update:orders',
            'read:content',
            'update:content',
            'publish:content',
          ],
        },
      };
      return true;
    },
  };
  const allowGuard: CanActivate = { canActivate: () => true };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [
        AppController,
        CartsController,
        ProductsController,
        ProfilesController,
        OrdersController,
        AdminOrdersController,
        PublicContentController,
        AdminContentController,
      ],
      providers: [
        { provide: CartsService, useValue: carts },
        { provide: ProductsService, useValue: products },
        { provide: ProfilesService, useValue: profiles },
        { provide: AdminAccessService, useValue: adminAccess },
        { provide: OrdersService, useValue: orders },
        { provide: ContentService, useValue: content },
        {
          provide: ConfigService,
          useValue: {
            get: () => undefined,
            getOrThrow: (key: string) =>
              key === 'PAYPAL_DONATION_URL'
                ? 'https://example.test/paypal'
                : 'https://example.test/venmo',
          },
        },
      ],
    })
      .overrideGuard(ClerkAuthGuard)
      .useValue(authenticatedGuard)
      .overrideGuard(OptionalClerkAuthGuard)
      .useValue(authenticatedGuard)
      .overrideGuard(PermissionsGuard)
      .useValue(allowGuard)
      .compile();

    const nest = moduleFixture.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, {
      origins: ['http://localhost:50073'],
      trustProxyHops: 1,
    });
    await nest.init();
    app = nest;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health, catalog, donation, and published-content routes', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'ok',
          service: 'org-backend',
        });
      });
    await request(app.getHttpServer())
      .get('/api/v1/products?category=laboratory-tools')
      .expect(200)
      .expect([product]);
    await request(app.getHttpServer())
      .get('/api/v1/donation-config')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          currency: 'USD',
          paypalUrl: 'https://example.test/paypal',
        });
      });
    await request(app.getHttpServer())
      .get('/api/v1/content/pages/community')
      .expect(200)
      .expect({ pageId: 'community', revision: 1 });
  });

  it('rejects an unknown catalog category at the HTTP boundary', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/products?category=unknown')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe('Unknown offering category.');
      });
  });

  it('creates a guest cart and validates cart item input', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/carts/guest')
      .expect(201)
      .expect(({ body }) => {
        expect(body.guestToken).toHaveLength(48);
      });
    await request(app.getHttpServer())
      .patch('/api/v1/cart/items')
      .send({ productSlug: '', variantId: 'standard', quantity: 11 })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/cart/items')
      .send({
        productSlug: 'mesh-tool',
        variantId: 'standard',
        quantity: 2,
      })
      .expect(200)
      .expect({ id: 'cart-1', items: [{}] });
  });

  it('injects the authenticated member into profile and order routes', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer e2e')
      .expect(200)
      .expect(({ body }) => {
        expect(body.preferredName).toBe('Member');
        expect(body).not.toHaveProperty('authEmailTokenHash');
        expect(body).not.toHaveProperty('isAdmin');
        expect(body).not.toHaveProperty('authProviderId');
      });
    await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', 'Bearer e2e')
      .expect(200)
      .expect([{ id: 'order-1' }]);
    expect(adminAccess.synchronizeProfile).toHaveBeenCalled();
    expect(orders.listForMember).toHaveBeenCalledWith('user_e2e');
  });

  it('validates profile and administrator order bodies', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/me')
      .set('Authorization', 'Bearer e2e')
      .send({ preferredName: '' })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/admin/orders/order-1/status')
      .set('Authorization', 'Bearer e2e')
      .send({ status: 'unknown' })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/admin/orders/order-1/status')
      .set('Authorization', 'Bearer e2e')
      .send({ status: 'preparing' })
      .expect(200)
      .expect({ id: 'order-1', status: 'preparing' });
  });

  it('routes a validated administrator draft save to the content service', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/content/pages/community/draft')
      .set('Authorization', 'Bearer e2e')
      .send({
        expectedDraftRevision: null,
        content: { kind: 'reference' },
      })
      .expect(200)
      .expect({
        pageId: 'community',
        draft: { revision: 1 },
      });
    expect(content.saveDraft).toHaveBeenCalledWith(
      'community',
      null,
      { kind: 'reference' },
      'user_e2e',
    );
  });

  it('allows the administrator draft PUT request through CORS preflight', async () => {
    await request(app.getHttpServer())
      .options('/api/v1/admin/content/pages/community/draft')
      .set('Origin', 'http://localhost:50073')
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204)
      .expect('Access-Control-Allow-Origin', 'http://localhost:50073')
      .expect(({ headers }) => {
        expect(headers['access-control-allow-methods']).toContain('PUT');
      });
  });
});

import { CartsController } from '../carts/carts.controller';
import { OrdersController } from '../orders/orders.controller';
import { ProfilesController } from '../profiles/profiles.controller';
import { DEFAULT_THROTTLE, WRITE_THROTTLE, WriteThrottle } from './throttle';

const limitOf = (controller: { prototype: object }, method: string) =>
  Reflect.getMetadata(
    'THROTTLER:LIMITdefault',
    Reflect.get(controller.prototype, method) as object,
  ) as number | undefined;

describe('throttle limits', () => {
  it('keeps member writes stricter than the site-wide limit', () => {
    expect(WRITE_THROTTLE.limit).toBeLessThan(DEFAULT_THROTTLE.limit);
    expect(WRITE_THROTTLE.ttl).toBe(DEFAULT_THROTTLE.ttl);
  });

  it('stores the write limit on a decorated handler', () => {
    class Probe {
      handler() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Probe.prototype,
      'handler',
    )!;
    WriteThrottle()(Probe.prototype, 'handler', descriptor);
    expect(limitOf(Probe, 'handler')).toBe(WRITE_THROTTLE.limit);
  });

  it.each([
    ['POST /carts/guest', CartsController, 'createGuestCart'],
    ['POST /orders', OrdersController, 'create'],
    ['POST /orders/:id/donation-report', OrdersController, 'reportDonation'],
    ['PATCH /me', ProfilesController, 'updateMe'],
    ['PATCH /me/shipping', ProfilesController, 'updateShipping'],
  ] as const)('applies the write limit to %s', (_route, controller, method) => {
    expect(limitOf(controller, method)).toBe(WRITE_THROTTLE.limit);
  });

  it('leaves reads on the site-wide limit', () => {
    expect(limitOf(CartsController, 'getCart')).toBeUndefined();
    expect(limitOf(ProfilesController, 'getMe')).toBeUndefined();
  });
});

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ProductsService } from '../products/products.service';
import { Cart, CartDocument } from './schemas/cart.schema';
import { SetCartItemDto } from './carts.dto';

const GUEST_CART_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** What the shop shows before a cart row exists; it has no id yet. */
const EMPTY_CART = {
  id: '',
  items: [],
  suggestedItemsCents: 0,
  suggestedShippingCents: 0,
  suggestedTotalCents: 0,
};

@Injectable()
export class CartsService {
  constructor(
    @InjectModel(Cart.name)
    private readonly cartModel: Model<CartDocument>,
    private readonly products: ProductsService,
  ) {}

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private requestOwner(request: AuthenticatedRequest) {
    const ownerSub = request.auth?.payload.sub;
    if (ownerSub) return { ownerSub };

    const header = request.headers['x-cart-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) {
      throw new BadRequestException(
        'Create a guest cart or sign in before using the cart.',
      );
    }
    return { guestTokenHash: this.hashToken(token) };
  }

  async createGuestCart() {
    const guestToken = randomBytes(32).toString('base64url');
    const guestTokenHash = this.hashToken(guestToken);
    const cart = await this.cartModel.create({
      guestTokenHash,
      items: [],
      expiresAt: new Date(Date.now() + GUEST_CART_LIFETIME_MS),
    });
    return {
      guestToken,
      cart: await this.toResponse(cart),
    };
  }

  /**
   * The visitor's cart, or an empty one when none exists. A read never writes:
   * the row is created by the first item added, so a made-up token sent here
   * can't fill the collection.
   */
  async getCurrent(request: AuthenticatedRequest) {
    const cart = await this.cartModel
      .findOne(this.requestOwner(request))
      .exec();
    return cart ? this.toResponse(cart) : EMPTY_CART;
  }

  async getUserDocument(ownerSub: string) {
    return this.cartModel
      .findOneAndUpdate(
        { ownerSub },
        { $setOnInsert: { ownerSub, items: [] } },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async setItem(request: AuthenticatedRequest, input: SetCartItemDto) {
    await this.products.findOrderableVariant(
      input.productSlug,
      input.variantId,
    );
    const owner = this.requestOwner(request);
    const cart = await this.cartModel
      .findOneAndUpdate(
        owner,
        {
          $setOnInsert: {
            ...owner,
            items: [],
            ...('guestTokenHash' in owner
              ? {
                  expiresAt: new Date(Date.now() + GUEST_CART_LIFETIME_MS),
                }
              : {}),
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      )
      .exec();

    const normalizedNote = input.note?.trim() || undefined;
    const existing = cart.items.find(
      (item) =>
        item.productSlug === input.productSlug &&
        item.variantId === input.variantId &&
        (item.note ?? '') === (normalizedNote ?? ''),
    );
    if (existing) {
      existing.quantity = input.quantity;
    } else {
      if (cart.items.length >= 25) {
        throw new BadRequestException(
          'An order can contain at most 25 distinct selections.',
        );
      }
      cart.items.push({
        itemId: randomUUID(),
        productSlug: input.productSlug,
        variantId: input.variantId,
        quantity: input.quantity,
        note: normalizedNote,
      });
    }
    if (cart.guestTokenHash) {
      cart.expiresAt = new Date(Date.now() + GUEST_CART_LIFETIME_MS);
    }
    await cart.save();
    return this.toResponse(cart);
  }

  async deleteItem(request: AuthenticatedRequest, itemId: string) {
    const owner = this.requestOwner(request);
    const cart = await this.cartModel.findOne(owner).exec();
    if (!cart) throw new NotFoundException('Cart not found.');
    const originalLength = cart.items.length;
    cart.items = cart.items.filter((item) => item.itemId !== itemId);
    if (cart.items.length === originalLength) {
      throw new NotFoundException('Cart item not found.');
    }
    await cart.save();
    return this.toResponse(cart);
  }

  async merge(ownerSub: string, guestToken: string) {
    const guestTokenHash = this.hashToken(guestToken);
    const [guestCart, userCart] = await Promise.all([
      this.cartModel.findOne({ guestTokenHash }).exec(),
      this.getUserDocument(ownerSub),
    ]);

    if (!guestCart) return this.toResponse(userCart);

    for (const guestItem of guestCart.items) {
      const existing = userCart.items.find(
        (item) =>
          item.productSlug === guestItem.productSlug &&
          item.variantId === guestItem.variantId &&
          (item.note ?? '') === (guestItem.note ?? ''),
      );
      if (existing) {
        existing.quantity = Math.min(
          10,
          existing.quantity + guestItem.quantity,
        );
      } else if (userCart.items.length < 25) {
        userCart.items.push({
          itemId: randomUUID(),
          productSlug: guestItem.productSlug,
          variantId: guestItem.variantId,
          quantity: guestItem.quantity,
          note: guestItem.note,
        });
      }
    }

    await userCart.save();
    await guestCart.deleteOne();
    return this.toResponse(userCart);
  }

  async clearUserCart(ownerSub: string) {
    await this.cartModel
      .updateOne({ ownerSub }, { $set: { items: [] } })
      .exec();
  }

  async toResponse(cart: CartDocument) {
    const items = await Promise.all(
      cart.items.map(async (item) => {
        const { product, variant } = await this.products.findOrderableVariant(
          item.productSlug,
          item.variantId,
        );
        const unitSuggestedDonationCents = variant.suggestedDonationCents ?? 0;
        return {
          itemId: item.itemId,
          productSlug: item.productSlug,
          productName: product.name,
          imageUrl: product.imageUrl,
          imageAlt: product.imageAlt,
          variantId: item.variantId,
          variantLabel: variant.label,
          quantity: item.quantity,
          note: item.note,
          unitSuggestedDonationCents,
          lineSuggestedDonationCents:
            unitSuggestedDonationCents * item.quantity,
        };
      }),
    );
    const suggestedItemsCents = items.reduce(
      (total, item) => total + item.lineSuggestedDonationCents,
      0,
    );
    const suggestedShippingCents = items.length ? 1500 : 0;
    return {
      id: cart.id,
      items,
      suggestedItemsCents,
      suggestedShippingCents,
      suggestedTotalCents: suggestedItemsCents + suggestedShippingCents,
      updatedAt: cart.updatedAt,
    };
  }
}

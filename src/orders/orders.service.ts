import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model } from 'mongoose';
import { CartsService } from '../carts/carts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfilesService } from '../profiles/profiles.service';
import {
  CreateOrderDto,
  ReportDonationDto,
  UpdateOrderStatusDto,
} from './orders.dto';
import { Order, OrderDocument, OrderStatus } from './schemas/order.schema';

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  awaiting_donation: ['donation_reported', 'donation_confirmed', 'cancelled'],
  donation_reported: ['donation_confirmed', 'cancelled'],
  donation_confirmed: ['preparing', 'cancelled'],
  preparing: ['shipped', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: [],
};

export function isOrderTransitionAllowed(
  current: OrderStatus,
  next: OrderStatus,
) {
  return current === next || STATUS_TRANSITIONS[current].includes(next);
}

function isDuplicateKeyError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 11000
  );
}

type OrderSource = OrderDocument | (Order & { _id: unknown });

/**
 * A member's own order as the website reads it. An allowlist, so a field added
 * to the schema stays private by default; `ownerSub` (the Clerk id), the
 * idempotency key and the email delivery state never leave the server.
 */
export function toMemberOrder(order: OrderSource) {
  const source =
    'toObject' in order ? order.toObject<Order & { _id: unknown }>() : order;
  return {
    _id: source._id,
    orderNumber: source.orderNumber,
    donationMemo: source.donationMemo,
    items: source.items,
    contact: source.contact,
    shippingAddress: source.shippingAddress,
    suggestedItemsCents: source.suggestedItemsCents,
    suggestedShippingCents: source.suggestedShippingCents,
    suggestedTotalCents: source.suggestedTotalCents,
    declaredDonationCents: source.declaredDonationCents,
    status: source.status,
    statusHistory: source.statusHistory,
    donationReport: source.donationReport,
    trackingNumber: source.trackingNumber,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    private readonly profiles: ProfilesService,
    private readonly carts: CartsService,
    private readonly notifications: NotificationsService,
  ) {}

  private makeOrderNumber() {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    return `ORG-${day}-${suffix}`;
  }

  async create(
    ownerSub: string,
    idempotencyKey: string,
    input: CreateOrderDto,
  ) {
    return toMemberOrder(await this.place(ownerSub, idempotencyKey, input));
  }

  private async place(
    ownerSub: string,
    idempotencyKey: string,
    input: CreateOrderDto,
  ): Promise<OrderDocument> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    const prior = await this.orderModel
      .findOne({ ownerSub, idempotencyKey })
      .exec();
    if (prior) return prior;

    const [profile, cart] = await Promise.all([
      this.profiles.getDocument(ownerSub),
      this.carts.getUserDocument(ownerSub),
    ]);
    if (!profile.preferredName || !profile.email || !profile.contactHandle) {
      throw new BadRequestException(
        'Complete your member profile before placing an order.',
      );
    }
    if (!profile.shippingAddress) {
      throw new BadRequestException(
        'Add a U.S. shipping address before placing an order.',
      );
    }

    const cartSummary = await this.carts.toResponse(cart);
    if (!cartSummary.items.length) {
      throw new BadRequestException('Your offering docket is empty.');
    }

    const orderNumber = this.makeOrderNumber();
    let order: OrderDocument;
    try {
      order = await this.orderModel.create({
        orderNumber,
        ownerSub,
        idempotencyKey,
        donationMemo: `ORG ORDER ${orderNumber}`,
        items: cartSummary.items.map((item) => ({
          productSlug: item.productSlug,
          productName: item.productName,
          variantId: item.variantId,
          variantLabel: item.variantLabel,
          quantity: item.quantity,
          note: item.note,
          unitSuggestedDonationCents: item.unitSuggestedDonationCents,
          lineSuggestedDonationCents: item.lineSuggestedDonationCents,
          imageUrl: item.imageUrl,
        })),
        contact: {
          preferredName: profile.preferredName,
          email: profile.email,
          contactMethod: profile.contactMethod,
          contactHandle: profile.contactHandle,
        },
        shippingAddress: {
          recipientName: profile.shippingAddress.recipientName,
          line1: profile.shippingAddress.line1,
          line2: profile.shippingAddress.line2,
          city: profile.shippingAddress.city,
          state: profile.shippingAddress.state,
          postalCode: profile.shippingAddress.postalCode,
          country: 'US',
          phone: profile.shippingAddress.phone,
        },
        suggestedItemsCents: cartSummary.suggestedItemsCents,
        suggestedShippingCents: cartSummary.suggestedShippingCents,
        suggestedTotalCents: cartSummary.suggestedTotalCents,
        declaredDonationCents: input.declaredDonationCents,
        status: 'awaiting_donation',
        statusHistory: [
          {
            status: 'awaiting_donation',
            at: new Date(),
            actor: 'system',
          },
        ],
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await this.orderModel
          .findOne({ ownerSub, idempotencyKey })
          .exec();
        if (existing) return existing;
      }
      throw error;
    }

    await this.carts.clearUserCart(ownerSub);
    const emailState = await this.notifications.sendOrderCreated(order);
    order.emailState = emailState;
    await order.save();
    return order;
  }

  async listForMember(ownerSub: string) {
    const orders = await this.orderModel
      .find({ ownerSub })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return orders.map(toMemberOrder);
  }

  async findForMember(ownerSub: string, id: string) {
    const order = await this.orderModel
      .findOne({ _id: id, ownerSub })
      .lean()
      .exec();
    if (!order) throw new NotFoundException('Order not found.');
    return toMemberOrder(order);
  }

  async reportDonation(ownerSub: string, id: string, input: ReportDonationDto) {
    const order = await this.orderModel.findOne({ _id: id, ownerSub }).exec();
    if (!order) throw new NotFoundException('Order not found.');
    if (!['awaiting_donation', 'donation_reported'].includes(order.status)) {
      throw new ConflictException(
        'A donation report cannot be changed at this order stage.',
      );
    }
    order.donationReport = {
      method: input.method,
      amountCents: input.amountCents,
      reportedAt: new Date(),
    };
    if (order.status !== 'donation_reported') {
      order.status = 'donation_reported';
      order.statusHistory.push({
        status: 'donation_reported',
        at: new Date(),
        actor: 'member',
      });
    }
    await order.save();
    return toMemberOrder(order);
  }

  listForAdmin(status?: OrderStatus) {
    return this.orderModel
      .find(status ? { status } : {})
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async findForAdmin(id: string) {
    const order = await this.orderModel.findById(id).lean().exec();
    if (!order) throw new NotFoundException('Order not found.');
    return order;
  }

  async updateStatus(id: string, input: UpdateOrderStatusDto) {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException('Order not found.');
    if (!isOrderTransitionAllowed(order.status, input.status)) {
      throw new ConflictException(
        `Order cannot move from ${order.status} to ${input.status}.`,
      );
    }
    if (input.status === 'shipped' && !input.trackingNumber?.trim()) {
      throw new BadRequestException(
        'A tracking number is required when marking an order shipped.',
      );
    }
    if (input.status !== order.status) {
      order.status = input.status;
      order.statusHistory.push({
        status: input.status,
        at: new Date(),
        actor: 'admin',
      });
    }
    if (input.trackingNumber !== undefined) {
      order.trackingNumber = input.trackingNumber.trim();
    }
    await order.save();
    await this.notifications.sendStatusChanged(order);
    return order;
  }
}

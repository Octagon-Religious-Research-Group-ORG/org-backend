import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import { Permissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  CreateOrderDto,
  ReportDonationDto,
  UpdateOrderStatusDto,
} from './orders.dto';
import { OrdersService } from './orders.service';
import type { OrderStatus } from './schemas/order.schema';

@Controller('orders')
@UseGuards(ClerkAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.orders.listForMember(getUserSub(request));
  }

  @Get(':id')
  findOne(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.orders.findForMember(getUserSub(request), id);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateOrderDto,
  ) {
    return this.orders.create(getUserSub(request), idempotencyKey, body);
  }

  @Post(':id/donation-report')
  reportDonation(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ReportDonationDto,
  ) {
    return this.orders.reportDonation(getUserSub(request), id, body);
  }
}

const ORDER_STATUSES: OrderStatus[] = [
  'awaiting_donation',
  'donation_reported',
  'donation_confirmed',
  'preparing',
  'shipped',
  'completed',
  'cancelled',
];

@Controller('admin/orders')
@UseGuards(ClerkAuthGuard, PermissionsGuard)
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Permissions('read:orders')
  list(@Query('status') status?: string) {
    if (status && !ORDER_STATUSES.includes(status as OrderStatus)) {
      throw new BadRequestException('Unknown order status.');
    }
    return this.orders.listForAdmin(status as OrderStatus | undefined);
  }

  @Get(':id')
  @Permissions('read:orders')
  findOne(@Param('id') id: string) {
    return this.orders.findForAdmin(id);
  }

  @Patch(':id/status')
  @Permissions('update:orders')
  updateStatus(@Param('id') id: string, @Body() body: UpdateOrderStatusDto) {
    return this.orders.updateStatus(id, body);
  }
}

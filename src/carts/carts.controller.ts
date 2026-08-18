import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { MergeCartDto, SetCartItemDto } from './carts.dto';
import { CartsService } from './carts.service';

@Controller()
export class CartsController {
  constructor(private readonly carts: CartsService) {}

  @Post('carts/guest')
  createGuestCart() {
    return this.carts.createGuestCart();
  }

  @Get('cart')
  @UseGuards(OptionalClerkAuthGuard)
  getCart(@Req() request: AuthenticatedRequest) {
    return this.carts.getCurrent(request);
  }

  @Patch('cart/items')
  @UseGuards(OptionalClerkAuthGuard)
  setItem(@Req() request: AuthenticatedRequest, @Body() body: SetCartItemDto) {
    return this.carts.setItem(request, body);
  }

  @Delete('cart/items/:itemId')
  @UseGuards(OptionalClerkAuthGuard)
  deleteItem(
    @Req() request: AuthenticatedRequest,
    @Param('itemId') itemId: string,
  ) {
    return this.carts.deleteItem(request, itemId);
  }

  @Post('cart/merge')
  @UseGuards(ClerkAuthGuard)
  merge(@Req() request: AuthenticatedRequest, @Body() body: MergeCartDto) {
    return this.carts.merge(getUserSub(request), body.guestToken);
  }
}

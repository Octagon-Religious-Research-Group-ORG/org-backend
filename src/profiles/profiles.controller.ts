import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAccessService } from '../auth/admin-access.service';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getCapabilities, getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ProfilesService } from './profiles.service';
import { ShippingAddressDto, UpdateProfileDto } from './profiles.dto';

@Controller('me')
@UseGuards(ClerkAuthGuard)
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly adminAccess: AdminAccessService,
  ) {}

  @Get()
  async getMe(@Req() request: AuthenticatedRequest) {
    return this.adminAccess.synchronizeProfile(request);
  }

  @Get('capabilities')
  async getCapabilities(@Req() request: AuthenticatedRequest) {
    const tokenCapabilities = getCapabilities(request);
    if (Object.values(tokenCapabilities).every(Boolean)) {
      return tokenCapabilities;
    }
    return getCapabilities(
      request,
      await this.adminAccess.hasAdminAccess(request),
    );
  }

  @Patch()
  updateMe(
    @Req() request: AuthenticatedRequest,
    @Body() body: UpdateProfileDto,
  ) {
    return this.profiles.update(getUserSub(request), body);
  }

  @Get('shipping')
  async getShipping(@Req() request: AuthenticatedRequest) {
    const profile = await this.profiles.getOrCreate(getUserSub(request));
    return profile.shippingAddress ?? null;
  }

  @Patch('shipping')
  updateShipping(
    @Req() request: AuthenticatedRequest,
    @Body() body: ShippingAddressDto,
  ) {
    return this.profiles.updateShipping(getUserSub(request), body);
  }

  @Delete('shipping')
  deleteShipping(@Req() request: AuthenticatedRequest) {
    return this.profiles.deleteShipping(getUserSub(request));
  }
}

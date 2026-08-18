import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  MemberProfile,
  MemberProfileSchema,
} from '../profiles/schemas/member-profile.schema';
import { AdminAccessService } from './admin-access.service';
import { ClerkUserInfoService } from './clerk-user-info.service';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from './auth.guard';
import { PermissionsGuard } from './permissions.guard';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: MemberProfile.name,
        schema: MemberProfileSchema,
      },
    ]),
  ],
  providers: [
    AdminAccessService,
    ClerkAuthGuard,
    ClerkUserInfoService,
    OptionalClerkAuthGuard,
    PermissionsGuard,
  ],
  exports: [
    AdminAccessService,
    ClerkAuthGuard,
    ClerkUserInfoService,
    OptionalClerkAuthGuard,
    PermissionsGuard,
  ],
})
export class AuthModule {}

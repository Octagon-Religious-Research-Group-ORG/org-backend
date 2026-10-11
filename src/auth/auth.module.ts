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
import { RolesService } from './roles.service';
import { ModerationModule } from '../moderation/moderation.module';

@Global()
@Module({
  imports: [
    ModerationModule,
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
    RolesService,
  ],
  exports: [
    AdminAccessService,
    ClerkAuthGuard,
    ClerkUserInfoService,
    OptionalClerkAuthGuard,
    PermissionsGuard,
    RolesService,
  ],
})
export class AuthModule {}

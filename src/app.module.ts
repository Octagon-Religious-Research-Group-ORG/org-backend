import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { envValidationSchema } from './config/env.schema';
import { DEFAULT_THROTTLE } from './config/throttle';
import { SocialModule } from './social/social.module';
import { DbModule } from './db/db.module';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { CartsModule } from './carts/carts.module';
import { ProfilesModule } from './profiles/profiles.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { configureDnsServers } from './config/dns';
import { ContentModule } from './content/content.module';
import { MembershipModule } from './membership/membership.module';
import { MembersModule } from './members/members.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        configureDnsServers(config.get<string>('DNS_SERVERS'));
        return {
          uri: config.getOrThrow<string>('MONGODB_URI'),
        };
      },
    }),
    ThrottlerModule.forRoot([DEFAULT_THROTTLE]),
    AuthModule,
    NotificationsModule,
    ProductsModule,
    CartsModule,
    ProfilesModule,
    OrdersModule,
    ContentModule,
    SocialModule,
    MembershipModule,
    MembersModule,
    DbModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

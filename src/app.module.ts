import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as Joi from 'joi';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { CartsModule } from './carts/carts.module';
import { ProfilesModule } from './profiles/profiles.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { configureDnsServers } from './config/dns';
import { ContentModule } from './content/content.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().port().default(3001),
        MONGODB_URI: Joi.string().required(),
        DNS_SERVERS: Joi.string().allow('').optional(),
        CLERK_SECRET_KEY: Joi.string().required(),
        WHITE_LISTED_EMAILS: Joi.string().allow('').default(''),
        CLIENT_ORIGIN_URL: Joi.string().required(),
        PUBLIC_APP_URL: Joi.string().uri().required(),
        PAYPAL_DONATION_URL: Joi.string().uri().required(),
        VENMO_DONATION_URL: Joi.string().uri().required(),
        RESEND_API_KEY: Joi.string().allow('').optional(),
        ORDER_FROM_EMAIL: Joi.string().email().allow('').optional(),
        ORDER_NOTIFICATION_EMAIL: Joi.string().email().allow('').optional(),
      }),
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
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    AuthModule,
    NotificationsModule,
    ProductsModule,
    CartsModule,
    ProfilesModule,
    OrdersModule,
    ContentModule,
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

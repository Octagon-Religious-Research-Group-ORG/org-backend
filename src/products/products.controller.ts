import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readSiteEnv } from '../config/site-env';
import { ProductsService } from './products.service';
import type { ProductCategory } from './schemas/product.schema';

const CATEGORIES: ProductCategory[] = [
  'vaporizer-accessories',
  '3d-printed-parts',
  'laboratory-tools',
];

@Controller()
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly config: ConfigService,
  ) {}

  @Get('products')
  findAll(@Query('category') category?: string) {
    if (category && !CATEGORIES.includes(category as ProductCategory)) {
      throw new BadRequestException('Unknown offering category.');
    }
    return this.products.findAll(category as ProductCategory | undefined);
  }

  @Get('products/:slug')
  findOne(@Param('slug') slug: string) {
    return this.products.findBySlug(slug);
  }

  /**
   * Where donations are completed. On the test site the real PayPal and Venmo
   * accounts are never returned, whatever the URL settings say: the links
   * point back to the test site and `testSite` lets the page say so.
   */
  @Get('donation-config')
  getDonationConfig() {
    const base = {
      currency: 'USD',
      suggestedShippingCents: 1500,
      verification: 'manual',
    };
    if (readSiteEnv(this.config) === 'test') {
      const testUrl = `${this.config.getOrThrow<string>('PUBLIC_APP_URL')}/offerings`;
      return {
        ...base,
        testSite: true,
        paypalUrl: testUrl,
        venmoUrl: testUrl,
        paypalHandle: '(test site: no real payment)',
        venmoHandle: '(test site: no real payment)',
      };
    }
    return {
      ...base,
      testSite: false,
      paypalUrl: this.config.getOrThrow<string>('PAYPAL_DONATION_URL'),
      venmoUrl: this.config.getOrThrow<string>('VENMO_DONATION_URL'),
      paypalHandle: '@trippaardema',
      venmoHandle: '@the_org',
    };
  }
}

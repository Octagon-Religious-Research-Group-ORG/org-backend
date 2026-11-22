import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductCategory =
  'vaporizer-accessories' | '3d-printed-parts' | 'laboratory-tools';

@Schema({ _id: false })
export class ProductVariant {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, required: true })
  label: string;

  @Prop({ type: Number })
  suggestedDonationCents?: number;

  @Prop({ type: Object, default: {} })
  options: Record<string, string>;
}

export const ProductVariantSchema =
  SchemaFactory.createForClass(ProductVariant);

@Schema({ timestamps: true })
export class Product {
  @Prop({ type: String, required: true, unique: true, index: true })
  slug: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, required: true })
  category: ProductCategory;

  @Prop({ type: String, required: true })
  summary: string;

  @Prop({ type: String, required: true })
  description: string;

  @Prop({ type: [String], default: [] })
  specifications: string[];

  @Prop({ type: String, required: true })
  imageUrl: string;

  @Prop({ type: String, required: true })
  imageAlt: string;

  @Prop({ type: String, default: 'active' })
  availability: 'active' | 'made-to-order' | 'paused';

  @Prop({ type: [ProductVariantSchema], required: true })
  variants: ProductVariant[];

  createdAt?: Date;
  updatedAt?: Date;
}

export type ProductDocument = HydratedDocument<Product>;
export const ProductSchema = SchemaFactory.createForClass(Product);

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  MemberProfile,
  MemberProfileDocument,
} from './schemas/member-profile.schema';
import { ShippingAddressDto, UpdateProfileDto } from './profiles.dto';

@Injectable()
export class ProfilesService {
  constructor(
    @InjectModel(MemberProfile.name)
    private readonly profileModel: Model<MemberProfileDocument>,
  ) {}

  async getOrCreate(authProviderId: string) {
    return this.profileModel
      .findOneAndUpdate(
        { authProviderId },
        { $setOnInsert: { authProviderId } },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .lean()
      .exec();
  }

  async getDocument(authProviderId: string) {
    return this.profileModel
      .findOneAndUpdate(
        { authProviderId },
        { $setOnInsert: { authProviderId } },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async update(authProviderId: string, input: UpdateProfileDto) {
    return this.profileModel
      .findOneAndUpdate(
        { authProviderId },
        {
          $set: {
            preferredName: input.preferredName.trim(),
            email: input.email.trim().toLowerCase(),
            membershipType: input.membershipType,
            contactMethod: input.contactMethod,
            contactHandle: input.contactHandle.trim(),
            beliefsSummary: input.beliefsSummary.trim(),
          },
        },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .lean()
      .exec();
  }

  async updateShipping(authProviderId: string, input: ShippingAddressDto) {
    return this.profileModel
      .findOneAndUpdate(
        { authProviderId },
        {
          $set: {
            shippingAddress: {
              ...input,
              recipientName: input.recipientName.trim(),
              line1: input.line1.trim(),
              line2: input.line2?.trim() || undefined,
              city: input.city.trim(),
              state: input.state.toUpperCase(),
              postalCode: input.postalCode.trim(),
              phone: input.phone?.trim() || undefined,
              country: 'US',
            },
          },
        },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .lean()
      .exec();
  }

  async deleteShipping(authProviderId: string) {
    return this.profileModel
      .findOneAndUpdate(
        { authProviderId },
        { $unset: { shippingAddress: 1 } },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .lean()
      .exec();
  }
}

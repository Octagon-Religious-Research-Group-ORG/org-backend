import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ManagedIndexesService } from './managed-indexes.service';
import { MANAGED_SCHEMAS } from './managed-schemas';

/** Index management for the collections with `autoIndex: false`. */
@Module({
  imports: [MongooseModule.forFeature([...MANAGED_SCHEMAS])],
  providers: [ManagedIndexesService],
})
export class DbModule {}

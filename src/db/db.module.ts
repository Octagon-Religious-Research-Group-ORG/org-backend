import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ManagedIndexesService } from './managed-indexes.service';
import { MANAGED_SCHEMAS } from './managed-schemas';
import { ReplicaSetCheckService } from './replica-set-check.service';

/**
 * Index management for the collections with `autoIndex: false`, and the
 * startup check that the database can run transactions (claims).
 */
@Module({
  imports: [MongooseModule.forFeature([...MANAGED_SCHEMAS])],
  providers: [ManagedIndexesService, ReplicaSetCheckService],
})
export class DbModule {}

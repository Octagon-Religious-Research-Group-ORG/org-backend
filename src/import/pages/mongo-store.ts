import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose, { type Connection, type Model } from 'mongoose';
import { BlockVersionsService } from '../../social/block-versions.service';
import type { BlockVersionDocument } from '../../social/schemas/block-version.schema';
import type { ProfileBlockDocument } from '../../social/schemas/profile-block.schema';
import { MANAGED_SCHEMAS } from '../../db/managed-schemas';
import type { ImportStore } from './execute-import';
import type { ProcessedImage } from './image';

/** GridFS bucket holding profile pictures, gallery photos and inline images. */
export const PROFILE_IMAGE_BUCKET = 'profileimages';

/**
 * The import's writes, over a plain Mongoose connection (the CLI runs outside
 * Nest). Block text goes through BlockVersionsService, the same code the API
 * uses, so imported versions are hash-chained exactly like edits.
 */
export class MongoImportStore implements ImportStore {
  private readonly models: Record<string, Model<unknown>>;
  private readonly versions: BlockVersionsService;

  constructor(private readonly connection: Connection) {
    this.models = Object.fromEntries(
      MANAGED_SCHEMAS.map(({ name, schema }) => [
        name,
        connection.models[name] ?? connection.model(name, schema),
      ]),
    );
    this.versions = new BlockVersionsService(
      this.models.BlockVersion as unknown as Model<BlockVersionDocument>,
      this.models.ProfileBlock as unknown as Model<ProfileBlockDocument>,
    );
  }

  model(name: string): Model<unknown> {
    return this.models[name];
  }

  async profileExists(slug: string) {
    return (await this.models.SocialProfile.exists({ slug })) !== null;
  }

  async createTab(row: Record<string, unknown>) {
    await this.models.BeliefTab.create(row);
  }

  async createBlock(row: Record<string, unknown>) {
    await this.models.ProfileBlock.create(row);
  }

  async appendVersion(input: {
    blockId: string;
    text: string;
    authorUserId: string;
  }) {
    await this.versions.appendVersion(input);
  }

  verifyBlock(blockId: string) {
    return this.versions.verifyBlock(blockId);
  }

  async createComment(row: Record<string, unknown>) {
    await this.models.Comment.create(row);
  }

  async storeImage(image: ProcessedImage, metadata: Record<string, unknown>) {
    const bucket = new mongoose.mongo.GridFSBucket(this.connection.db!, {
      bucketName: PROFILE_IMAGE_BUCKET,
    });
    const upload = bucket.openUploadStream(`${String(metadata.source)}.webp`, {
      metadata: {
        ...metadata,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
      },
    });
    await pipeline(Readable.from([image.data]), upload);
    return upload.id.toString();
  }

  async createImportRecord(row: Record<string, unknown>) {
    await this.models.ImportRecord.create(row);
  }

  /**
   * TEST DATABASES ONLY (the CLI refuses any other): deletes migrated profiles
   * with these addresses, every row of theirs (append-only versions and import
   * records included, through the raw driver on purpose), rows a failed
   * import left without a profile, and their pictures.
   */
  async removeImported(slugs: string[]) {
    const db = this.connection.db!;
    const profiles = await db
      .collection('socialprofiles')
      .find({ slug: { $in: slugs }, source: 'migrated' })
      .project({ _id: 1 })
      .toArray();
    const existing = new Set(
      (
        await db
          .collection('socialprofiles')
          .find()
          .project({ _id: 1 })
          .toArray()
      ).map((row) => String(row._id)),
    );
    const profileIds: unknown[] = profiles.map((row) => row._id as unknown);
    const targets: unknown[] = [...profileIds];
    for (const name of [
      'belieftabs',
      'profileblocks',
      'comments',
      'importrecords',
    ]) {
      for (const id of await db.collection(name).distinct('profileId')) {
        if (!existing.has(String(id))) targets.push(id);
      }
    }
    const blockIds = (
      await db
        .collection('profileblocks')
        .find({ profileId: { $in: targets } })
        .project({ blockId: 1 })
        .toArray()
    ).map((row) => row.blockId as string);

    const counts: Record<string, number> = {};
    const remove = async (name: string, filter: object) => {
      counts[name] = (
        await db.collection(name).deleteMany(filter)
      ).deletedCount;
    };
    await remove('blockversions', { blockId: { $in: blockIds } });
    for (const name of [
      'belieftabs',
      'profileblocks',
      'comments',
      'importrecords',
    ]) {
      await remove(name, { profileId: { $in: targets } });
    }
    await remove('socialprofiles', {
      _id: { $in: profileIds },
    });

    const bucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: PROFILE_IMAGE_BUCKET,
    });
    const files = await bucket
      .find({ 'metadata.profileSlug': { $in: slugs } })
      .toArray();
    for (const file of files) await bucket.delete(file._id);
    counts.images = files.length;
    return counts;
  }

  async createProfile(row: Record<string, unknown>) {
    await this.models.SocialProfile.create(row);
  }
}

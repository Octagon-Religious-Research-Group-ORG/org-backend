import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { type Connection } from 'mongoose';
import type { ProcessedImage } from '../import/pages/image';
import { PROFILE_IMAGE_BUCKET } from '../import/pages/mongo-store';

export const STORED_PICTURE_TYPE = 'image/webp';

/** The role the importer and uploads give the member's own picture. */
const PROFILE_PICTURE_ROLE = 'picture';

export interface StoredPicture {
  data: Buffer;
  fileId: string;
}

interface FileMetadata {
  role?: unknown;
  contentType?: unknown;
  retiredAt?: unknown;
}

function asObjectId(id: string) {
  return mongoose.isObjectIdOrHexString(id)
    ? new mongoose.Types.ObjectId(id)
    : undefined;
}

/** A live profile picture: the right role, the stored form, and not retired. */
function isServable(metadata: FileMetadata | undefined) {
  return (
    metadata?.role === PROFILE_PICTURE_ROLE &&
    metadata.contentType === STORED_PICTURE_TYPE &&
    metadata.retiredAt === undefined
  );
}

/**
 * The `profileimages` GridFS bucket. It knows nothing about access: callers
 * decide first, and no route takes a file id from a client.
 *
 * Files are kept for the retention period (at least 5 years): a replaced
 * picture is retired, never deleted. Only a file that was never live may be
 * removed.
 */
@Injectable()
export class PictureStore {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private bucket() {
    return new mongoose.mongo.GridFSBucket(this.connection.db!, {
      bucketName: PROFILE_IMAGE_BUCKET,
    });
  }

  /** @returns the picture, or undefined unless it is a live profile picture */
  async read(id: string): Promise<StoredPicture | undefined> {
    const _id = asObjectId(id);
    if (!_id) return undefined;
    const [file] = await this.bucket().find({ _id }).toArray();
    if (!isServable(file?.metadata)) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of this.bucket().openDownloadStream(file._id)) {
      chunks.push(chunk as Buffer);
    }
    return { data: Buffer.concat(chunks), fileId: id };
  }

  /** @returns which of these files are live profile pictures */
  async livePictures(ids: string[]): Promise<Set<string>> {
    const _ids = ids.flatMap((id) => asObjectId(id) ?? []);
    if (_ids.length === 0) return new Set();
    const files = await this.bucket()
      .find({ _id: { $in: _ids } })
      .toArray();
    return new Set(
      files
        .filter((file) => isServable(file.metadata))
        .map((file) => file._id.toString()),
    );
  }

  /** @returns the first listed file that is a live profile picture, if any */
  async currentPicture(imageIds: string[]): Promise<string | undefined> {
    const live = await this.livePictures(imageIds);
    return imageIds.find((id) => live.has(id));
  }

  /** @returns the new file's id */
  async store(image: ProcessedImage, profileSlug: string): Promise<string> {
    const upload = this.bucket().openUploadStream(`${profileSlug}.webp`, {
      metadata: {
        profileSlug,
        role: PROFILE_PICTURE_ROLE,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
      },
    });
    await pipeline(Readable.from([image.data]), upload);
    return upload.id.toString();
  }

  /**
   * Marks a replaced file as retired. It stays in the bucket for the retention
   * period, and no serving path returns it again.
   */
  async retire(id: string, at: Date): Promise<void> {
    const _id = asObjectId(id);
    if (!_id) return;
    await this.connection
      .db!.collection(`${PROFILE_IMAGE_BUCKET}.files`)
      .updateOne(
        { _id, 'metadata.retiredAt': { $exists: false } },
        { $set: { 'metadata.retiredAt': at } },
      );
  }

  /** Only for a file that was never live: see the note on retention above. */
  async remove(id: string): Promise<void> {
    const _id = asObjectId(id);
    if (_id) await this.bucket().delete(_id);
  }
}

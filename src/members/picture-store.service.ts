import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { type Connection } from 'mongoose';
import type { ProcessedImage } from '../import/pages/image';
import { PROFILE_IMAGE_BUCKET } from '../import/pages/mongo-store';

export const STORED_PICTURE_TYPE = 'image/webp';

export interface StoredPicture {
  data: Buffer;
  fileId: string;
}

function asObjectId(id: string) {
  return mongoose.isObjectIdOrHexString(id)
    ? new mongoose.Types.ObjectId(id)
    : undefined;
}

/**
 * The `profileimages` GridFS bucket. It knows nothing about access: callers
 * decide first, and no route takes a file id from a client.
 */
@Injectable()
export class PictureStore {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private bucket() {
    return new mongoose.mongo.GridFSBucket(this.connection.db!, {
      bucketName: PROFILE_IMAGE_BUCKET,
    });
  }

  private async file(id: string) {
    const _id = asObjectId(id);
    if (!_id) return undefined;
    const [file] = await this.bucket().find({ _id }).toArray();
    return file;
  }

  /** @returns the picture, or undefined when missing or not a stored WebP */
  async read(id: string): Promise<StoredPicture | undefined> {
    const file = await this.file(id);
    if (file?.metadata?.contentType !== STORED_PICTURE_TYPE) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of this.bucket().openDownloadStream(file._id)) {
      chunks.push(chunk as Buffer);
    }
    return { data: Buffer.concat(chunks), fileId: id };
  }

  /** @returns the `role` an imported picture was stored with, if any */
  async roleOf(id: string): Promise<unknown> {
    return (await this.file(id))?.metadata?.role;
  }

  /** @returns the new file's id */
  async store(image: ProcessedImage, profileSlug: string): Promise<string> {
    const upload = this.bucket().openUploadStream(`${profileSlug}.webp`, {
      metadata: {
        profileSlug,
        role: 'picture',
        contentType: image.contentType,
        width: image.width,
        height: image.height,
      },
    });
    await pipeline(Readable.from([image.data]), upload);
    return upload.id.toString();
  }

  async remove(id: string): Promise<void> {
    const _id = asObjectId(id);
    if (_id) await this.bucket().delete(_id);
  }
}

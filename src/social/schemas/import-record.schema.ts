import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { makeAppendOnly } from '../append-only';

export const IMPORT_SOURCE_KINDS = ['docx', 'pages'] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KINDS)[number];

@Schema({ _id: false })
export class ImportSourceFile {
  @Prop({ type: String, enum: IMPORT_SOURCE_KINDS, required: true })
  kind: ImportSourceKind;

  @Prop({ type: String, required: true })
  fileName: string;

  @Prop({ type: Number, required: true, min: 0 })
  bytes: number;

  @Prop({ type: String, required: true, match: /^[0-9a-f]{64}$/ })
  sha256: string;
}

export const ImportSourceFileSchema =
  SchemaFactory.createForClass(ImportSourceFile);

/**
 * What one Apple Pages import read and produced. **Append-only.**
 *
 * Keeps the full extracted text exactly as it came out of the export, so the
 * original survives however its beliefs are later split, merged or renamed
 * (plan §2c: "nothing is lost"), plus the SHA-256 of every source file so the
 * import can be tied to the downloaded originals.
 */
@Schema({
  collection: 'importrecords',
  autoIndex: false,
  versionKey: false,
})
export class ImportRecord {
  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  profileId: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  slug: string;

  @Prop({ type: String, required: true, immutable: true })
  pagesUrl: string;

  @Prop({ type: [ImportSourceFileSchema], required: true, immutable: true })
  sources: ImportSourceFile[];

  @Prop({ type: String, required: true, immutable: true })
  extractedText: string;

  /** The validation report for this profile, as produced by the importer. */
  @Prop({ type: Object, required: true, immutable: true })
  report: Record<string, unknown>;

  @Prop({ type: String, required: true, immutable: true })
  importerVersion: string;

  @Prop({ type: Date, required: true, immutable: true })
  importedAt: Date;
}

export type ImportRecordDocument = HydratedDocument<ImportRecord>;
export const ImportRecordSchema = SchemaFactory.createForClass(ImportRecord);

ImportRecordSchema.index({ profileId: 1, importedAt: -1 });

makeAppendOnly(ImportRecordSchema, 'importrecords');

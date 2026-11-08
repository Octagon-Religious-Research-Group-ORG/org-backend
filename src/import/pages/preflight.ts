import mongoose, { Types } from 'mongoose';
import { MANAGED_SCHEMAS } from '../../db/managed-schemas';
import { buildRows, type ImportInputs, type Row } from './execute-import';
import type { ImportPlan } from './import-plan';
import type { ProcessedImage } from './image';

/** A placeholder: a real hash is 64 hex characters, like this. */
const NO_HASH = '0'.repeat(64);

/**
 * The real schemas, on a Mongoose instance that is never connected, so a dry
 * run applies exactly the rules the writes will meet.
 */
function validators() {
  const instance = new mongoose.Mongoose();
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
  instance.set('bufferCommands', false);
  return new Map(
    MANAGED_SCHEMAS.map(({ name, schema }) => [
      name,
      instance.model(name, schema),
    ]),
  );
}

/**
 * Everything that could make the real write fail, checked without a database:
 * every planned row against its real schema and every picture through the real
 * converter. This is what lets a dry run fail for the same reasons as the real
 * run, instead of passing and then stopping part-way through the profiles.
 *
 * Messages name the row and the rule, never the member's text.
 *
 * @returns one line per problem; empty when the plan can be written
 */
export async function preflightImport(
  plan: ImportPlan,
  inputs: Omit<ImportInputs, 'report' | 'now'>,
  processImage: (bytes: Uint8Array) => Promise<ProcessedImage>,
): Promise<string[]> {
  const errors: string[] = [];

  const paths = new Set([
    ...plan.blocks.filter((b) => b.kind === 'image').map((b) => b.text),
    ...plan.images.map((image) => image.path),
  ]);
  for (const path of paths) {
    const file = inputs.files.get(path);
    if (!file) {
      errors.push(`Image ${path} is not among the source files.`);
      continue;
    }
    try {
      await processImage(file);
    } catch (error) {
      errors.push(
        `Image ${path} could not be converted: ${(error as Error).message}`,
      );
    }
  }

  const { rows } = buildRows(
    plan,
    { ...inputs, report: { preflight: true } },
    new Types.ObjectId(),
    new Date(),
    {
      inline: new Map([...paths].map((path) => [path, 'preflight'])),
      imageIds: plan.images.map(() => 'preflight'),
    },
  );

  const models = validators();
  const check = async (model: string, label: string, row: Row) => {
    const Model = models.get(model)!;
    try {
      await new Model(row).validate();
    } catch (error) {
      const failures = (error as mongoose.Error.ValidationError).errors;
      const details = Object.entries(failures).map(
        ([path, failure]) =>
          `${path}: ${failure.kind === 'user defined' ? failure.message : failure.kind}`,
      );
      errors.push(`${label}: ${details.join('; ')}`);
    }
  };

  for (const [at, tab] of rows.tabs.entries()) {
    await check('BeliefTab', `Tab ${at + 1}`, tab);
  }
  for (const [at, block] of rows.blocks.entries()) {
    const paragraph = plan.blocks[at].paragraph;
    await check('ProfileBlock', `Block for paragraph ${paragraph}`, block);
    await check('BlockVersion', `Text of paragraph ${paragraph}`, {
      ...rows.versions[at],
      seq: 1,
      createdAt: new Date(),
      prevHash: NO_HASH,
      hash: NO_HASH,
    });
  }
  for (const [at, comment] of rows.comments.entries()) {
    await check('Comment', `Comment ${at + 1}`, comment);
  }
  await check('ImportRecord', 'Import record', rows.importRecord);
  await check('SocialProfile', 'Profile', rows.profile);
  return errors;
}

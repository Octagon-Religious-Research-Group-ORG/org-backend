import type { Model, Types } from 'mongoose';
import type { BlockVersionDocument } from '../../social/schemas/block-version.schema';
import type { ProfileBlockDocument } from '../../social/schemas/profile-block.schema';
import { readHeads } from '../../social/version-heads';
import { visibleFieldBlocks } from '../editable-fields';
import type { ParagraphView } from '../profile-serializers';

export interface BeliefText {
  /**
   * The newest version of the belief's first text block: what an edit, a
   * suggestion and a vote are based on. 0 when it has no text.
   */
  textSeq: number;
  paragraphs: ParagraphView[];
}

interface BlockRow {
  blockId: string;
  tabId: string;
  kind: ParagraphView['kind'];
  label?: string;
}

/**
 * The current text of some beliefs, read exactly as the page and the editor
 * read it: the live text blocks of each tab in reading order (ties by _id),
 * each shown at its newest version, and the first block's newest version as
 * the belief's text version (`MemberPageEditorService.readTabText`; a spec
 * checks both agree).
 *
 * @param beliefs - the tabs to read, each with its page
 */
export async function readBeliefTexts(
  blockModel: Model<ProfileBlockDocument>,
  versionModel: Model<BlockVersionDocument>,
  beliefs: ReadonlyArray<{ profileId: Types.ObjectId; tabId: string }>,
): Promise<Map<string, BeliefText>> {
  if (beliefs.length === 0) return new Map();
  const blocks = (await blockModel
    .find({
      profileId: { $in: beliefs.map((belief) => belief.profileId) },
      section: 'beliefs',
      tabId: { $in: beliefs.map((belief) => belief.tabId) },
      kind: { $ne: 'image' },
      removedAt: { $exists: false },
    })
    .sort({ order: 1, _id: 1 })
    .select({ blockId: 1, tabId: 1, kind: 1, label: 1 })
    .lean()
    .exec()) as unknown as BlockRow[];
  const heads = await readHeads(
    versionModel,
    blocks.map((block) => block.blockId),
  );
  const headSeq = (blockId: string) => heads.get(blockId)?.seq ?? 0;
  return new Map(
    beliefs.map(({ tabId }) => {
      const own = blocks.filter((block) => block.tabId === tabId);
      return [
        tabId,
        {
          textSeq: own[0] ? headSeq(own[0].blockId) : 0,
          paragraphs: visibleFieldBlocks(own, headSeq).flatMap((block) => {
            const text = heads.get(block.blockId)?.text;
            return text === undefined
              ? []
              : [
                  {
                    blockId: block.blockId,
                    kind: block.kind,
                    label: block.label ?? '',
                    text,
                  },
                ];
          }),
        },
      ];
    }),
  );
}

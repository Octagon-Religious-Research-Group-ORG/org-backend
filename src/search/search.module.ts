import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  WebsitePage,
  WebsitePageSchema,
} from '../content/schemas/website-page.schema';
import { MembersModule } from '../members/members.module';
import { ModerationModule } from '../moderation/moderation.module';
import {
  BeliefTab,
  BeliefTabSchema,
} from '../social/schemas/belief-tab.schema';
import {
  BlockVersion,
  BlockVersionSchema,
} from '../social/schemas/block-version.schema';
import {
  ProfileBlock,
  ProfileBlockSchema,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { SearchEntry, SearchEntrySchema } from './schemas/search-entry.schema';
import {
  SearchFragmentHide,
  SearchFragmentHideSchema,
} from './schemas/search-fragment-hide.schema';
import {
  SearchTermDay,
  SearchTermDaySchema,
} from './schemas/search-term-day.schema';
import {
  AdminSearchFragmentsController,
  SearchController,
} from './search.controller';
import { SearchEngineService } from './search-engine.service';
import { SearchFragmentsService } from './search-fragments.service';
import { SearchIndexerService } from './search-indexer.service';
import { SearchService } from './search.service';

/**
 * Search over member names, beliefs and ORG pages, and the Perforated
 * Index's Suggested Fragments (Chunk 15).
 */
@Module({
  imports: [
    MembersModule,
    ModerationModule,
    MongooseModule.forFeature([
      { name: SearchEntry.name, schema: SearchEntrySchema },
      { name: SearchTermDay.name, schema: SearchTermDaySchema },
      { name: SearchFragmentHide.name, schema: SearchFragmentHideSchema },
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: BeliefTab.name, schema: BeliefTabSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
      // Read only: the published ORG pages.
      { name: WebsitePage.name, schema: WebsitePageSchema },
    ]),
  ],
  controllers: [SearchController, AdminSearchFragmentsController],
  providers: [
    SearchService,
    SearchEngineService,
    SearchIndexerService,
    SearchFragmentsService,
  ],
})
export class SearchModule {}

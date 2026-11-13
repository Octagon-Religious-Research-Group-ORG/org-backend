import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { OrgPageIdGuard } from './org-page-id.guard';
import { ORG_PAGE_NOT_FOUND } from './org-pages.service';

function context(params: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
  } as unknown as ExecutionContext;
}

describe('OrgPageIdGuard (Chunk 10b round 2, N3)', () => {
  const guard = new OrgPageIdGuard();

  it('lets one of ORG’s page ids through, published or not', () => {
    expect(guard.canActivate(context({ pageId: 'about' }))).toBe(true);
    expect(guard.canActivate(context({ pageId: 'legal' }))).toBe(true);
  });

  it('answers any other id, or none, with the one 404', () => {
    for (const params of [
      { pageId: 'nope' },
      { pageId: 'org-page:about' },
      { pageId: ['about'] },
      {},
    ]) {
      expect(() => guard.canActivate(context(params))).toThrow(
        new NotFoundException(ORG_PAGE_NOT_FOUND),
      );
    }
  });
});

import { BadRequestException } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { article, messagesFor } from './connection-messages';
import {
  BAD_TERM,
  CONNECTION_NAME_KEY,
  ConnectionTermsService,
  DEFAULT_TERMS,
} from './connection-terms.service';

function build(value?: string) {
  const settings = fakeModel(
    value === undefined ? [] : [{ key: CONNECTION_NAME_KEY, value }],
  );
  const log = {
    record: jest.fn((entry: { action: string }) => Promise.resolve(entry)),
  };
  return {
    service: new ConnectionTermsService(settings as never, log as never),
    settings,
    log,
  };
}

describe('ConnectionTermsService', () => {
  it('calls it "connection request" until an admin renames it', async () => {
    await expect(build().service.terms()).resolves.toEqual(DEFAULT_TERMS);
  });

  it('reads back a name an admin set, and ignores anything unreadable', async () => {
    await expect(
      build(
        '{"singular":"introduction","plural":"introductions"}',
      ).service.terms(),
    ).resolves.toEqual({ singular: 'introduction', plural: 'introductions' });
    for (const bad of [
      'not json',
      '{"singular":"x"}',
      '{"singular":"<b>","plural":"ok"}',
      `{"singular":"${'a'.repeat(41)}","plural":"ok"}`,
    ]) {
      await expect(build(bad).service.terms()).resolves.toEqual(DEFAULT_TERMS);
    }
  });

  it('saves a new name, cleaned, and logs the change', async () => {
    const { service, settings, log } = build();
    await expect(
      service.setTerms('  Contact  Request ', 'Contact Requests', 'user_admin'),
    ).resolves.toEqual({
      singular: 'contact request',
      plural: 'contact requests',
    });
    expect(settings.docs[0]).toMatchObject({
      key: CONNECTION_NAME_KEY,
      updatedBy: 'user_admin',
    });
    await expect(service.terms()).resolves.toEqual({
      singular: 'contact request',
      plural: 'contact requests',
    });
    expect(log.record.mock.calls.map(([entry]) => entry.action)).toEqual([
      'setting.change.requested',
      'setting.change.applied',
    ]);
  });

  it('puts the default back when both names are empty', async () => {
    const { service, settings } = build('{"singular":"a b","plural":"c d"}');
    await expect(service.setTerms(' ', '', 'user_admin')).resolves.toEqual(
      DEFAULT_TERMS,
    );
    expect(settings.docs).toHaveLength(0);
  });

  it('refuses a name that is not words', async () => {
    const { service, log } = build();
    for (const [one, many] of [
      ['ok', ''],
      ['<script>', 'ok'],
      ['ok', '1234'],
    ]) {
      await expect(service.setTerms(one, many, 'user_admin')).rejects.toEqual(
        new BadRequestException(BAD_TERM),
      );
    }
    expect(log.record).not.toHaveBeenCalled();
  });
});

describe('connection messages', () => {
  it('use the admins’ name, with the right article', () => {
    expect(article('introduction')).toBe('an');
    expect(article('contact request')).toBe('a');
    const m = messagesFor({
      singular: 'introduction',
      plural: 'introductions',
    });
    expect(m.self).toBe('You cannot send an introduction to yourself.');
    expect(m.notOpen).toBe(
      'This member is not open to introductions from you.',
    );
  });
});

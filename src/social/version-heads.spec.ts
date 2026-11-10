import { readHeads } from './version-heads';

describe('readHeads', () => {
  it('asks for each block’s newest version and maps it by block', async () => {
    const exec = jest.fn(() =>
      Promise.resolve([
        { _id: 'a', seq: 3, text: 'Newest a' },
        { _id: 'b', seq: 1, text: 'Only b' },
      ]),
    );
    const model = { aggregate: jest.fn(() => ({ exec })) };
    const heads = await readHeads(model as never, ['a', 'b', 'c']);
    expect(model.aggregate).toHaveBeenCalledWith([
      { $match: { blockId: { $in: ['a', 'b', 'c'] } } },
      { $sort: { blockId: 1, seq: -1 } },
      {
        $group: {
          _id: '$blockId',
          seq: { $first: '$seq' },
          text: { $first: '$text' },
        },
      },
    ]);
    expect([...heads]).toEqual([
      ['a', { seq: 3, text: 'Newest a' }],
      ['b', { seq: 1, text: 'Only b' }],
    ]);
  });

  it('asks nothing for no blocks', async () => {
    const model = { aggregate: jest.fn() };
    expect((await readHeads(model as never, [])).size).toBe(0);
    expect(model.aggregate).not.toHaveBeenCalled();
  });
});

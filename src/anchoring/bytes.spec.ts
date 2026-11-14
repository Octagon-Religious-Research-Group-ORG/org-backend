import { mongo } from 'mongoose';
import { asBytes, withBytes } from './bytes';

const { Binary } = mongo;

describe('stored bytes', () => {
  it('reads a Buffer, a Uint8Array and a BSON Binary by its data, not its capacity', () => {
    expect(asBytes(Buffer.from('ab'))).toEqual(Buffer.from('ab'));
    expect(asBytes(new Uint8Array([1, 2]))).toEqual(Buffer.from([1, 2]));
    // A Binary built for growth: 256 bytes of room, 3 of data.
    const growing = new Binary();
    growing.write(Buffer.from('xyz'), 0);
    expect(growing.buffer.length).toBeGreaterThan(3);
    expect(asBytes(growing)).toEqual(Buffer.from('xyz'));
  });

  it('anything else is no bytes at all', () => {
    for (const value of [undefined, null, 'text', 7, {}]) {
      expect(asBytes(value)).toBeUndefined();
    }
  });

  it('converts an anchor’s token and proof, and leaves an anchor without them alone', () => {
    const binary = new Binary(Buffer.from('tok'));
    const anchor = withBytes({
      _id: 'd',
      status: 'built',
      tsa: { status: 'granted', attempts: 1, response: binary as never },
      ots: { status: 'pending', attempts: 1, proof: binary as never },
    });
    expect(anchor.tsa?.response).toEqual(Buffer.from('tok'));
    expect(anchor.ots?.proof).toEqual(Buffer.from('tok'));
    expect(withBytes({ _id: 'e', status: 'building' })).toEqual({
      _id: 'e',
      status: 'building',
    });
  });
});

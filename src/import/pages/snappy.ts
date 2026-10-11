/**
 * Decompresses one raw Snappy block (no framing), as used inside Apple iWork
 * `.iwa` files. Format: a varint with the uncompressed length, then literal
 * and back-reference elements.
 *
 * Every read is bounds-checked: a truncated or corrupt block throws instead of
 * producing a plausible-looking partial result.
 *
 * @see https://github.com/google/snappy/blob/main/format_description.txt
 */
export function snappyDecompress(input: Uint8Array): Uint8Array {
  let position = 0;
  const byte = () => {
    if (position >= input.length) throw new Error('Snappy block is truncated.');
    return input[position++];
  };

  let length = 0;
  for (let shift = 0; ; shift += 7) {
    if (shift > 28) throw new Error('Snappy length varint is too long.');
    const next = byte();
    length += (next & 0x7f) * 2 ** shift;
    if (next < 0x80) break;
  }

  const output = new Uint8Array(length);
  let written = 0;
  const littleEndian = (count: number) => {
    let value = 0;
    for (let index = 0; index < count; index++) {
      value += byte() * 2 ** (8 * index);
    }
    return value;
  };

  while (position < input.length) {
    const tag = byte();
    const type = tag & 3;
    if (type === 0) {
      let literal = tag >> 2;
      if (literal >= 60) literal = littleEndian(literal - 59);
      literal += 1;
      if (position + literal > input.length || written + literal > length) {
        throw new Error('Snappy literal runs past the end of the block.');
      }
      output.set(input.subarray(position, position + literal), written);
      position += literal;
      written += literal;
      continue;
    }

    let copy: number;
    let offset: number;
    if (type === 1) {
      copy = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | byte();
    } else {
      copy = (tag >> 2) + 1;
      offset = littleEndian(type === 2 ? 2 : 4);
    }
    if (offset === 0 || offset > written || written + copy > length) {
      throw new Error('Snappy copy points outside the decompressed data.');
    }
    // Byte by byte: a copy may overlap the bytes it is producing.
    for (let index = 0; index < copy; index++, written++) {
      output[written] = output[written - offset];
    }
  }

  if (written !== length) {
    throw new Error(
      `Snappy block declared ${length} bytes but produced ${written}.`,
    );
  }
  return output;
}

/**
 * Decompresses an Apple `.iwa` file: a sequence of chunks, each a 0x00 header
 * byte, a 3-byte little-endian length and one raw Snappy block.
 */
export function decompressIwa(input: Uint8Array, part: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let position = 0;
  while (position < input.length) {
    if (input[position] !== 0 || position + 4 > input.length) {
      throw new Error(`${part}: not an IWA chunk at byte ${position}.`);
    }
    const size =
      input[position + 1] |
      (input[position + 2] << 8) |
      (input[position + 3] << 16);
    const end = position + 4 + size;
    if (end > input.length) {
      throw new Error(`${part}: chunk at byte ${position} is truncated.`);
    }
    try {
      chunks.push(snappyDecompress(input.subarray(position + 4, end)));
    } catch (error) {
      throw new Error(`${part}: ${(error as Error).message}`);
    }
    position = end;
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

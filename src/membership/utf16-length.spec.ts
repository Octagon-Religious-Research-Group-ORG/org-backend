import { validate } from 'class-validator';
import { Utf16Length } from './utf16-length';

class Sample {
  @Utf16Length(2, 4)
  value: unknown;
}

function errorsFor(value: unknown) {
  const sample = new Sample();
  sample.value = value;
  return validate(sample);
}

describe('Utf16Length', () => {
  it.each(['ab', 'abcd', '🙂', '🙂🙂'])('accepts %j', async (value) => {
    await expect(errorsFor(value)).resolves.toEqual([]);
  });

  it.each([['a'], ['abcde'], ['🙂🙂a'], [5], [undefined]])(
    'refuses %j',
    async (value) => {
      await expect(errorsFor(value)).resolves.toHaveLength(1);
    },
  );

  it('does not repeat the submitted value in its message', async () => {
    const [error] = await errorsFor('SECRET-TEXT');
    expect(JSON.stringify(error.constraints)).not.toContain('SECRET');
  });
});

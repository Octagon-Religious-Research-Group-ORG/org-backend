import { unzipSync, type Unzipped } from 'fflate';

/**
 * Most a package may expand to. Real exports reach about 35 MB (one member's
 * .pages holds a 23 MB picture), so this leaves more than ten times that.
 */
export const MAX_ZIP_EXPANDED_BYTES = 512 * 1024 * 1024;

/** Most files a package may hold; real packages hold a few hundred at most. */
export const MAX_ZIP_ENTRIES = 10_000;

/**
 * Unzips a member's package, refusing a zip bomb before inflating anything.
 * Sizes come from the zip's directory, and that is enough: fflate inflates
 * each entry into a buffer of exactly the declared size, so an entry that
 * lies about its size cannot grow past it.
 *
 * @throws Error when the file is not a zip or breaks a limit
 */
export function safeUnzip(bytes: Uint8Array, kind: string): Unzipped {
  let entries = 0;
  let expanded = 0;
  let refusal: string | undefined;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        expanded += file.originalSize;
        if (entries > MAX_ZIP_ENTRIES) {
          refusal = `Refused: the ${kind} holds more than ${MAX_ZIP_ENTRIES} files.`;
        } else if (expanded > MAX_ZIP_EXPANDED_BYTES) {
          refusal = `Refused: the ${kind} expands to more than ${MAX_ZIP_EXPANDED_BYTES} bytes.`;
        }
        if (refusal) throw new Error(refusal);
        return true;
      },
    });
  } catch (error) {
    throw new Error(
      refusal ?? `Not a ${kind} (zip) file: ${(error as Error).message}`,
    );
  }
}

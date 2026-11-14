import { strToU8, zipSync } from 'fflate';
import type { Check, VersionProof } from './anchor-verifier.service';
import { FREETSA_ROOT_PEM, FREETSA_TSA_PEM } from './freetsa-certs';
import { MERKLE_SCHEME, nodeHash } from './merkle';
import type { AnchoredKind } from './schemas/anchor-leaf.schema';
import { canonicalOf, type VersionRecord } from './version-records';

export const RECEIPT_FORMAT = 'org-receipt-v1';

/** Author ids that are not a person, and so are never withheld. */
const SYSTEM_AUTHOR = /^system:/;
const IMPORTED_AUTHOR = 'system:import';

const LIMITS = [
  'It does not show who wrote it, that it is true, or that it was not written earlier somewhere else.',
  'FreeTSA is a free time-stamp service; it is not an EU "qualified" time-stamp authority. OpenTimestamps relies on the Bitcoin blockchain and becomes final only once its proof is confirmed in a block.',
  'This is not legal advice.',
];

/**
 * What a COMPLETE receipt proves (the author's, or an admin's): anyone can
 * recompute every step from the text with public tools.
 */
export const RECEIPT_NOTICE = [
  'This receipt shows that the text below existed, exactly as written, no later than the times the two independent time-stamps give. Anyone can check every step with free public tools; the commands are below.',
  ...LIMITS,
];

/**
 * What a receipt WITHOUT the hash input proves (anyone else's): the
 * time-stamps, not the link from the text to the hash (review M3).
 */
export const PARTIAL_RECEIPT_NOTICE = [
  'This receipt proves only that this version’s fingerprint (hash) existed no later than the times the two independent time-stamps give. Anyone can check that part with free public tools; the commands are below.',
  'It cannot show by itself that the text below is the text behind that fingerprint: that link can be checked only with the author’s complete receipt, which only the author (or an ORG admin) can download.',
  ...LIMITS,
];

export type ReceiptSubject =
  | { type: 'belief-text' | 'belief-title'; page: string; tabId: string }
  | { type: 'comment'; page: string; commentId: string }
  | { type: 'org-page-comment'; orgPage: string; commentId: string };

/** Who asked: decides whether person ids inside the hash input are shown. */
export interface ReceiptReader {
  userId?: string;
  isAdmin: boolean;
}

export interface ReceiptVersionInput {
  kind: AnchoredKind;
  record: VersionRecord;
  /** An imported outline label shown before the text (not hashed). */
  label?: string;
  proof: VersionProof;
}

export interface ReceiptVersion {
  kind: AnchoredKind;
  seq: number;
  /** The text exactly as recorded and hashed. */
  text: string;
  outlineLabel?: string;
  /** Server time the version was saved (for imports: when imported). */
  serverTime: string;
  versionHash: string;
  prevHash: string;
  imported?: string;
  /**
   * The exact string the version hash is the SHA-256 of, when every person
   * id in it may be shown to this reader; otherwise which fields were held
   * back.
   */
  hashInput:
    | { included: true; canonical: string }
    | { included: false; withheld: string[]; reason: string };
  anchor:
    | { state: 'pending'; message: string }
    | {
        state: 'anchored';
        anchorId: string;
        merkleScheme: string;
        leaf: string;
        path: Array<{ side: 'L' | 'R'; hash: string }>;
        root: string;
        freetsa: {
          status: string;
          genTime?: string;
          /** The TimeStampResp, DER, base64 (`anchor.tsr` in the zip). */
          responseBase64?: string;
        };
        opentimestamps: {
          status: string;
          bitcoinHeights: number[];
          /** The detached proof, base64 (`anchor.ots` in the zip). */
          proofBase64?: string;
        };
        /** What this server found when it checked, each on its own. */
        serverChecks: Record<'hash' | 'path' | 'tsa' | 'ots', Check>;
      };
}

export interface Receipt {
  format: string;
  generatedAt: string;
  subject: ReceiptSubject;
  notice: string[];
  versions: ReceiptVersion[];
  howToVerify: string[];
}

export const PENDING_MESSAGE =
  'Not anchored yet. Versions are anchored once a day; download the receipt again after the next anchor.';

const WITHHELD_REASON =
  "The version hash covers the author's account id, which this site shows only to the author and to administrators, so this receipt cannot let you recompute the hash from the text. The time-stamps still prove the hash existed; the author can download a complete receipt.";

function mayShow(id: string | undefined, reader: ReceiptReader) {
  return (
    id === undefined ||
    SYSTEM_AUTHOR.test(id) ||
    reader.isAdmin ||
    (reader.userId !== undefined && reader.userId === id)
  );
}

function importNote(record: VersionRecord): string | undefined {
  return record.authorUserId === IMPORTED_AUTHOR
    ? `imported from Apple Pages; originally written before ${record.createdAt.toISOString().slice(0, 10)}`
    : undefined;
}

function versionOf(
  input: ReceiptVersionInput,
  reader: ReceiptReader,
): ReceiptVersion {
  const { kind, record, proof } = input;
  const withheld = [
    ...(mayShow(record.authorUserId, reader) ? [] : ['authorUserId']),
    ...(mayShow(record.suggestedBy, reader) ? [] : ['suggestedBy']),
  ];
  const imported = importNote(record);
  return {
    kind,
    seq: record.seq,
    text: record.text,
    ...(input.label ? { outlineLabel: input.label } : {}),
    serverTime: record.createdAt.toISOString(),
    versionHash: record.hash,
    prevHash: record.prevHash,
    ...(imported ? { imported } : {}),
    hashInput:
      withheld.length === 0
        ? { included: true, canonical: canonicalOf(kind, record) }
        : { included: false, withheld, reason: WITHHELD_REASON },
    anchor: proof.anchored
      ? {
          state: 'anchored',
          anchorId: proof.anchorId,
          merkleScheme: MERKLE_SCHEME,
          leaf: proof.leaf,
          path: proof.path,
          root: proof.root,
          freetsa: {
            status: proof.anchor.tsa?.status ?? 'pending',
            ...(proof.anchor.tsa?.genTime
              ? { genTime: proof.anchor.tsa.genTime.toISOString() }
              : {}),
            ...(proof.anchor.tsa?.response
              ? {
                  responseBase64: Buffer.from(
                    proof.anchor.tsa.response,
                  ).toString('base64'),
                }
              : {}),
          },
          opentimestamps: {
            status: proof.anchor.ots?.status ?? 'submit',
            bitcoinHeights: proof.anchor.ots?.bitcoinHeights ?? [],
            ...(proof.anchor.ots?.proof
              ? {
                  proofBase64: Buffer.from(proof.anchor.ots.proof).toString(
                    'base64',
                  ),
                }
              : {}),
          },
          serverChecks: proof.checks,
        }
      : { state: 'pending', message: PENDING_MESSAGE },
  };
}

/** The verification steps for one anchored version, with expected outputs. */
function stepsFor(version: ReceiptVersion, folder: string): string[] {
  const lines: string[] = [];
  if (version.hashInput.included) {
    lines.push(
      `1. Version hash: \`sha256sum ${folder}/hash-input.json\` (or \`openssl dgst -sha256 ${folder}/hash-input.json\`) must print ${version.versionHash}. That file is the JSON array [scheme, id, seq, text, author, server time, previous hash${version.kind === 'block' ? ', and for an accepted suggestion its id and author' : ''}] exactly as hashed, UTF-8, no spaces or newline; the text inside it is ${folder}/text.txt.`,
    );
  } else {
    lines.push(
      `1. Version hash: not recomputable from this receipt (${version.hashInput.withheld.join(', ')} held back). The hash itself is ${version.versionHash}.`,
    );
  }
  if (version.anchor.state !== 'anchored') {
    lines.push(`2. ${PENDING_MESSAGE}`);
    return lines;
  }
  const a = version.anchor;
  lines.push(
    `2. Leaf (${a.merkleScheme}): \`printf '00${version.versionHash}' | xxd -r -p | openssl dgst -sha256\` must print ${a.leaf}.`,
  );
  let current = a.leaf;
  a.path.forEach((step, index) => {
    const pair =
      step.side === 'L' ? `${step.hash}${current}` : `${current}${step.hash}`;
    current =
      step.side === 'L'
        ? nodeHash(step.hash, current)
        : nodeHash(current, step.hash);
    lines.push(
      `3.${index + 1}. \`printf '01${pair}' | xxd -r -p | openssl dgst -sha256\` must print ${current}.`,
    );
  });
  lines.push(
    a.path.length === 0
      ? `3. This anchor holds one version: its leaf is the root ${a.root}.`
      : `   The last value must be the anchored root ${a.root}.`,
  );
  lines.push(
    a.freetsa.responseBase64
      ? `4. FreeTSA: \`openssl ts -verify -digest ${a.root} -in ${folder}/anchor.tsr -CAfile freetsa/cacert.pem -untrusted freetsa/tsa.crt\` must print "Verification: OK"; \`openssl ts -reply -in ${folder}/anchor.tsr -text\` shows its time ("Time stamp:"). The certificates are FreeTSA's own, from https://freetsa.org/files/.`
      : '4. FreeTSA: no token yet (the request will be tried again on the next run).',
    a.opentimestamps.proofBase64
      ? `5. OpenTimestamps: \`ots verify -d ${a.root} ${folder}/anchor.ots\` (the ots client from https://opentimestamps.org). While the proof is pending, \`ots upgrade ${folder}/anchor.ots\` fetches its Bitcoin part once the calendars have it. Without a Bitcoin node: \`ots info ${folder}/anchor.ots\` prints "BitcoinBlockHeaderAttestation(<height>)" then "# Bitcoin block merkle root <root>"; look the block height up on any public block explorer (e.g. https://blockstream.info/block-height/<height>) and check that its Merkle root is the same.`
      : '5. OpenTimestamps: no proof yet (it will be tried again on the next run).',
  );
  return lines;
}

/** Builds the receipt for one history entry (one or several versions). */
export function buildReceipt(
  subject: ReceiptSubject,
  inputs: readonly ReceiptVersionInput[],
  reader: ReceiptReader,
  now = new Date(),
): Receipt {
  const versions = inputs.map((input) => versionOf(input, reader));
  return {
    format: RECEIPT_FORMAT,
    generatedAt: now.toISOString(),
    subject,
    notice: versions.every((version) => version.hashInput.included)
      ? RECEIPT_NOTICE
      : PARTIAL_RECEIPT_NOTICE,
    versions,
    howToVerify: versions.flatMap((version, index) => [
      `Version ${index + 1} (folder version-${index + 1}):`,
      ...stepsFor(version, `version-${index + 1}`),
    ]),
  };
}

/**
 * The receipt as a zip: the JSON, a README, and every file the public tools
 * read directly (`openssl ts`, the `ots` client), so nothing has to be
 * decoded by hand.
 */
export function receiptZip(receipt: Receipt): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'receipt.json': strToU8(`${JSON.stringify(receipt, null, 2)}\n`),
    'README.txt': strToU8(
      [
        'ORG timestamp receipt',
        '',
        ...receipt.notice,
        '',
        'How to check it yourself (openssl, xxd and the ots client are public tools):',
        '',
        ...receipt.howToVerify,
        '',
      ].join('\n'),
    ),
    'freetsa/cacert.pem': strToU8(FREETSA_ROOT_PEM),
    'freetsa/tsa.crt': strToU8(FREETSA_TSA_PEM),
  };
  receipt.versions.forEach((version, index) => {
    const folder = `version-${index + 1}`;
    files[`${folder}/text.txt`] = strToU8(version.text);
    if (version.hashInput.included) {
      files[`${folder}/hash-input.json`] = strToU8(version.hashInput.canonical);
    }
    if (version.anchor.state === 'anchored') {
      files[`${folder}/root.txt`] = strToU8(`${version.anchor.root}\n`);
      if (version.anchor.freetsa.responseBase64) {
        files[`${folder}/anchor.tsr`] = Buffer.from(
          version.anchor.freetsa.responseBase64,
          'base64',
        );
      }
      if (version.anchor.opentimestamps.proofBase64) {
        files[`${folder}/anchor.ots`] = Buffer.from(
          version.anchor.opentimestamps.proofBase64,
          'base64',
        );
      }
    }
  });
  return zipSync(files, { level: 6 });
}

import { createHash, randomBytes, verify, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';

/**
 * RFC 3161 time-stamp requests and responses (plan §6, Chunk 16): building
 * the request for a SHA-256 digest, reading the response, and checking a
 * token fully, without trusting anything the TSA sent except through a
 * pinned root certificate.
 *
 * Only what FreeTSA actually returns is supported (measured 2026-11-14:
 * SignedData v3, signer by issuer and serial, ECDSA or RSA PKCS#1 v1.5
 * signature, SHA-2 digests, a signing-certificate attribute). Anything else
 * is "cannot measure", never a pass.
 */

const OID = {
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStamping: '1.3.6.1.5.5.7.3.8',
} as const;

const DIGEST_NAMES: Record<string, string> = {
  [OID.sha1]: 'sha1',
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};

/** Signature algorithms whose hash is named by the algorithm itself. */
const SIGNATURE_HASHES: Record<string, string> = {
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
};
/** rsaEncryption: the hash is the signer's digest algorithm. */
const RSA_ENCRYPTION = '1.2.840.113549.1.1.1';

/** The parts of a token's TSTInfo this site reads. */
export interface TstInfo {
  policy: string;
  hashAlgorithm: string;
  /** The message imprint, lowercase hex. */
  imprint: string;
  /** Serial number, lowercase hex. */
  serial: string;
  genTime: Date;
  /** Nonce, lowercase hex, if the TSA echoed one. */
  nonce?: string;
}

export interface ParsedResponse {
  /** PKIStatus: 0 granted, 1 granted with mods, 2+ refused. */
  status: number;
  /** The TimeStampToken (a CMS ContentInfo), DER, when one was sent. */
  token?: Buffer;
}

export type TokenVerdict =
  | {
      outcome: 'pass';
      tst: TstInfo;
      /** Subject of the certificate that signed the token. */
      signer: string;
    }
  | { outcome: 'fail' | 'cannot-measure'; reason: string };

/** A malformed or unsupported structure, turned into a verdict by callers. */
class Unreadable extends Error {
  constructor(
    readonly outcome: 'fail' | 'cannot-measure',
    reason: string,
  ) {
    super(reason);
  }
}

function hexOf(view: Uint8Array): string {
  return Buffer.from(view).toString('hex');
}

function parse(der: Uint8Array): asn1js.AsnType {
  const { offset, result } = asn1js.fromBER(der);
  if (offset === -1 || offset !== der.byteLength) {
    throw new Unreadable('fail', 'not one DER structure');
  }
  return result;
}

function kids(node: asn1js.AsnType | undefined): asn1js.AsnType[] {
  const value = (node as { valueBlock?: { value?: unknown } } | undefined)
    ?.valueBlock?.value;
  return Array.isArray(value) ? (value as asn1js.AsnType[]) : [];
}

function raw(node: asn1js.AsnType): Buffer {
  return Buffer.from(node.valueBeforeDecodeView);
}

function oidOf(node: asn1js.AsnType | undefined): string {
  if (!(node instanceof asn1js.ObjectIdentifier)) {
    throw new Unreadable('fail', 'an object identifier is missing');
  }
  return node.valueBlock.toString();
}

function octets(node: asn1js.AsnType | undefined): Buffer {
  if (!(node instanceof asn1js.OctetString) || node.idBlock.isConstructed) {
    throw new Unreadable('fail', 'an octet string is missing');
  }
  return Buffer.from(node.valueBlock.valueHexView);
}

function integerHex(node: asn1js.AsnType | undefined): string {
  if (!(node instanceof asn1js.Integer)) {
    throw new Unreadable('fail', 'an integer is missing');
  }
  // Without the sign byte DER adds before a high bit, as certificates show it.
  return hexOf(node.valueBlock.valueHexView).replace(/^(?:00)+(?=..)/, '');
}

/** A context-specific tag `[n]`. */
function isContext(node: asn1js.AsnType | undefined, tag: number) {
  return node?.idBlock.tagClass === 3 && node.idBlock.tagNumber === tag;
}

/**
 * A TimeStampReq for a SHA-256 digest, asking for the signer's certificate
 * in the token, with a fresh 64-bit nonce.
 *
 * @param digest - the 32-byte digest (hex) to be time-stamped
 * @returns the DER request and the nonce (hex) it carries
 */
export function buildTimestampRequest(
  digest: string,
  nonce: Buffer = randomBytes(8),
): { der: Buffer; nonce: string } {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Not a SHA-256 digest.');
  // Positive, and minimally encoded: the first byte in 0x01..0x7f.
  const n = Buffer.from(nonce);
  n[0] = (n[0] & 0x7f) | 0x01;
  const request = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 1 }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({
            value: [
              new asn1js.ObjectIdentifier({ value: OID.sha256 }),
              new asn1js.Null(),
            ],
          }),
          new asn1js.OctetString({ valueHex: Buffer.from(digest, 'hex') }),
        ],
      }),
      new asn1js.Integer({ valueHex: n }),
      new asn1js.Boolean({ value: true }),
    ],
  });
  return {
    der: Buffer.from(request.toBER(false)),
    nonce: n.toString('hex'),
  };
}

/**
 * Reads a TimeStampResp: its status and, if granted, its token.
 *
 * @throws Error if the bytes are not a TimeStampResp
 */
export function parseTimestampResponse(der: Uint8Array): ParsedResponse {
  try {
    const [statusInfo, token] = kids(parse(der));
    const status = kids(statusInfo)[0];
    if (!(status instanceof asn1js.Integer)) {
      throw new Unreadable('fail', 'no status');
    }
    return {
      status: status.valueBlock.valueDec,
      ...(token ? { token: raw(token) } : {}),
    };
  } catch (error) {
    throw new Error(`Not a time-stamp response: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function readTstInfo(der: Buffer): TstInfo {
  const fields = kids(parse(der));
  const [, policy, imprint, serial, genTime] = fields;
  const [algorithm, hashed] = kids(imprint);
  if (!(genTime instanceof asn1js.GeneralizedTime)) {
    throw new Unreadable('fail', 'no generation time');
  }
  const nonce = fields
    .slice(5)
    .find((field) => field instanceof asn1js.Integer);
  return {
    policy: oidOf(policy),
    hashAlgorithm: oidOf(kids(algorithm)[0]),
    imprint: octets(hashed).toString('hex'),
    serial: integerHex(serial),
    genTime: genTime.toDate(),
    ...(nonce ? { nonce: integerHex(nonce) } : {}),
  };
}

function attributes(node: asn1js.AsnType): Map<string, asn1js.AsnType> {
  const found = new Map<string, asn1js.AsnType>();
  for (const attribute of kids(node)) {
    const [type, values] = kids(attribute);
    const oid = oidOf(type);
    if (found.has(oid)) throw new Unreadable('fail', `attribute ${oid} twice`);
    found.set(oid, kids(values)[0]);
  }
  return found;
}

function hash(name: string, data: Buffer) {
  return createHash(name).update(data).digest();
}

/** Does the signing-certificate attribute name this certificate? */
function namesCertificate(
  attrs: Map<string, asn1js.AsnType>,
  certDer: Buffer,
): boolean {
  const v1 = attrs.get(OID.signingCertificate);
  const v2 = attrs.get(OID.signingCertificateV2);
  if (v1) {
    const certHash = kids(kids(kids(v1)[0])[0])[0];
    return octets(certHash).equals(hash('sha1', certDer));
  }
  if (!v2) throw new Unreadable('fail', 'no signing-certificate attribute');
  const id = kids(kids(v2)[0])[0];
  const [first, second] = kids(id);
  // ESSCertIDv2: an optional algorithm (default SHA-256), then the hash.
  const algorithm =
    first instanceof asn1js.Sequence
      ? DIGEST_NAMES[oidOf(kids(first)[0])]
      : 'sha256';
  if (!algorithm) {
    throw new Unreadable('cannot-measure', 'unknown certificate hash');
  }
  const certHash = first instanceof asn1js.Sequence ? second : first;
  return octets(certHash).equals(hash(algorithm, certDer));
}

/** Walks from the signer up through the token's certificates to a root. */
/**
 * @returns the certificates from the signer up to and including the trusted
 *   root, or undefined when no chain reaches one of `roots`
 */
function chainTo(
  signer: X509Certificate,
  pool: readonly X509Certificate[],
  roots: readonly X509Certificate[],
): X509Certificate[] | undefined {
  const issuedBy = (child: X509Certificate, parent: X509Certificate) =>
    child.checkIssued(parent) && child.verify(parent.publicKey);
  const seen = new Set<X509Certificate>();
  const chain: X509Certificate[] = [];
  let current = signer;
  for (;;) {
    chain.push(current);
    const root = roots.find((candidate) => issuedBy(current, candidate));
    if (root) return [...chain, root];
    seen.add(current);
    const next = pool.find(
      (candidate) =>
        !seen.has(candidate) && candidate.ca && issuedBy(current, candidate),
    );
    if (!next) return undefined;
    current = next;
  }
}

function validAt(cert: X509Certificate, at: number) {
  return (
    at >= new Date(cert.validFrom).getTime() &&
    at <= new Date(cert.validTo).getTime()
  );
}

/** A certificate's issuer (DER) and serial (hex), as a SignerInfo names it. */
function issuerAndSerial(certDer: Buffer) {
  const tbs = kids(kids(parse(certDer))[0]);
  // `[0] version` is optional: the serial is the first integer.
  const at = isContext(tbs[0], 0) ? 1 : 0;
  return { issuer: raw(tbs[at + 2]), serial: integerHex(tbs[at]) };
}

/**
 * The message imprint a time-stamp token commits to, lowercase hex, read
 * WITHOUT checking its signature (review round 6, L2: only to tell whether
 * a stored tree still matches the token it was stamped with).
 *
 * @throws when the token cannot be read
 */
export function tokenImprint(token: Uint8Array): string {
  const signed = kids(kids(kids(parse(token))[1])[0]);
  const eContentWrap = kids(signed[2])[1];
  return readTstInfo(octets(kids(eContentWrap)[0])).imprint;
}

/**
 * Checks a time-stamp token completely: its structure, that it time-stamps
 * `digest` with SHA-256, that its signature is valid, that the signer is the
 * certificate the token names, that the signer may sign time stamps, was
 * valid at the stamped time, and chains to one of `roots`.
 *
 * @param token - the TimeStampToken (CMS ContentInfo), DER
 * @param digest - the expected message imprint, hex
 * @param roots - pinned trust anchors (FreeTSA's root certificate)
 * @param nonce - the request's nonce, hex, when it must be echoed
 */
export function verifyTimestampToken(
  token: Uint8Array,
  digest: string,
  roots: readonly X509Certificate[],
  nonce?: string,
): TokenVerdict {
  try {
    const [contentType, wrapped] = kids(parse(token));
    if (oidOf(contentType) !== OID.signedData || !isContext(wrapped, 0)) {
      return { outcome: 'fail', reason: 'not a signed-data token' };
    }
    const signed = kids(kids(wrapped)[0]);
    const encap = signed[2];
    const [eContentType, eContentWrap] = kids(encap);
    if (oidOf(eContentType) !== OID.tstInfo || !isContext(eContentWrap, 0)) {
      return { outcome: 'fail', reason: 'not a time-stamp token' };
    }
    const eContent = octets(kids(eContentWrap)[0]);
    const tst = readTstInfo(eContent);

    const certSet = signed.find((node) => isContext(node, 0));
    const certs = kids(certSet).map((node) => ({
      der: raw(node),
      x509: new X509Certificate(raw(node)),
    }));
    const signerInfos = kids(signed[signed.length - 1]);
    if (signerInfos.length !== 1) {
      return { outcome: 'cannot-measure', reason: 'not exactly one signer' };
    }
    const info = kids(signerInfos[0]);
    const [, sid, digestAlgorithm, signedAttrs, signatureAlgorithm, sig] = info;
    if (!(sid instanceof asn1js.Sequence)) {
      return {
        outcome: 'cannot-measure',
        reason: 'signer named by key id, not issuer and serial',
      };
    }
    if (!isContext(signedAttrs, 0)) {
      return { outcome: 'fail', reason: 'no signed attributes' };
    }
    const digestName = DIGEST_NAMES[oidOf(kids(digestAlgorithm)[0])];
    const signatureOid = oidOf(kids(signatureAlgorithm)[0]);
    const signatureHash =
      SIGNATURE_HASHES[signatureOid] ??
      (signatureOid === RSA_ENCRYPTION ? digestName : undefined);
    if (!digestName || !signatureHash) {
      return { outcome: 'cannot-measure', reason: 'unsupported algorithm' };
    }

    const attrs = attributes(signedAttrs);
    const attrType = attrs.get(OID.contentType);
    if (!attrType || oidOf(attrType) !== OID.tstInfo) {
      return { outcome: 'fail', reason: 'wrong content-type attribute' };
    }
    const messageDigest = attrs.get(OID.messageDigest);
    if (
      !messageDigest ||
      !octets(messageDigest).equals(hash(digestName, eContent))
    ) {
      return { outcome: 'fail', reason: 'message digest mismatch' };
    }

    // Issuer AND serial (review L2): a serial alone is unique per issuer only.
    const [sidIssuer, sidSerial] = kids(sid);
    const wanted = { issuer: raw(sidIssuer), serial: integerHex(sidSerial) };
    const signer = certs.find(({ der }) => {
      const named = issuerAndSerial(der);
      return (
        named.serial === wanted.serial && named.issuer.equals(wanted.issuer)
      );
    });
    if (!signer) {
      return { outcome: 'cannot-measure', reason: 'signer certificate absent' };
    }
    if (!namesCertificate(attrs, signer.der)) {
      return { outcome: 'fail', reason: 'signing-certificate mismatch' };
    }
    // The signature covers the attributes as an explicit SET (RFC 5652 5.4).
    const signedBytes = raw(signedAttrs);
    signedBytes[0] = 0x31;
    if (
      !verify(signatureHash, signedBytes, signer.x509.publicKey, octets(sig))
    ) {
      return { outcome: 'fail', reason: 'bad signature' };
    }

    if (!(signer.x509.keyUsage ?? []).includes(OID.timeStamping)) {
      return { outcome: 'fail', reason: 'signer may not sign time stamps' };
    }
    const at = tst.genTime.getTime();
    if (!validAt(signer.x509, at)) {
      return { outcome: 'fail', reason: 'signer not valid at that time' };
    }
    const chain = chainTo(
      signer.x509,
      certs.map((cert) => cert.x509),
      roots,
    );
    if (!chain) {
      return { outcome: 'fail', reason: 'not signed by a trusted TSA' };
    }
    // Every certificate up to the root, the root too (review L2).
    if (!chain.every((cert) => validAt(cert, at))) {
      return {
        outcome: 'fail',
        reason: 'a certificate in the chain was not valid at that time',
      };
    }
    if (tst.hashAlgorithm !== OID.sha256 || tst.imprint !== digest) {
      return { outcome: 'fail', reason: 'imprint does not match' };
    }
    if (nonce !== undefined && tst.nonce !== nonce) {
      return { outcome: 'fail', reason: 'nonce does not match' };
    }
    return { outcome: 'pass', tst, signer: signer.x509.subject };
  } catch (error) {
    if (error instanceof Unreadable) {
      return { outcome: error.outcome, reason: error.message };
    }
    return {
      outcome: 'fail',
      reason: `unreadable token: ${(error as Error).message}`,
    };
  }
}

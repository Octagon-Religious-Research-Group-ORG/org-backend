/* A SYNTHETIC time-stamp authority for tests (Chunk 16).
 *
 * The real FreeTSA token from Step 0 (`step0-fixtures.mocks-spec.ts`) only
 * time-stamps the Step 0 digest, so it cannot stand in for a token over a
 * test's own Merkle root. This builds tokens of exactly the same shape as
 * FreeTSA's (measured 2026-11-14: SignedData v3, eContent TSTInfo, signer by
 * issuer and serial, contentType + signingTime + signingCertificate (v1) +
 * messageDigest attributes, ECDSA signature, the signer and root
 * certificates included), signed by a throwaway root made here, so the
 * verifier can be run against it with that root pinned instead. Keys are made
 * per test run and never written anywhere.
 */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from 'node:crypto';
import * as asn1js from 'asn1js';

const OID = {
  cn: '2.5.4.3',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  rsaSha256: '1.2.840.113549.1.1.11',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  policy: '1.2.3.4.1',
};

export interface TestKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  rsa: boolean;
}

function newKey(rsa = false): TestKey {
  const pair = rsa
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, rsa };
}

const der = (node: asn1js.AsnType) => Buffer.from(node.toBER(false));
const oid = (value: string) => new asn1js.ObjectIdentifier({ value });
const seq = (...value: asn1js.AsnType[]) => new asn1js.Sequence({ value });
const set = (...value: asn1js.AsnType[]) => new asn1js.Set({ value });
const octet = (bytes: Buffer) => new asn1js.OctetString({ valueHex: bytes });
const int = (hex: string) =>
  new asn1js.Integer({ valueHex: Buffer.from(hex, 'hex') });
/** `[n]` holding `value` (constructed). */
const ctx = (tagNumber: number, ...value: asn1js.AsnType[]) =>
  new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value });
const parsed = (bytes: Buffer) => asn1js.fromBER(new Uint8Array(bytes)).result;

function name(cn: string) {
  return seq(set(seq(oid(OID.cn), new asn1js.Utf8String({ value: cn }))));
}

function algorithm(key: TestKey) {
  return key.rsa
    ? seq(oid(OID.rsaSha256), new asn1js.Null())
    : seq(oid(OID.ecdsaSha256));
}

export interface CertOptions {
  subject: string;
  issuer: string;
  serial: string;
  key: TestKey;
  signer: TestKey;
  ca?: boolean;
  timeStamping?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  /** An X.509 v1 certificate: no version field, no extensions. */
  v1?: boolean;
}

export function makeCert(o: CertOptions): {
  der: Buffer;
  x509: X509Certificate;
} {
  const extensions: asn1js.AsnType[] = [];
  if (o.ca) {
    extensions.push(
      seq(
        oid(OID.basicConstraints),
        new asn1js.Boolean({ value: true }),
        octet(der(seq(new asn1js.Boolean({ value: true })))),
      ),
    );
  }
  if (o.timeStamping) {
    extensions.push(
      seq(
        oid(OID.extKeyUsage),
        new asn1js.Boolean({ value: true }),
        octet(der(seq(oid(OID.timeStamping)))),
      ),
    );
  }
  const tbs = seq(
    ...(o.v1 ? [] : [ctx(0, new asn1js.Integer({ value: 2 }))]),
    int(o.serial),
    algorithm(o.signer),
    name(o.issuer),
    seq(
      new asn1js.UTCTime({ valueDate: o.notBefore ?? new Date('2020-01-01Z') }),
      new asn1js.UTCTime({ valueDate: o.notAfter ?? new Date('2045-01-01Z') }),
    ),
    name(o.subject),
    parsed(o.key.publicKey.export({ type: 'spki', format: 'der' })),
    ...(extensions.length > 0 && !o.v1 ? [ctx(3, seq(...extensions))] : []),
  );
  const tbsDer = der(tbs);
  const signature = sign('sha256', tbsDer, o.signer.privateKey);
  const cert = der(
    seq(
      parsed(tbsDer),
      algorithm(o.signer),
      new asn1js.BitString({ valueHex: signature }),
    ),
  );
  return { der: cert, x509: new X509Certificate(cert) };
}

/** Every way a test may bend the token, one at a time. */
export interface TokenOptions {
  nonce?: string;
  status?: number;
  noToken?: boolean;
  genTime?: Date;
  imprintAlgorithm?: string;
  contentType?: string;
  eContentType?: string;
  noSignedAttrs?: boolean;
  digestAlgorithm?: string;
  signatureAlgorithm?: string;
  attrContentType?: string | null;
  wrongMessageDigest?: boolean;
  noMessageDigest?: boolean;
  signerSerial?: string;
  signerByKeyId?: boolean;
  signingCertificate?:
    | 'v1'
    | 'v2'
    | 'v2-alg'
    | 'v2-unknown-alg'
    | 'none'
    | 'wrong';
  duplicateAttribute?: boolean;
  badSignature?: boolean;
  twoSigners?: boolean;
  noCertificates?: boolean;
  noGenTime?: boolean;
  noStatus?: boolean;
  serialNotInteger?: boolean;
  constructedEContent?: boolean;
  junkCertificate?: boolean;
}

export interface TestTsa {
  root: X509Certificate;
  rootDer: Buffer;
  tsaDer: Buffer;
  /** A TimeStampResp for the digest, DER. */
  respond(digest: string, options?: TokenOptions): Buffer;
}

/**
 * A root CA and a TSA certificate under it.
 *
 * @param o.rsa - an RSA signer whose SignerInfo names `rsaEncryption`
 * @param o.tsaTimeStamping - false: the TSA certificate lacks the EKU
 * @param o.tsaNotAfter - when the TSA certificate stops being valid
 * @param o.intermediate - put a CA between root and TSA
 */
export function makeTestTsa(
  o: {
    rsa?: boolean;
    tsaTimeStamping?: boolean;
    tsaNotBefore?: Date;
    tsaNotAfter?: Date;
    intermediate?: boolean;
    /** The root stops being valid at this time. */
    rootNotAfter?: Date;
    /**
     * Put first in the token a certificate with the TSA's serial but another
     * issuer, as a TSA's certificate list may hold (review L2).
     */
    decoy?: boolean | 'v1';
  } = {},
): TestTsa {
  const rootKey = newKey();
  const root = makeCert({
    subject: 'Synthetic Test Root',
    issuer: 'Synthetic Test Root',
    serial: '01',
    key: rootKey,
    signer: rootKey,
    ca: true,
    notAfter: o.rootNotAfter,
  });
  const decoyKey = newKey();
  const decoy = makeCert({
    subject: 'Synthetic Decoy TSA',
    issuer: 'Synthetic Decoy CA',
    serial: '00c2e9',
    key: decoyKey,
    signer: decoyKey,
    timeStamping: true,
    v1: o.decoy === 'v1',
  });
  let issuerKey = rootKey;
  let issuerName = 'Synthetic Test Root';
  const chain: Buffer[] = [];
  if (o.intermediate) {
    const midKey = newKey();
    const mid = makeCert({
      subject: 'Synthetic Test Intermediate',
      issuer: issuerName,
      serial: '02',
      key: midKey,
      signer: rootKey,
      ca: true,
    });
    chain.push(mid.der);
    issuerKey = midKey;
    issuerName = 'Synthetic Test Intermediate';
  }
  const tsaKey = newKey(o.rsa);
  const tsa = makeCert({
    subject: 'Synthetic Test TSA',
    issuer: issuerName,
    serial: '00c2e9',
    key: tsaKey,
    signer: issuerKey,
    timeStamping: o.tsaTimeStamping ?? true,
    notBefore: o.tsaNotBefore,
    notAfter: o.tsaNotAfter,
  });

  function respond(digest: string, t: TokenOptions = {}): Buffer {
    const tst = seq(
      new asn1js.Integer({ value: 1 }),
      oid(OID.policy),
      seq(
        seq(oid(t.imprintAlgorithm ?? OID.sha256), new asn1js.Null()),
        octet(Buffer.from(digest, 'hex')),
      ),
      t.serialNotInteger ? octet(Buffer.from('01', 'hex')) : int('0a01e815'),
      ...(t.noGenTime
        ? [new asn1js.Integer({ value: 7 })]
        : [
            new asn1js.GeneralizedTime({
              valueDate: t.genTime ?? new Date('2026-11-14T06:25:40Z'),
            }),
          ]),
      new asn1js.Boolean({ value: true }),
      ...(t.nonce ? [int(t.nonce)] : []),
    );
    const eContent = der(tst);
    const certHash =
      t.signingCertificate === 'wrong'
        ? Buffer.alloc(20)
        : createHash('sha1').update(tsa.der).digest();
    const v2Hash = createHash('sha256').update(tsa.der).digest();
    const signingCert = {
      v1: [oid(OID.signingCertificate), set(seq(seq(seq(octet(certHash)))))],
      wrong: [oid(OID.signingCertificate), set(seq(seq(seq(octet(certHash)))))],
      v2: [oid(OID.signingCertificateV2), set(seq(seq(seq(octet(v2Hash)))))],
      'v2-alg': [
        oid(OID.signingCertificateV2),
        set(seq(seq(seq(seq(oid(OID.sha256)), octet(v2Hash))))),
      ],
      'v2-unknown-alg': [
        oid(OID.signingCertificateV2),
        set(seq(seq(seq(seq(oid('1.2.3.99')), octet(v2Hash))))),
      ],
    } as const;
    const kind = t.signingCertificate ?? 'v1';
    const attrs: asn1js.AsnType[] = [
      ...(t.attrContentType === null
        ? []
        : [
            seq(
              oid(OID.contentType),
              set(oid(t.attrContentType ?? OID.tstInfo)),
            ),
          ]),
      seq(
        oid(OID.signingTime),
        set(
          new asn1js.UTCTime({ valueDate: new Date('2026-11-14T06:25:40Z') }),
        ),
      ),
      ...(kind === 'none' ? [] : [seq(...signingCert[kind])]),
      ...(t.noMessageDigest
        ? []
        : [
            seq(
              oid(OID.messageDigest),
              set(
                octet(
                  t.wrongMessageDigest
                    ? Buffer.alloc(32)
                    : createHash('sha256').update(eContent).digest(),
                ),
              ),
            ),
          ]),
      ...(t.duplicateAttribute
        ? [
            seq(
              oid(OID.signingTime),
              set(new asn1js.UTCTime({ valueDate: new Date() })),
            ),
          ]
        : []),
    ];
    const signedSet = der(set(...attrs));
    let signature = sign('sha256', signedSet, tsaKey.privateKey);
    if (t.badSignature)
      signature = sign('sha256', Buffer.from('other'), tsaKey.privateKey);
    const signedAttrs = parsed(
      Buffer.concat([Buffer.from([0xa0]), signedSet.subarray(1)]),
    );
    const sid = t.signerByKeyId
      ? new asn1js.Primitive({
          idBlock: { tagClass: 3, tagNumber: 0 },
          valueHex: Buffer.alloc(20),
        })
      : seq(name(issuerName), int(t.signerSerial ?? '00c2e9'));
    const signerInfo = seq(
      new asn1js.Integer({ value: 1 }),
      sid,
      seq(oid(t.digestAlgorithm ?? OID.sha256)),
      ...(t.noSignedAttrs ? [seq()] : [signedAttrs]),
      seq(
        oid(
          t.signatureAlgorithm ??
            (tsaKey.rsa ? OID.rsaEncryption : OID.ecdsaSha256),
        ),
      ),
      octet(signature),
    );
    const certs = t.junkCertificate
      ? [int('01')]
      : [...(o.decoy ? [decoy.der] : []), tsa.der, ...chain, root.der].map(
          parsed,
        );
    const signedData = seq(
      new asn1js.Integer({ value: 3 }),
      set(seq(oid(OID.sha256))),
      seq(
        oid(t.eContentType ?? OID.tstInfo),
        ctx(
          0,
          t.constructedEContent
            ? new asn1js.OctetString({
                isConstructed: true,
                value: [octet(eContent)],
              })
            : octet(eContent),
        ),
      ),
      ...(t.noCertificates ? [] : [ctx(0, ...certs)]),
      t.twoSigners ? set(signerInfo, parsed(der(signerInfo))) : set(signerInfo),
    );
    const token = seq(oid(t.contentType ?? OID.signedData), ctx(0, signedData));
    return der(
      seq(
        t.noStatus
          ? seq(octet(Buffer.alloc(1)))
          : seq(new asn1js.Integer({ value: t.status ?? 0 })),
        ...(t.noToken ? [] : [token]),
      ),
    );
  }

  return { root: root.x509, rootDer: root.der, tsaDer: tsa.der, respond };
}

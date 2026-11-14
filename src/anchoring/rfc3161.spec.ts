import { createHash, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { FREETSA_ROOT_PEM, FREETSA_TSA_PEM } from './freetsa-certs';
import {
  buildTimestampRequest,
  parseTimestampResponse,
  verifyTimestampToken,
} from './rfc3161';
import { FREETSA_RESPONSE, STEP0_DIGEST } from './step0-fixtures.mocks-spec';
import { makeTestTsa, type TokenOptions } from './test-tsa.mocks-spec';

const FREETSA_ROOT = new X509Certificate(FREETSA_ROOT_PEM);
const DIGEST = createHash('sha256').update('synthetic root').digest('hex');

function tokenOf(response: Buffer): Buffer {
  return parseTimestampResponse(response).token as Buffer;
}

describe('RFC 3161 with the REAL FreeTSA token (Step 0)', () => {
  const token = tokenOf(FREETSA_RESPONSE);

  it('the pinned certificates are the files FreeTSA publishes', () => {
    // SHA-256 of each file as published on freetsa.org/index_en.php.
    const fileHash = (pem: string) =>
      createHash('sha256').update(pem).digest('hex');
    expect(fileHash(FREETSA_ROOT_PEM)).toBe(
      '2151b61137ffa86bf664691ba67e7da0b19f98c758e3d228d5d8ebf27e044438',
    );
    expect(fileHash(FREETSA_TSA_PEM)).toBe(
      '8bfb0305bb64e2571ca507552ef3245cb1c2fee8728e0ff8689225081ea13467',
    );
  });

  it('reads as granted and verifies for exactly the Step 0 digest', () => {
    expect(parseTimestampResponse(FREETSA_RESPONSE).status).toBe(0);
    const verdict = verifyTimestampToken(token, STEP0_DIGEST, [FREETSA_ROOT]);
    expect(verdict).toMatchObject({
      outcome: 'pass',
      tst: {
        imprint: STEP0_DIGEST,
        serial: '0a01e815',
        genTime: new Date('2026-11-14T06:25:40Z'),
      },
    });
    expect(verdict.outcome === 'pass' && verdict.signer).toContain(
      'CN=www.freetsa.org',
    );
  });

  it('fails for any other digest', () => {
    const other = `1${STEP0_DIGEST.slice(1)}`;
    expect(verifyTimestampToken(token, other, [FREETSA_ROOT])).toEqual({
      outcome: 'fail',
      reason: 'imprint does not match',
    });
  });

  it('fails when the signature bytes are changed', () => {
    const bent = Buffer.from(token);
    bent[bent.length - 5] ^= 0x01;
    expect(
      verifyTimestampToken(bent, STEP0_DIGEST, [FREETSA_ROOT]).outcome,
    ).toBe('fail');
  });

  it('fails when the time inside it is changed (the digest attribute no longer matches)', () => {
    const at = token.indexOf(Buffer.from('20261114062540Z'));
    expect(at).toBeGreaterThan(0);
    const bent = Buffer.from(token);
    bent[at + 3] = '7'.charCodeAt(0);
    expect(verifyTimestampToken(bent, STEP0_DIGEST, [FREETSA_ROOT])).toEqual({
      outcome: 'fail',
      reason: 'message digest mismatch',
    });
  });

  it('fails against a root that is not FreeTSA', () => {
    expect(
      verifyTimestampToken(token, STEP0_DIGEST, [makeTestTsa().root]),
    ).toEqual({ outcome: 'fail', reason: 'not signed by a trusted TSA' });
  });
});

describe('the time-stamp request', () => {
  it('asks for SHA-256 of the digest, the signer certificate, and a positive minimal nonce', () => {
    const { der, nonce } = buildTimestampRequest(
      DIGEST,
      Buffer.from('ff00000000000001', 'hex'),
    );
    expect(nonce).toBe('7f00000000000001');
    const [version, imprint, n, certReq] = (
      asn1js.fromBER(new Uint8Array(der)).result as asn1js.Sequence
    ).valueBlock.value as asn1js.AsnType[];
    expect((version as asn1js.Integer).valueBlock.valueDec).toBe(1);
    const [alg, hashed] = (imprint as asn1js.Sequence).valueBlock.value;
    expect(
      (
        (alg as asn1js.Sequence).valueBlock.value[0] as asn1js.ObjectIdentifier
      ).valueBlock.toString(),
    ).toBe('2.16.840.1.101.3.4.2.1');
    expect(
      Buffer.from(
        (hashed as asn1js.OctetString).valueBlock.valueHexView,
      ).toString('hex'),
    ).toBe(DIGEST);
    expect(
      Buffer.from((n as asn1js.Integer).valueBlock.valueHexView).toString(
        'hex',
      ),
    ).toBe(nonce);
    expect((certReq as asn1js.Boolean).valueBlock.value).toBe(true);
  });

  it('never starts a nonce with a zero byte, and makes a fresh one by default', () => {
    expect(buildTimestampRequest(DIGEST, Buffer.alloc(8)).nonce).toBe(
      '0100000000000000',
    );
    expect(buildTimestampRequest(DIGEST).nonce).toMatch(/^[0-7][0-9a-f]{15}$/);
  });

  it('refuses a value that is not a SHA-256 digest', () => {
    expect(() => buildTimestampRequest('abc')).toThrow('Not a SHA-256 digest');
  });
});

describe('reading a response', () => {
  const tsa = makeTestTsa();

  it('refuses bytes that are not a response, or have more after one', () => {
    expect(() => parseTimestampResponse(Buffer.from('nope'))).toThrow(
      'Not a time-stamp response',
    );
    expect(() =>
      parseTimestampResponse(
        Buffer.concat([tsa.respond(DIGEST), Buffer.from([0])]),
      ),
    ).toThrow('not one DER structure');
    expect(() =>
      parseTimestampResponse(tsa.respond(DIGEST, { noStatus: true })),
    ).toThrow('no status');
  });

  it('a refusal has a status and no token', () => {
    expect(
      parseTimestampResponse(tsa.respond(DIGEST, { status: 2, noToken: true })),
    ).toEqual({ status: 2 });
  });
});

describe('verifying a token (synthetic TSA shaped like FreeTSA)', () => {
  const tsa = makeTestTsa();
  const roots = [tsa.root];
  const check = (options: TokenOptions = {}, nonce?: string, digest = DIGEST) =>
    verifyTimestampToken(
      tokenOf(tsa.respond(DIGEST, options)),
      digest,
      roots,
      nonce,
    );

  it('passes a well-formed token, with and without a nonce', () => {
    expect(check().outcome).toBe('pass');
    expect(check({ nonce: '0a0b' }, '0a0b')).toMatchObject({
      outcome: 'pass',
      tst: { nonce: '0a0b', policy: '1.2.3.4.1' },
    });
  });

  it('fails a nonce that is not ours, or missing', () => {
    expect(check({ nonce: '0a0b' }, '0c0d')).toEqual({
      outcome: 'fail',
      reason: 'nonce does not match',
    });
    expect(check({}, '0c0d').outcome).toBe('fail');
  });

  it('accepts the signing-certificate attribute in each of its forms', () => {
    expect(check({ signingCertificate: 'v2' }).outcome).toBe('pass');
    expect(check({ signingCertificate: 'v2-alg' }).outcome).toBe('pass');
  });

  it.each<[string, TokenOptions, string]>([
    [
      'the content is not signed data',
      { contentType: '1.2.3' },
      'not a signed-data token',
    ],
    [
      'the content is not a TSTInfo',
      { eContentType: '1.2.3' },
      'not a time-stamp token',
    ],
    [
      'there are no signed attributes',
      { noSignedAttrs: true },
      'no signed attributes',
    ],
    [
      'the content-type attribute is wrong',
      { attrContentType: '1.2.3' },
      'wrong content-type attribute',
    ],
    [
      'the content-type attribute is missing',
      { attrContentType: null },
      'wrong content-type attribute',
    ],
    [
      'the message digest is wrong',
      { wrongMessageDigest: true },
      'message digest mismatch',
    ],
    [
      'the message digest is missing',
      { noMessageDigest: true },
      'message digest mismatch',
    ],
    [
      'the signing certificate is another',
      { signingCertificate: 'wrong' },
      'signing-certificate mismatch',
    ],
    [
      'no signing certificate is named',
      { signingCertificate: 'none' },
      'no signing-certificate attribute',
    ],
    [
      'an attribute appears twice',
      { duplicateAttribute: true },
      'attribute 1.2.840.113549.1.9.5 twice',
    ],
    [
      'the signature is not over these attributes',
      { badSignature: true },
      'bad signature',
    ],
    [
      'the imprint is not SHA-256',
      { imprintAlgorithm: '1.3.14.3.2.26' },
      'imprint does not match',
    ],
    ['there is no generation time', { noGenTime: true }, 'no generation time'],
    [
      'the serial is not an integer',
      { serialNotInteger: true },
      'an integer is missing',
    ],
    [
      'the content is a constructed octet string',
      { constructedEContent: true },
      'an octet string is missing',
    ],
  ])('fails when %s', (_, options, reason) => {
    expect(check(options)).toEqual({ outcome: 'fail', reason });
  });

  it.each<[string, TokenOptions, string]>([
    [
      'the signer is named by key id',
      { signerByKeyId: true },
      'signer named by key id, not issuer and serial',
    ],
    ['two signers', { twoSigners: true }, 'not exactly one signer'],
    [
      'an unknown digest algorithm',
      { digestAlgorithm: '1.2.3' },
      'unsupported algorithm',
    ],
    [
      'an unknown signature algorithm',
      { signatureAlgorithm: '1.2.3' },
      'unsupported algorithm',
    ],
    [
      'the signer certificate is not included',
      { noCertificates: true },
      'signer certificate absent',
    ],
    [
      'the signer serial matches no certificate',
      { signerSerial: '0bad' },
      'signer certificate absent',
    ],
    [
      'an unknown certificate hash',
      { signingCertificate: 'v2-unknown-alg' },
      'unknown certificate hash',
    ],
  ])('cannot measure (never a pass) when %s', (_, options, reason) => {
    expect(check(options)).toEqual({ outcome: 'cannot-measure', reason });
  });

  it('fails structures it cannot read at all, naming why', () => {
    const der = (node: asn1js.AsnType) => Buffer.from(node.toBER(false));
    expect(
      verifyTimestampToken(
        der(new asn1js.Sequence({ value: [new asn1js.Integer({ value: 1 })] })),
        DIGEST,
        roots,
      ),
    ).toEqual({ outcome: 'fail', reason: 'an object identifier is missing' });
    expect(
      verifyTimestampToken(
        der(
          new asn1js.Sequence({
            value: [
              new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.2' }),
            ],
          }),
        ),
        DIGEST,
        roots,
      ),
    ).toEqual({ outcome: 'fail', reason: 'not a signed-data token' });
    expect(
      verifyTimestampToken(Buffer.from([0x30, 0x05, 0x02]), DIGEST, roots),
    ).toEqual({
      outcome: 'fail',
      reason: 'not one DER structure',
    });
  });

  it('turns an unexpected error into a failure, never a pass', () => {
    // A "certificate" that is not one: X509Certificate itself throws.
    const verdict = verifyTimestampToken(
      tokenOf(tsa.respond(DIGEST, { junkCertificate: true })),
      DIGEST,
      roots,
    );
    expect(verdict.outcome).toBe('fail');
    expect(verdict.outcome !== 'pass' && verdict.reason).toMatch(
      /^unreadable token: /,
    );
  });

  it('fails a signer without the time-stamping purpose, or outside its validity', () => {
    const noEku = makeTestTsa({ tsaTimeStamping: false });
    expect(
      verifyTimestampToken(tokenOf(noEku.respond(DIGEST)), DIGEST, [
        noEku.root,
      ]),
    ).toEqual({ outcome: 'fail', reason: 'signer may not sign time stamps' });
    const expired = makeTestTsa({ tsaNotAfter: new Date('2026-01-01Z') });
    expect(
      verifyTimestampToken(tokenOf(expired.respond(DIGEST)), DIGEST, [
        expired.root,
      ]),
    ).toEqual({ outcome: 'fail', reason: 'signer not valid at that time' });
    const early = makeTestTsa({ tsaNotBefore: new Date('2027-01-01Z') });
    expect(
      verifyTimestampToken(tokenOf(early.respond(DIGEST)), DIGEST, [
        early.root,
      ]),
    ).toEqual({ outcome: 'fail', reason: 'signer not valid at that time' });
  });

  it('follows an intermediate certificate up to the pinned root, and only to it', () => {
    const chained = makeTestTsa({ intermediate: true });
    const token = tokenOf(chained.respond(DIGEST));
    expect(verifyTimestampToken(token, DIGEST, [chained.root]).outcome).toBe(
      'pass',
    );
    expect(verifyTimestampToken(token, DIGEST, [FREETSA_ROOT])).toEqual({
      outcome: 'fail',
      reason: 'not signed by a trusted TSA',
    });
  });

  it('reads an RSA signer whose SignerInfo names rsaEncryption', () => {
    const rsa = makeTestTsa({ rsa: true });
    expect(
      verifyTimestampToken(tokenOf(rsa.respond(DIGEST)), DIGEST, [rsa.root])
        .outcome,
    ).toBe('pass');
    expect(
      verifyTimestampToken(
        tokenOf(rsa.respond(DIGEST, { digestAlgorithm: '1.2.3' })),
        DIGEST,
        [rsa.root],
      ),
    ).toEqual({ outcome: 'cannot-measure', reason: 'unsupported algorithm' });
  });
});

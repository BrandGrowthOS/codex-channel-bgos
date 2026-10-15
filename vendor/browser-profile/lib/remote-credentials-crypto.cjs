'use strict';

// The host and Electron main share this exact protocol. The authenticated HOAI
// relay remains the public-key authority; this protects payload handling, not
// an actively compromised server or either endpoint.
const { generateKeyPairSync, createPublicKey, diffieHellman, hkdfSync,
  randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const DOMAIN = 'HOAI remote credentials v1';
const MAX_PLAINTEXT = 8192;
const fields = ['v', 'viewId', 'sessionId', 'tabId', 'assistantId', 'principal',
  'requestId', 'operation', 'origin', 'expiresAt', 'publicKey', 'salt'];
const packet = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => packet(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function decode(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('credential_envelope');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw new Error('credential_envelope');
  return bytes;
}
function publicKey(value) {
  const key = createPublicKey({ key: decode(value, 44), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('credential_envelope');
  return key;
}
function validate(offer) {
  if (!exact(offer, fields) || offer.v !== 1 || !token(offer.viewId) || !token(offer.sessionId) ||
    !token(offer.tabId) || !token(offer.requestId) || !Number.isSafeInteger(offer.assistantId) || offer.assistantId <= 0 ||
    typeof offer.principal !== 'string' || !/^user-[A-Za-z0-9_-]{1,128}$/.test(offer.principal) ||
    !['unlock', 'login', 'fill', 'forget', 'store', 'field'].includes(offer.operation) || typeof offer.origin !== 'string' ||
    offer.origin.length > 2048 || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= Date.now() ||
    offer.expiresAt > Date.now() + 125000) throw new Error('credential_offer');
  if (offer.origin) {
    let url; try { url = new URL(offer.origin); } catch { throw new Error('credential_offer'); }
    if (url.origin !== offer.origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('credential_offer');
  } else if (offer.operation !== 'unlock') throw new Error('credential_offer');
  publicKey(offer.publicKey); decode(offer.salt, 32);
  return Buffer.from(JSON.stringify([DOMAIN, ...fields.map(key => offer[key])]));
}
function keyFor(offer, privateKey, peer) {
  return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey: publicKey(peer) }),
    decode(offer.salt, 32), validate(offer), 32));
}
function createOffer(context) {
  const { publicKey: pub, privateKey } = generateKeyPairSync('x25519');
  const offer = { ...context, v: 1, publicKey: pub.export({ format: 'der', type: 'spki' }).toString('base64'),
    salt: randomBytes(32).toString('base64') };
  validate(offer);
  return { offer, privateKey };
}
function sealOffer(offer, payload) {
  const aad = validate(offer);
  if (!packet(payload)) throw new Error('credential_payload');
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (!plaintext.length || plaintext.length > MAX_PLAINTEXT) throw new Error('credential_payload');
  const pair = generateKeyPairSync('x25519');
  const key = keyFor(offer, pair.privateKey, offer.publicKey), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { requestId: offer.requestId, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally { key.fill(0); plaintext.fill(0); }
}
function openOffer(offer, privateKey, envelope) {
  const aad = validate(offer);
  if (!exact(envelope, ['requestId', 'publicKey', 'iv', 'ciphertext', 'tag']) || envelope.requestId !== offer.requestId)
    throw new Error('credential_envelope');
  const encrypted = decode(envelope.ciphertext);
  if (!encrypted.length || encrypted.length > MAX_PLAINTEXT) throw new Error('credential_envelope');
  const key = keyFor(offer, privateKey, envelope.publicKey);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
    decipher.setAAD(aad); decipher.setAuthTag(decode(envelope.tag, 16));
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (!packet(payload)) throw new Error('credential_payload');
    return payload;
  } finally { key.fill(0); plaintext?.fill(0); }
}
module.exports = { createOffer, sealOffer, openOffer, MAX_PLAINTEXT };

'use strict';
// Briques communes du protocole télécommande Android TV v2 :
// messages protobuf, découpage des trames, certificat client, secret d'appairage.
//
// Les fichiers .proto viennent de androidtv-remote (louis49, licence ISC).

const path = require('node:path');
const crypto = require('node:crypto');
const protobuf = require('protobufjs');
const forge = require('node-forge');

const root = protobuf.loadSync([
  path.join(__dirname, 'proto', 'pairingmessage.proto'),
  path.join(__dirname, 'proto', 'remotemessage.proto'),
]);

const PairingMessage = root.lookupType('pairing.PairingMessage');
const RemoteMessage = root.lookupType('remote.RemoteMessage');
const PairingStatus = root.lookupEnum('pairing.PairingMessage.Status').values;
const RoleType = root.lookupEnum('pairing.RoleType').values;
const EncodingType = root.lookupEnum('pairing.PairingEncoding.EncodingType').values;
const KeyCode = root.lookupEnum('remote.RemoteKeyCode').values;
const Direction = root.lookupEnum('remote.RemoteDirection').values;

/** Encode un message précédé de sa longueur (varint), comme l'attend le Player. */
function encode(Type, payload) {
  const err = Type.verify(payload);
  if (err) throw new Error(`Message invalide : ${err}`);
  return Buffer.from(Type.encodeDelimited(Type.create(payload)).finish());
}

/**
 * Accumule les octets reçus et rend les trames complètes.
 * Gère les longueurs sur plusieurs octets (messages ≥ 128 o) et plusieurs
 * messages collés dans un même paquet TCP — les deux cas que l'ancienne
 * bibliothèque ratait, ce qui la laissait muette jusqu'au timeout.
 */
class FrameReader {
  // Les vrais messages du Player font moins de 200 octets. Au-delà de cette
  // limite, c'est un appareil défaillant ou malveillant : on refuse plutôt
  // que de laisser la mémoire gonfler en attendant la suite.
  static MAX_FRAME = 64 * 1024;

  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    let off = 0;
    while (off < this.buf.length) {
      let len = 0, shift = 0, p = off, complete = false;
      while (p < this.buf.length) {
        const b = this.buf[p++];
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(b & 0x80)) { complete = true; break; }
        if (shift > 28) throw new Error('Longueur de trame invalide');
      }
      if (len > FrameReader.MAX_FRAME) throw new Error(`Trame trop grande (${len} o)`);
      if (!complete || p + len > this.buf.length) break;
      frames.push(this.buf.subarray(p, p + len));
      off = p + len;
    }
    this.buf = this.buf.subarray(off);
    return frames;
  }
}

/** Crée le certificat client (auto-signé, RSA 2048) présenté au Player. */
function generateCertificate(commonName = 'homebridge-freebox-player-pop') {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const fKey = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(fKey.n, fKey.e);
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date('2099-12-31T00:00:00Z');
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'countryName', value: 'FR' },
    { name: 'organizationName', value: 'Homebridge' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(fKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: keyPem };
}

function hexBytes(hex) {
  const h = hex.replace(/^0x/i, '');
  return Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
}

/**
 * Secret d'appairage : SHA-256(module client, exposant client, module Player,
 * exposant Player, 2 derniers octets du code). Le 1er octet du hash doit
 * égaler le 1er octet du code, sinon le code saisi est faux.
 */
function pairingSecret(clientCert, serverCert, code) {
  const c = code.trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(c)) throw new Error('Le code doit faire 6 caractères hexadécimaux (0-9, A-F)');
  const hash = crypto.createHash('sha256')
    .update(hexBytes(clientCert.modulus))
    .update(hexBytes(clientCert.exponent))
    .update(hexBytes(serverCert.modulus))
    .update(hexBytes(serverCert.exponent))
    .update(hexBytes(c.slice(2)))
    .digest();
  if (hash[0] !== parseInt(c.slice(0, 2), 16)) throw new Error('Code incorrect');
  return hash;
}

/**
 * Résumé d'un message pour le journal, sans contenu sensible : jamais le texte
 * des champs de saisie (recherche, identifiants tapés sur la TV).
 */
function describe(msg) {
  const types = Object.keys(msg.toJSON());
  const extra = [];
  if (msg.remoteStart) extra.push(`started=${!!msg.remoteStart.started}`);
  if (msg.remoteImeKeyInject?.appInfo?.appPackage) extra.push(`app=${msg.remoteImeKeyInject.appInfo.appPackage}`);
  if (msg.remoteConfigure?.deviceInfo) {
    const d = msg.remoteConfigure.deviceInfo;
    extra.push(`modèle=${d.model}`, `service=${d.appVersion}`);
  }
  return types.join(',') + (extra.length ? ` (${extra.join(', ')})` : '');
}

/** Empreinte SHA-256 normalisée d'un certificat (format « AA:BB:… »). */
function fingerprintOf(peerCert) {
  return peerCert && peerCert.fingerprint256 ? peerCert.fingerprint256.toUpperCase() : null;
}

module.exports = {
  PairingMessage, RemoteMessage, PairingStatus, RoleType, EncodingType, KeyCode, Direction,
  encode, FrameReader, generateCertificate, pairingSecret, describe, fingerprintOf,
};

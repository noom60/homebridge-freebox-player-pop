'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/protocol');

const ping = P.encode(P.RemoteMessage, { remotePingRequest: { val1: 7 } });
const big = P.encode(P.RemoteMessage, { remoteConfigure: { code1: 622, deviceInfo: { model: 'x'.repeat(200) } } });

test('messages collés dans un même paquet', () => {
  const r = new P.FrameReader();
  assert.strictEqual(r.push(Buffer.concat([ping, ping, ping])).length, 3);
});

test('message de plus de 127 octets coupé en morceaux', () => {
  const r = new P.FrameReader();
  const all = Buffer.concat([ping, big, ping]);
  let n = 0;
  for (const c of [all.subarray(0, 3), all.subarray(3, 150), all.subarray(150)]) n += r.push(c).length;
  assert.strictEqual(n, 3);
  assert.strictEqual(r.buf.length, 0);
});

test('décodage fidèle', () => {
  const r = new P.FrameReader();
  const [frame] = r.push(big);
  assert.strictEqual(P.RemoteMessage.decode(frame).remoteConfigure.deviceInfo.model.length, 200);
});

test('code d\'appairage mal formé refusé', () => {
  const cert = { modulus: 'AB', exponent: '0x10001' };
  assert.throws(() => P.pairingSecret(cert, cert, '12345'), /6 caractères/);
  assert.throws(() => P.pairingSecret(cert, cert, 'ZZZZZZ'), /6 caractères/);
});

test('secret : le 1er octet du hash doit égaler le 1er octet du code', () => {
  const cert = { modulus: 'C0FFEE', exponent: '0x10001' };
  // Cherche le code valide pour ces certificats, puis vérifie qu'un autre préfixe est refusé.
  for (let i = 0; i < 256; i++) {
    const code = i.toString(16).padStart(2, '0') + 'A1B2';
    try {
      const secret = P.pairingSecret(cert, cert, code);
      assert.strictEqual(secret[0], i);
      const wrong = ((i + 1) % 256).toString(16).padStart(2, '0') + 'A1B2';
      assert.throws(() => P.pairingSecret(cert, cert, wrong), /Code incorrect/);
      return;
    } catch (e) { if (!/Code incorrect/.test(e.message)) throw e; }
  }
  assert.fail('aucun préfixe valide trouvé');
});

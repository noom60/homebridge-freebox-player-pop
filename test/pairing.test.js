'use strict';
// Appairage complet contre un faux Player (port d'appairage simulé), et
// serveur de l'écran de réglages Homebridge piloté comme le fait l'interface.
const test = require('node:test');
const assert = require('node:assert');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const P = require('../lib/protocol');
const { PairingSession } = require('../lib/pairing-session');
const store = require('../lib/store');

const playerCert = P.generateCertificate('faux-player');
const tmpStorage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fbxpop-'));

/** Faux Player : suit le protocole d'appairage et vérifie le secret reçu. */
function fakePairingPlayer() {
  const state = { code: null, closed: 0, secretsReceived: 0 };
  const server = tls.createServer({ ...playerCert, requestCert: true, rejectUnauthorized: false }, (s) => {
    const reader = new P.FrameReader();
    const send = (payload, status = P.PairingStatus.STATUS_OK) =>
      s.write(P.encode(P.PairingMessage, { protocolVersion: 2, status, ...payload }));
    s.on('error', () => {});
    s.on('close', () => { state.closed++; });
    s.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        const m = P.PairingMessage.decode(frame);
        if (m.pairingRequest) send({ pairingRequestAck: { serverName: 'Faux Player' } });
        else if (m.pairingOption) send({ pairingOption: { preferredRole: P.RoleType.ROLE_TYPE_INPUT } });
        else if (m.pairingConfiguration) {
          // Le Player « affiche » un code valide pour ces deux certificats.
          const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
          for (let i = 0; i < 256 && !state.code; i++) {
            const c = i.toString(16).padStart(2, '0').toUpperCase() + suffix;
            try { P.pairingSecret(s.getPeerCertificate(), s.getCertificate(), c); state.code = c; } catch {}
          }
          send({ pairingConfigurationAck: {} });
        } else if (m.pairingSecret) {
          state.secretsReceived++;
          const expected = P.pairingSecret(s.getPeerCertificate(), s.getCertificate(), state.code);
          if (Buffer.compare(Buffer.from(m.pairingSecret.secret), expected) === 0) send({ pairingSecretAck: { secret: expected } });
          else send({}, P.PairingStatus.STATUS_BAD_SECRET);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

/** Un code de même forme mais faux (premier octet différent). */
const wrongCode = (code) => ((parseInt(code.slice(0, 2), 16) + 1) % 256).toString(16).padStart(2, '0').toUpperCase() + code.slice(2);

test('appairage : faute de frappe rattrapée, puis succès et identité enregistrée', async () => {
  const { server, port, state } = await fakePairingPlayer();
  const storage = tmpStorage();
  const session = new PairingSession({ storagePath: storage, port });

  assert.deepStrictEqual(await session.start('127.0.0.1'), { status: 'code', error: null });
  const retry = await session.submitCode(wrongCode(state.code));
  assert.strictEqual(retry.status, 'code');
  assert.match(retry.error, /Code incorrect/);
  assert.strictEqual(state.secretsReceived, 0, "un code faux n'est jamais envoyé au Player");

  const done = await session.submitCode(state.code.toLowerCase());   // casse indifférente
  assert.strictEqual(done.status, 'paired');
  assert.strictEqual(done.fingerprint, new crypto.X509Certificate(playerCert.cert).fingerprint256);
  const saved = store.loadCerts(storage, '127.0.0.1');
  assert.strictEqual(saved.paired, true);
  assert.strictEqual(saved.serverFingerprint, done.fingerprint);
  assert.deepStrictEqual(session.status('127.0.0.1'), { paired: true, fingerprint: done.fingerprint });
  server.close();
});

test('appairage : annulation ferme la connexion, on peut recommencer', async () => {
  const { server, port } = await fakePairingPlayer();
  const session = new PairingSession({ storagePath: tmpStorage(), port });
  await session.start('127.0.0.1');
  session.cancel();
  await assert.rejects(session.submitCode('ABCDEF'), /Aucun appairage en cours/);
  assert.deepStrictEqual(await session.start('127.0.0.1'), { status: 'code', error: null });
  session.cancel();
  server.close();
});

test('appairage : adresse invalide refusée sans connexion', async () => {
  const session = new PairingSession({ storagePath: tmpStorage() });
  await assert.rejects(session.start('mafreebox.freebox.fr'), /Adresse IP invalide/);
  await assert.rejects(session.start('192.168.1.300'), /Adresse IP invalide/);
  assert.deepStrictEqual(session.status('192.168.1.37'), { paired: false, fingerprint: null });
});

test("écran de réglages : le serveur répond comme l'attend l'interface Homebridge", async () => {
  const storage = tmpStorage();
  const child = fork(path.join(__dirname, '..', 'homebridge-ui', 'server.js'), [], {
    env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: storage }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve) => child.on('message', (m) => {
    if (m.action === 'ready') resolve();
    if (m.action === 'response') pending.get(m.payload.requestId)(m.payload);
  }));
  const request = (p, body) => new Promise((resolve) => {
    const requestId = nextId++;
    pending.set(requestId, resolve);
    child.send({ action: 'request', requestId, path: p, body });
  });
  try {
    await ready;
    assert.deepStrictEqual(await request('/status', { host: '192.168.1.37' }),
      { requestId: 1, success: true, data: { paired: false, fingerprint: null } });
    const bad = await request('/pair/start', { host: 'pas-une-ip' });
    assert.strictEqual(bad.success, false);
    assert.match(bad.data.message, /Adresse IP invalide/);
    const noSession = await request('/pair/code', { code: 'ABCDEF' });
    assert.strictEqual(noSession.success, false);
    assert.strictEqual((await request('/pair/cancel', {})).data.status, 'cancelled');
  } finally {
    child.kill();
  }
});

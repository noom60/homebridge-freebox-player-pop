'use strict';
// Faux Player en local pour tester la connexion, l'empreinte et la résistance
// aux messages piégés, sans toucher au vrai Player.
const test = require('node:test');
const assert = require('node:assert');
const tls = require('node:tls');
const crypto = require('node:crypto');
const P = require('../lib/protocol');
const { AndroidTvRemote } = require('../lib/remote');

const playerCert = P.generateCertificate('faux-player');
const otherCert = P.generateCertificate('imposteur');
const clientCert = P.generateCertificate('client');
const fp = (pem) => new crypto.X509Certificate(pem).fingerprint256;

const hello = Buffer.concat([
  P.encode(P.RemoteMessage, { remoteConfigure: { code1: 623, deviceInfo: { model: 'Freebox Player POP' } } }),
  P.encode(P.RemoteMessage, { remoteSetActive: {} }),
  P.encode(P.RemoteMessage, { remoteStart: { started: true } }),
]);

/** Démarre un faux Player ; `onClient(socket)` décide de ce qu'il envoie. */
function fakePlayer(certs, onClient) {
  const received = [];
  const server = tls.createServer({ ...certs, requestCert: true, rejectUnauthorized: false }, (s) => {
    s.on('data', (d) => received.push(d));
    s.on('error', () => {});
    onClient(s);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}

const once = (emitter, ev, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`pas d'événement ${ev}`)), ms);
  emitter.once(ev, (v) => { clearTimeout(t); resolve(v); });
});

test('messages collés dès la connexion : connecté, allumé, empreinte retenue', async () => {
  const { server, port } = await fakePlayer(playerCert, (s) => s.write(hello));
  const r = new AndroidTvRemote({ host: '127.0.0.1', port, certs: clientCert });
  const learned = once(r, 'fingerprint');
  const power = once(r, 'power');
  r.start();
  assert.strictEqual(await learned, fp(playerCert.cert));
  assert.strictEqual(await power, true);
  assert.strictEqual(r.ready, true);
  r.stop(); server.close();
});

test('imposteur : connexion refusée avant tout échange', async () => {
  const { server, port, received } = await fakePlayer(otherCert, (s) => s.write(hello));
  const r = new AndroidTvRemote({ host: '127.0.0.1', port, certs: clientCert, fingerprint: fp(playerCert.cert) });
  let connected = false;
  r.on('connected', () => { connected = true; });
  r.start();
  assert.strictEqual(await once(r, 'untrusted'), fp(otherCert.cert));
  await new Promise((res) => setTimeout(res, 300));
  r.stop(); server.close();
  assert.strictEqual(connected, false);
  assert.strictEqual(r.power, null, "l'état envoyé par l'imposteur est ignoré");
  assert.strictEqual(Buffer.concat(received).length, 0, "rien n'est envoyé à l'imposteur");
});

test('message malformé : pas de plantage, connexion coupée puis reprise', async () => {
  let n = 0;
  const { server, port } = await fakePlayer(playerCert, (s) => {
    n++;
    s.write(hello);
    if (n === 1) setTimeout(() => s.write(Buffer.from([0x04, 0x0a, 0xff, 0xff, 0x01])), 50);
  });
  const r = new AndroidTvRemote({ host: '127.0.0.1', port, certs: clientCert, fingerprint: fp(playerCert.cert) });
  r.start();
  await once(r, 'connected');
  await once(r, 'disconnected');
  await once(r, 'connected', 8000);   // reconnexion automatique (2 s)
  r.stop(); server.close();
});

test('longueur annoncée énorme : refus immédiat', async () => {
  const { server, port } = await fakePlayer(playerCert, (s) => {
    s.write(hello);
    setTimeout(() => s.write(Buffer.from([0x80, 0x80, 0x80, 0x40])), 50);   // ~128 Mo annoncés
  });
  const r = new AndroidTvRemote({ host: '127.0.0.1', port, certs: clientCert, fingerprint: fp(playerCert.cert) });
  r.start();
  await once(r, 'connected');
  await once(r, 'disconnected');
  r.stop(); server.close();
});

test('appli au premier plan annoncée, ouverture d\'appli envoyée au Player', async () => {
  const got = [];
  let playerSocket;
  const { server, port } = await fakePlayer(playerCert, (s) => {
    playerSocket = s;
    const reader = new P.FrameReader();
    s.on('data', (d) => { for (const f of reader.push(d)) got.push(P.RemoteMessage.decode(f)); });
    s.write(Buffer.concat([hello, P.encode(P.RemoteMessage, {
      remoteImeKeyInject: { appInfo: { appPackage: 'net.oqee.androidtv' } },
    })]));
  });
  const r = new AndroidTvRemote({ host: '127.0.0.1', port, certs: clientCert, fingerprint: fp(playerCert.cert) });
  const app = once(r, 'app');
  r.start();
  assert.strictEqual(await app, 'net.oqee.androidtv');
  r.launchApp('com.netflix.ninja');
  r.launchApp('https://www.youtube.com/watch?v=abc');
  r.launchApp('key:KEYCODE_HOME');
  assert.throws(() => r.launchApp('rm -rf /'), /Appli invalide/);
  assert.throws(() => r.launchApp('key:KEYCODE_NIMPORTEQUOI'), /Touche inconnue/);
  // Refus du Player : il renvoie la commande refusée.
  const rejected = once(r, 'rejected');
  playerSocket.write(P.encode(P.RemoteMessage, { remoteError: { value: true, message: { remoteAppLinkLaunchRequest: { appLink: 'market://x' } } } }));
  assert.strictEqual(await rejected, 'ouverture de market://x');
  await new Promise((res) => setTimeout(res, 200));
  const links = got.filter((m) => m.remoteAppLinkLaunchRequest).map((m) => m.remoteAppLinkLaunchRequest.appLink);
  assert.deepStrictEqual(links, ['market://launch?id=com.netflix.ninja', 'https://www.youtube.com/watch?v=abc']);
  assert.strictEqual(got.filter((m) => m.remoteKeyInject && m.remoteKeyInject.keyCode === P.KeyCode.KEYCODE_HOME).length, 1);
  r.stop(); server.close();
});

test('sources : liste par défaut, validation et plafond', () => {
  const { sanitizeApps, DEFAULT_APPS } = require('../index');
  const log = { warn: () => {} };
  assert.strictEqual(sanitizeApps(undefined, log, 'x'), DEFAULT_APPS);
  assert.strictEqual(sanitizeApps([], log, 'x'), DEFAULT_APPS);
  assert.deepStrictEqual(sanitizeApps([
    { name: ' Canal+ ', link: 'https://www.canalplus.com', package: 'com.canal.android.canal' },
    { name: 'Sans lien', package: 'com.exemple.tv' },
    { name: 'Accueil', link: 'key:KEYCODE_HOME', package: 'net.oqee.androidtv, net.oqee.launcher' },
    { name: '', link: 'https://vide.example' },
    { name: 'Piège', link: 'https://x.example', package: 'com.x; rm -rf /' },
    { name: 'Schéma refusé', link: 'javascript:alert(1)' },
    null,
  ], log, 'x'), [
    { name: 'Canal+', link: 'https://www.canalplus.com', packages: ['com.canal.android.canal'] },
    { name: 'Sans lien', link: 'com.exemple.tv', packages: ['com.exemple.tv'] },
    { name: 'Accueil', link: 'key:KEYCODE_HOME', packages: ['net.oqee.androidtv', 'net.oqee.launcher'] },
  ]);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `A${i}`, link: `https://a${i}.example` }));
  assert.strictEqual(sanitizeApps(many, log, 'x').length, 30);
});

test('journal : le texte saisi sur la TV n\'apparaît jamais', () => {
  const msg = P.RemoteMessage.decode(P.encode(P.RemoteMessage, {
    remoteImeKeyInject: { appInfo: { appPackage: 'com.netflix' }, textFieldStatus: { value: 'MotDePasse123', label: 'password' } },
  }).subarray(1));
  const line = P.describe(msg);
  assert.match(line, /com\.netflix/);
  assert.doesNotMatch(line, /MotDePasse123|password/);
});

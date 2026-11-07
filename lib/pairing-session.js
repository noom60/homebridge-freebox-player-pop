'use strict';
// Appairage piloté pas à pas, pour l'écran de réglages Homebridge :
//   start()       → le Player affiche le code, on attend la saisie
//   submitCode()  → appairé, ou « code faux, réessaie »
// Une seule session à la fois.

const { pair, PAIRING_PORT } = require('./pairing');
const store = require('./store');

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

class PairingSession {
  constructor({ storagePath, port = PAIRING_PORT }) {
    this.storagePath = storagePath;
    this.port = port;
    this.active = null;
  }

  /** Démarre l'appairage ; se résout quand le Player affiche le code. */
  start(host) {
    if (typeof host !== 'string' || !IPV4.test(host.trim())) {
      return Promise.reject(new Error('Adresse IP invalide'));
    }
    host = host.trim();
    this.cancel();

    const certs = store.loadOrCreateCerts(this.storagePath, host);
    const s = { host, certs, waiters: [], codeResolver: null, done: false, abort: new AbortController() };
    this.active = s;

    // Prochain événement de la session : { status: 'code', error? } | { status: 'paired' } | erreur.
    const next = () => new Promise((resolve, reject) => s.waiters.push({ resolve, reject }));
    const emit = (value, isError = false) => {
      const w = s.waiters.shift();
      if (w) isError ? w.reject(value) : w.resolve(value);
      else s.pending = { value, isError };
    };
    s.next = () => {
      if (s.pending) {
        const { value, isError } = s.pending;
        s.pending = null;
        return isError ? Promise.reject(value) : Promise.resolve(value);
      }
      return next();
    };

    s.promise = pair({
      host, certs, port: this.port, signal: s.abort.signal,
      askCode: (lastError) => new Promise((resolve) => {
        s.codeResolver = resolve;
        emit({ status: 'code', error: lastError || null });
      }),
    }).then(({ fingerprint }) => {
      store.saveCerts(this.storagePath, host, { ...certs, paired: true, serverFingerprint: fingerprint });
      s.done = true;
      emit({ status: 'paired', host, fingerprint });
    }).catch((err) => {
      s.done = true;
      emit(err, true);
    });

    return s.next();
  }

  /** Envoie le code saisi ; se résout par « appairé » ou « code faux ». */
  submitCode(code) {
    const s = this.active;
    if (!s || s.done || !s.codeResolver) return Promise.reject(new Error("Aucun appairage en cours : clique d'abord sur « Appairer »"));
    const resolve = s.codeResolver;
    s.codeResolver = null;
    resolve(String(code || ''));
    return s.next();
  }

  cancel() {
    const s = this.active;
    this.active = null;
    if (s && !s.done) s.abort.abort();   // ferme la connexion d'appairage
  }

  /** État d'appairage d'un Player, sans secret. */
  status(host) {
    const certs = typeof host === 'string' ? store.loadCerts(this.storagePath, host.trim()) : null;
    return {
      paired: !!(certs && certs.paired),
      fingerprint: certs && certs.serverFingerprint ? certs.serverFingerprint : null,
    };
  }
}

module.exports = { PairingSession };

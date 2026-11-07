'use strict';
// Connexion télécommande (port 6466), maintenue en permanence.
//
// Événements :
//   'power'       (on: boolean)  état écran allumé / veille annoncé par le Player
//   'connected' / 'disconnected'
//   'unpaired'                   le Player refuse notre certificat
//   'fingerprint' (fp: string)   1re connexion sans empreinte connue : à mémoriser
//   'untrusted'   (fp: string)   l'appareil en face n'est pas le Player appairé
//   'app'         (pkg: string)  appli au premier plan (ex. net.oqee.androidtv)
//   'rejected'    (what: string) le Player a refusé une commande
//   'debug'       (msg: string)

const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const P = require('./protocol');

const REMOTE_PORT = 6466;
const IDLE_TIMEOUT = 20000;          // le Player envoie un ping toutes les ~5 s
const BACKOFF = [2000, 5000, 10000, 30000, 60000];

class AndroidTvRemote extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.host
   * @param {{cert:string,key:string}} o.certs
   * @param {string|null} [o.fingerprint]  empreinte SHA-256 attendue du Player
   */
  constructor({ host, certs, fingerprint = null, version = '0.0.0', port = REMOTE_PORT }) {
    super();
    this.host = host;
    this.port = port;
    this.certs = certs;
    this.fingerprint = fingerprint ? fingerprint.toUpperCase() : null;
    this.version = version;
    this.power = null;               // null = inconnu
    this.currentApp = null;
    this.ready = false;
    this.failures = 0;
    this.stopped = true;
    this.socket = null;
    this.retryTimer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.socket) this.socket.destroy();
  }

  /** Relance tout de suite une connexion (ex. avant d'envoyer une commande). */
  reconnectNow() {
    if (this.stopped || this.socket) return;
    clearTimeout(this.retryTimer);
    this._connect();
  }

  /** Attend que la connexion soit prête, au plus `ms` millisecondes. */
  waitReady(ms) {
    if (this.ready) return Promise.resolve(true);
    this.reconnectNow();
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('connected', ok); resolve(false); }, ms);
      const ok = () => { clearTimeout(t); resolve(true); };
      this.once('connected', ok);
    });
  }

  sendKey(keyName, direction = 'SHORT') {
    if (!this.ready) throw new Error('Player non connecté');
    const keyCode = P.KeyCode[keyName];
    if (keyCode === undefined) throw new Error(`Touche inconnue : ${keyName}`);
    this._send({ remoteKeyInject: { keyCode, direction: P.Direction[direction] } });
  }

  /**
   * Ouvre une source :
   *   - « https://… »  lien que le Player confie à l'appli concernée
   *                    (le Player POP refuse les liens market:// et intent:) ;
   *   - « key:KEYCODE_HOME » touche de télécommande (Oqee = écran d'accueil) ;
   *   - « com.exemple.appli » nom de paquet, via market:// (autres Android TV).
   */
  launchApp(target) {
    if (!this.ready) throw new Error('Player non connecté');
    if (typeof target !== 'string' || !/^[\w.:/?=&%#+@~-]{3,512}$/.test(target)) throw new Error('Appli invalide');
    if (target.startsWith('key:')) return this.sendKey(target.slice(4));
    const appLink = target.includes('://') ? target : `market://launch?id=${target}`;
    this._send({ remoteAppLinkLaunchRequest: { appLink } });
  }

  _send(payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('Player non connecté');
    this.socket.write(P.encode(P.RemoteMessage, payload));
  }

  _connect() {
    const reader = new P.FrameReader();
    let handshaken = false;
    let trusted = false;
    const socket = tls.connect({
      host: this.host, port: this.port,
      cert: this.certs.cert, key: this.certs.key,
      // Le Player a un certificat auto-signé : pas d'autorité à vérifier.
      // On le vérifie nous-mêmes par son empreinte, juste en dessous.
      rejectUnauthorized: false,
    });
    this.socket = socket;
    socket.setTimeout(IDLE_TIMEOUT, () => {
      this.emit('debug', `aucune donnée depuis ${IDLE_TIMEOUT / 1000} s, on coupe`);
      socket.destroy();
    });

    socket.on('secureConnect', () => {
      handshaken = true;
      const fp = P.fingerprintOf(socket.getPeerCertificate());
      if (!this.fingerprint) {
        // Appairé avant la v0.1.1 : on fait confiance à la 1re connexion
        // (le Player vient d'accepter notre certificat appairé) et on retient.
        this.fingerprint = fp;
        this.emit('fingerprint', fp);
      } else if (fp !== this.fingerprint) {
        this.emit('untrusted', fp);
        return socket.destroy();
      }
      trusted = true;
      this.emit('debug', 'TLS établi, Player authentifié');
    });

    socket.on('data', (chunk) => {
      if (!trusted) return;
      try {
        for (const frame of reader.push(chunk)) {
          this._onMessage(P.RemoteMessage.decode(frame), frame.length);
        }
      } catch (e) {
        // Message malformé : on coupe proprement au lieu de faire planter Homebridge.
        this.emit('debug', `message illisible (${e.message}), on coupe`);
        socket.destroy();
      }
    });

    socket.on('error', (err) => {
      this.emit('debug', `erreur ${err.code || err.message}`);
      // Refus pendant la poignée de main TLS : certificat inconnu du Player.
      if (!handshaken && (err.code === 'ECONNRESET' || /certificate|alert/i.test(err.message))) {
        this.emit('unpaired');
      }
    });

    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      const wasReady = this.ready;
      this.ready = false;
      if (wasReady) { this.failures = 0; this.emit('disconnected'); }
      if (this.stopped) return;
      const delay = BACKOFF[Math.min(this.failures, BACKOFF.length - 1)];
      this.failures++;
      this.emit('debug', `nouvelle tentative dans ${delay / 1000} s`);
      this.retryTimer = setTimeout(() => this._connect(), delay);
    });
  }

  _onMessage(msg, size) {
    if (msg.remotePingRequest) {
      return this._send({ remotePingResponse: { val1: msg.remotePingRequest.val1 } });
    }
    this.emit('debug', `reçu (${size} o) ${P.describe(msg)}`);
    if (msg.remoteConfigure) {
      this._send({
        remoteConfigure: {
          code1: 622,
          deviceInfo: {
            model: 'Homebridge', vendor: 'homebridge-freebox-player-pop',
            unknown1: 1, unknown2: '1',
            packageName: 'homebridge-freebox-player-pop', appVersion: this.version,
          },
        },
      });
    } else if (msg.remoteSetActive) {
      this._send({ remoteSetActive: { active: 622 } });
      if (!this.ready) {
        this.ready = true;
        this.failures = 0;
        this.emit('connected');
      }
    } else if (msg.remoteStart) {
      const on = !!msg.remoteStart.started;
      if (on !== this.power) { this.power = on; this.emit('power', on); }
    } else if (msg.remoteError) {
      // Le Player renvoie la commande qu'il refuse, puis coupe la connexion.
      const refused = msg.remoteError.message || {};
      const what = refused.remoteAppLinkLaunchRequest ? `ouverture de ${refused.remoteAppLinkLaunchRequest.appLink}`
        : refused.remoteKeyInject ? `touche ${P.RemoteMessage.toObject(refused, { enums: String }).remoteKeyInject.keyCode}`
        : Object.keys(refused.toJSON ? refused.toJSON() : {}).join(',') || 'commande inconnue';
      this.emit('rejected', what);
    } else if (msg.remoteImeKeyInject && msg.remoteImeKeyInject.appInfo && msg.remoteImeKeyInject.appInfo.appPackage) {
      const app = msg.remoteImeKeyInject.appInfo.appPackage;
      if (app !== this.currentApp) { this.currentApp = app; this.emit('app', app); }
    }
  }
}

module.exports = { AndroidTvRemote, REMOTE_PORT };

'use strict';
// Plugin Homebridge : un interrupteur HomeKit par Freebox Player POP.
// L'état affiché est celui que le Player annonce lui-même (allumé / veille).

const { AndroidTvRemote } = require('./lib/remote');
const store = require('./lib/store');
const { version } = require('./package.json');

const PLUGIN_NAME = 'homebridge-freebox-player-pop';
const PLATFORM_NAME = 'FreeboxPlayerPop';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, FreeboxPlayerPopPlatform);
};

class FreeboxPlayerPopPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.cached = new Map();
    this.players = [];

    api.on('didFinishLaunching', () => this.setup());
    api.on('shutdown', () => this.players.forEach((p) => p.remote.stop()));
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  setup() {
    const list = Array.isArray(this.config.players) ? this.config.players : [];
    const wanted = new Set();
    if (!list.length) {
      // Non configuré : on ne démarre rien.
      this.log.info('Aucun Player configuré. Ouvre les réglages du plugin pour appairer et ajouter un Player.');
    }

    for (const conf of list) {
      // Une erreur sur un Player ne doit ni bloquer les autres ni faire tomber Homebridge.
      try {
        if (!conf || !conf.host) { this.log.warn('Player ignoré : adresse IP manquante'); continue; }
        const name = conf.name || 'Freebox Player';
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${conf.host}`);
        wanted.add(uuid);

        const certs = store.loadCerts(this.api.user.storagePath(), conf.host);
        if (!certs || !certs.paired) {
          this.log.error(`[${name}] Pas encore appairé : ouvre les réglages du plugin et clique sur « Appairer », ` +
            'puis redémarre Homebridge.');
          continue;
        }

        let accessory = this.cached.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(name, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        this.players.push(new PlayerSwitch(this, accessory, conf, name, certs));
      } catch (e) {
        this.log.error(`Player ${conf && conf.host} : ${e.message}`);
      }
    }

    try {
      const stale = [...this.cached.values()].filter((a) => !wanted.has(a.UUID));
      if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    } catch (e) {
      this.log.error(`Nettoyage des accessoires : ${e.message}`);
    }
  }
}

class PlayerSwitch {
  constructor(platform, accessory, conf, name, certs) {
    const { Service, Characteristic, HapStatusError, HAPStatus } = platform.api.hap;
    this.log = platform.log;
    this.name = name;
    this.hap = { Characteristic, HapStatusError, HAPStatus };
    this.debug = !!conf.debug;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Free')
      .setCharacteristic(Characteristic.Model, 'Freebox Player POP')
      .setCharacteristic(Characteristic.SerialNumber, conf.host)
      .setCharacteristic(Characteristic.FirmwareRevision, version);

    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, name);
    this.pending = null;   // { on, until } : commande envoyée, confirmation pas encore reçue
    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.currentTarget())
      .onSet((value) => this.setPower(!!value));

    const pairCmd = "réglages du plugin → « Appairer »";
    const storagePath = platform.api.user.storagePath();
    let alerted = false;   // une alerte d'identité par épisode, pas une par tentative

    this.remote = new AndroidTvRemote({ host: conf.host, certs, fingerprint: certs.serverFingerprint, version });
    this.remote.on('debug', (m) => this.debug && this.log.info(`[${name}] ${m}`));
    this.remote.on('connected', () => { alerted = false; this.log.info(`[${name}] Connecté au Player`); });
    this.remote.on('disconnected', () => this.log.warn(`[${name}] Connexion au Player perdue, reconnexion automatique`));
    this.remote.on('unpaired', () => this.log.error(`[${name}] Le Player refuse le certificat. Relance l'appairage : ${pairCmd}`));
    this.remote.on('fingerprint', (fp) => {
      try {
        store.saveCerts(storagePath, conf.host, { ...certs, serverFingerprint: fp });
        this.log.info(`[${name}] Identité du Player mémorisée (${fp.slice(0, 23)}…)`);
      } catch (e) {
        // Retenue en mémoire quand même ; on réessaiera au prochain démarrage.
        this.log.warn(`[${name}] Identité du Player non enregistrée sur le disque : ${e.message}`);
      }
    });
    this.remote.on('untrusted', (fp) => {
      if (alerted) return;
      alerted = true;
      this.log.error(`[${name}] ⚠ L'appareil sur ${conf.host} n'est pas le Player appairé ` +
        `(empreinte ${fp ? fp.slice(0, 23) + '…' : 'absente'}). Connexion refusée. ` +
        `Si le Player a été réinitialisé ou remplacé, refais l'appairage : ${pairCmd}`);
    });
    this.remote.on('power', (on) => {
      if (this.pending && this.pending.on === on) this.pending = null;
      this.log.info(`[${name}] ${on ? 'Allumé' : 'En veille'}`);
      this.service.updateCharacteristic(Characteristic.On, on);
    });
    this.remote.start();
  }

  /** État à montrer : la commande en cours si elle n'est pas encore confirmée. */
  currentTarget() {
    if (this.pending && Date.now() < this.pending.until) return this.pending.on;
    this.pending = null;
    return this.remote.power === true;
  }

  async setPower(on) {
    const { HapStatusError, HAPStatus } = this.hap;
    // KEYCODE_POWER bascule : ne l'envoyer que si l'état visé diffère
    // de l'état attendu, sinon deux appuis rapides s'annuleraient.
    if (this.currentTarget() === on) return;
    // Rien ne sert de répondre « ok » si le Player est injoignable : HomeKit
    // afficherait un faux état. On tente une reconnexion rapide d'abord.
    if (!(await this.remote.waitReady(8000))) {
      this.log.warn(`[${this.name}] Player injoignable, commande ${on ? 'allumer' : 'éteindre'} non envoyée`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (this.currentTarget() === on) return;   // l'état a pu arriver avec la reconnexion
    this.log.info(`[${this.name}] ${on ? 'Allumage' : 'Mise en veille'} demandé(e)`);
    try {
      this.remote.sendKey('KEYCODE_POWER');
    } catch (e) {
      this.log.warn(`[${this.name}] Commande non envoyée : ${e.message}`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.pending = { on, until: Date.now() + 15000 };
  }
}

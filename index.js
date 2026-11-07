'use strict';
// Plugin Homebridge : un accessoire HomeKit par Freebox Player POP.
//   - « television » : téléviseur HomeKit (allumage, télécommande du Centre de
//     contrôle, volume, sources = applis) ;
//   - « switch »     : simple interrupteur allumé / veille.
// L'état affiché est celui que le Player annonce lui-même.

const { AndroidTvRemote } = require('./lib/remote');
const store = require('./lib/store');
const { version } = require('./package.json');

const PLUGIN_NAME = 'homebridge-freebox-player-pop';
const PLATFORM_NAME = 'FreeboxPlayerPop';

/**
 * Sources proposées si la configuration n'en donne pas. Vérifié sur un Player
 * POP le 07/11/2026 : il accepte les liens https:// (confiés à l'appli),
 * refuse market://, intent: et android-app://. FreeTV (ex-Oqee,
 * net.oqee.androidtv) n'a pas de lien : c'est la 1re vignette de l'accueil,
 * juste sous la barre de menu où arrive la sélection après Accueil.
 * `packages` sert à reconnaître l'appli affichée.
 */
const DEFAULT_APPS = [
  // Accueil, ↓, OK (séquence trouvée par Alex) : 12 sur 12 sur un vrai Player,
  // depuis FreeTV, l'accueil, YouTube, Netflix et Disney+. Si une autre appli
  // s'ouvre quand même, le plugin le voit et recommence — voir runSequence().
  { name: 'FreeTV', link: 'keys:KEYCODE_HOME,KEYCODE_DPAD_DOWN,KEYCODE_DPAD_CENTER', packages: ['net.oqee.androidtv'] },
  { name: 'Accueil Free', link: 'key:KEYCODE_HOME', packages: ['net.oqee.launcher'] },
  { name: 'Netflix', link: 'https://www.netflix.com/browse', packages: ['com.netflix.ninja'] },
  { name: 'YouTube', link: 'https://www.youtube.com', packages: ['com.google.android.youtube.tv'] },
  { name: 'Prime Video', link: 'https://app.primevideo.com', packages: ['com.amazon.amazonvideo.livingroom'] },
  { name: 'Disney+', link: 'https://www.disneyplus.com', packages: ['com.disney.disneyplus'] },
];
const MAX_APPS = 30;

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
        if (!conf || !conf.host) {
          this.log.error(`Player « ${(conf && conf.name) || '?'} » ignoré : adresse IP manquante. Renseigne ` +
            '« Adresse IP du Player » dans la liste des réglages du plugin (ou refais l\'appairage, qui la remplit).');
          continue;
        }
        const name = conf.name || 'Freebox Player';
        // Sans réglage explicite, on garde l'interrupteur des versions 0.1/0.2
        // pour ne pas casser les automatisations existantes.
        const type = conf.accessoryType === 'television' ? 'television' : 'switch';
        const switchUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${conf.host}`);
        if (type === 'switch') wanted.add(switchUuid);

        const certs = store.loadCerts(this.api.user.storagePath(), conf.host);
        if (!certs || !certs.paired) {
          this.log.error(`[${name}] Pas encore appairé : ouvre les réglages du plugin et clique sur « Appairer », ` +
            'puis redémarre Homebridge.');
          continue;
        }

        if (type === 'television') {
          this.players.push(new PlayerTelevision(this, conf, name, certs));
        } else {
          let accessory = this.cached.get(switchUuid);
          if (!accessory) {
            accessory = new this.api.platformAccessory(name, switchUuid);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
          this.players.push(new PlayerSwitch(this, accessory, conf, name, certs));
        }
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

/** Connexion au Player, état allumé/veille et commande d'alimentation. */
class PlayerBase {
  constructor(platform, conf, name, certs) {
    const { HapStatusError, HAPStatus } = platform.api.hap;
    this.platform = platform;
    this.log = platform.log;
    this.name = name;
    this.conf = conf;
    this.certs = certs;
    this.hapError = () => new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.debug = !!conf.debug;
    this.pending = null;   // { on, until } : commande envoyée, confirmation pas encore reçue
    this.remote = new AndroidTvRemote({ host: conf.host, certs, fingerprint: certs.serverFingerprint, version });
  }

  setAccessoryInfo(accessory) {
    const { Service, Characteristic } = this.platform.api.hap;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Free')
      .setCharacteristic(Characteristic.Model, 'Freebox Player POP')
      .setCharacteristic(Characteristic.SerialNumber, this.conf.host)
      .setCharacteristic(Characteristic.FirmwareRevision, version);
  }

  /** Branche les événements du Player puis démarre la connexion. */
  start() {
    const { name, conf, certs } = this;
    const pairHint = "réglages du plugin → « Appairer »";
    const storagePath = this.platform.api.user.storagePath();
    let alerted = false;   // une alerte d'identité par épisode, pas une par tentative

    this.remote.on('debug', (m) => this.debug && this.log.info(`[${name}] ${m}`));
    this.remote.on('connected', () => { alerted = false; this.log.info(`[${name}] Connecté au Player`); });
    this.remote.on('disconnected', () => this.log.warn(`[${name}] Connexion au Player perdue, reconnexion automatique`));
    let unpairedLogged = false;
    this.remote.on('unpaired', () => {
      if (unpairedLogged) return;   // une fois par démarrage, pas à chaque tentative
      unpairedLogged = true;
      this.log.error(`[${name}] Le Player refuse le certificat de Homebridge. Le Player POP ne garde qu'UN appareil ` +
        'appairé : si un autre appareil a été appairé depuis (appli Google TV du téléphone, autre Homebridge…), ' +
        `il a remplacé celui-ci. Refais l'appairage (${pairHint}), puis redémarre ce pont.`);
    });
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
        `Si le Player a été réinitialisé ou remplacé, refais l'appairage : ${pairHint}`);
    });
    this.remote.on('power', (on) => {
      if (this.pending && this.pending.on === on) this.pending = null;
      this.log.info(`[${name}] ${on ? 'Allumé' : 'En veille'}`);
      this.onPower(on);
    });
    this.remote.on('rejected', (what) => {
      this.log.warn(`[${name}] Le Player a refusé : ${what}. Vérifie le lien de cette source dans les réglages.`);
    });
    this.remote.on('app', (pkg) => {
      if (this.debug) this.log.info(`[${name}] Appli au premier plan : ${pkg}`);
      this.onApp(pkg);
    });
    this.remote.start();
  }

  onPower() {}
  onApp() {}

  /** État à montrer : la commande en cours si elle n'est pas encore confirmée. */
  currentTarget() {
    if (this.pending && Date.now() < this.pending.until) return this.pending.on;
    this.pending = null;
    return this.remote.power === true;
  }

  /** Attend une connexion prête, sinon « Pas de réponse » dans HomeKit. */
  async ensureReady(action) {
    if (!(await this.remote.waitReady(8000))) {
      this.log.warn(`[${this.name}] Player injoignable, « ${action} » non envoyé`);
      throw this.hapError();
    }
  }

  async setPower(on) {
    // KEYCODE_POWER bascule : ne l'envoyer que si l'état visé diffère
    // de l'état attendu, sinon deux appuis rapides s'annuleraient.
    if (this.currentTarget() === on) return;
    await this.ensureReady(on ? 'allumer' : 'éteindre');
    if (this.currentTarget() === on) return;   // l'état a pu arriver avec la reconnexion
    this.log.info(`[${this.name}] ${on ? 'Allumage' : 'Mise en veille'} demandé(e)`);
    this.sendKey('KEYCODE_POWER');
    this.pending = { on, until: Date.now() + 15000 };
  }

  sendKey(keyName) {
    try {
      this.remote.sendKey(keyName);
    } catch (e) {
      this.log.warn(`[${this.name}] Touche ${keyName} non envoyée : ${e.message}`);
      throw this.hapError();
    }
  }

  /** Attend que le Player annonce l'état voulu (au plus `ms`). */
  waitPower(on, ms) {
    if (this.remote.power === on) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); this.remote.off('power', listener); resolve(v); };
      const listener = (p) => { if (p === on) done(true); };
      const t = setTimeout(() => done(false), ms);
      this.remote.on('power', listener);
    });
  }
}

/** Interrupteur simple (comportement des versions 0.1 et 0.2). */
class PlayerSwitch extends PlayerBase {
  constructor(platform, accessory, conf, name, certs) {
    super(platform, conf, name, certs);
    const { Service, Characteristic } = platform.api.hap;
    this.setAccessoryInfo(accessory);
    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, name);
    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.currentTarget())
      .onSet((value) => this.setPower(!!value));
    this.start();
  }

  onPower(on) {
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, on);
  }
}

/** Téléviseur HomeKit : alimentation, télécommande, volume, sources. */
class PlayerTelevision extends PlayerBase {
  constructor(platform, conf, name, certs) {
    super(platform, conf, name, certs);
    const { api } = platform;
    const { Service, Characteristic, Categories } = api.hap;
    const C = Characteristic;

    const uuid = api.hap.uuid.generate(`${PLUGIN_NAME}:tv:${conf.host}`);
    const accessory = new api.platformAccessory(name, uuid, Categories.TELEVISION);
    this.setAccessoryInfo(accessory);

    const tv = accessory.addService(Service.Television, name);
    this.tv = tv;
    tv.setCharacteristic(C.ConfiguredName, name);
    tv.setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    tv.getCharacteristic(C.Active)
      .onGet(() => (this.currentTarget() ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet((v) => this.setPower(v === C.Active.ACTIVE));

    // Télécommande du Centre de contrôle de l'iPhone.
    const KEYS = {
      [C.RemoteKey.ARROW_UP]: 'KEYCODE_DPAD_UP',
      [C.RemoteKey.ARROW_DOWN]: 'KEYCODE_DPAD_DOWN',
      [C.RemoteKey.ARROW_LEFT]: 'KEYCODE_DPAD_LEFT',
      [C.RemoteKey.ARROW_RIGHT]: 'KEYCODE_DPAD_RIGHT',
      [C.RemoteKey.SELECT]: 'KEYCODE_DPAD_CENTER',
      [C.RemoteKey.BACK]: 'KEYCODE_BACK',
      [C.RemoteKey.EXIT]: 'KEYCODE_HOME',
      [C.RemoteKey.PLAY_PAUSE]: 'KEYCODE_MEDIA_PLAY_PAUSE',
      [C.RemoteKey.INFORMATION]: 'KEYCODE_INFO',
      [C.RemoteKey.REWIND]: 'KEYCODE_MEDIA_REWIND',
      [C.RemoteKey.FAST_FORWARD]: 'KEYCODE_MEDIA_FAST_FORWARD',
      [C.RemoteKey.NEXT_TRACK]: 'KEYCODE_MEDIA_NEXT',
      [C.RemoteKey.PREVIOUS_TRACK]: 'KEYCODE_MEDIA_PREVIOUS',
    };
    tv.getCharacteristic(C.RemoteKey).onSet(async (v) => {
      const key = KEYS[v];
      if (!key) return;
      await this.ensureReady('télécommande');
      this.sendKey(key);
    });
    tv.getCharacteristic(C.PowerModeSelection).onSet(async () => {
      await this.ensureReady('réglages');
      this.sendKey('KEYCODE_SETTINGS');
    });

    // Volume : boutons latéraux de l'iPhone quand la télécommande est ouverte.
    const speaker = accessory.addService(Service.TelevisionSpeaker, `${name} son`, 'speaker');
    speaker.setCharacteristic(C.Active, C.Active.ACTIVE);
    speaker.setCharacteristic(C.VolumeControlType, C.VolumeControlType.RELATIVE);
    speaker.getCharacteristic(C.Mute)
      .onGet(() => false)   // le Player n'annonce pas l'état muet : bascule simple
      .onSet(async () => { await this.ensureReady('muet'); this.sendKey('KEYCODE_VOLUME_MUTE'); });
    speaker.getCharacteristic(C.VolumeSelector).onSet(async (v) => {
      await this.ensureReady('volume');
      this.sendKey(v === C.VolumeSelector.INCREMENT ? 'KEYCODE_VOLUME_UP' : 'KEYCODE_VOLUME_DOWN');
    });
    tv.addLinkedService(speaker);

    // Sources = applis du Player.
    this.apps = sanitizeApps(conf.apps, this.log, name);
    this.apps.forEach((app, i) => {
      const input = accessory.addService(Service.InputSource, app.name, `app-${i}`);
      input
        .setCharacteristic(C.Identifier, i + 1)
        .setCharacteristic(C.ConfiguredName, app.name)
        .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
        .setCharacteristic(C.InputSourceType, C.InputSourceType.APPLICATION)
        .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
      tv.addLinkedService(input);
    });
    this.activeIdentifier = this.apps.length ? 1 : 0;
    tv.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.activeIdentifier)
      .onSet((id) => this.launch(id));

    // Un téléviseur doit être publié à part (exigence HomeKit) : il s'ajoute
    // dans l'app Maison avec le code de Homebridge.
    api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.start();
  }

  onPower(on) {
    const C = this.platform.api.hap.Characteristic;
    this.tv.updateCharacteristic(C.Active, on ? C.Active.ACTIVE : C.Active.INACTIVE);
  }

  onApp(pkg) {
    const i = this.apps.findIndex((a) => a.packages.includes(pkg));
    if (i < 0) return;
    this.activeIdentifier = i + 1;
    this.tv.updateCharacteristic(this.platform.api.hap.Characteristic.ActiveIdentifier, this.activeIdentifier);
  }

  async launch(id) {
    const app = this.apps[id - 1];
    if (!app) return;
    await this.ensureReady(`ouvrir ${app.name}`);
    if (this.remote.power !== true) {
      // Choisir une source sur un Player en veille : on l'allume d'abord.
      await this.setPower(true);
      if (!(await this.waitPower(true, 10000))) throw this.hapError();
    }
    this.activeIdentifier = id;
    if (!app.link.startsWith('keys:')) {
      this.log.info(`[${this.name}] Ouverture de ${app.name}`);
      try { await this.remote.launchApp(app.link); } catch (e) {
        this.log.warn(`[${this.name}] ${app.name} non ouvert : ${e.message}`);
        throw this.hapError();
      }
      return;
    }
    // Enchaînement de touches (plusieurs secondes) : HomeKit est servi tout de
    // suite, la navigation continue en arrière-plan et se corrige toute seule.
    this.runSequence(app).catch((e) => this.log.warn(`[${this.name}] ${app.name} non ouvert : ${e.message}`));
  }

  /**
   * Joue la séquence de touches puis vérifie l'appli arrivée au premier plan ;
   * si ce n'est pas la bonne (navigation déviée), recommence (3 essais).
   */
  async runSequence(app) {
    const token = (this.sequenceToken = (this.sequenceToken || 0) + 1);   // une nouvelle source annule l'ancienne
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (token !== this.sequenceToken) return;
      this.log.info(`[${this.name}] Ouverture de ${app.name}${attempt > 1 ? ` (essai ${attempt})` : ''}`);
      await this.remote.launchApp(app.link);
      if (!app.packages.length || await this.remote.waitForApp(app.packages, 3000)) return;
    }
    this.log.warn(`[${this.name}] ${app.name} : arrivé sur ${this.remote.currentApp} au lieu de ${app.packages.join(' / ')} ` +
      'après 3 essais. La disposition de l\'écran d\'accueil a peut-être changé : ajuste le lien de cette source.');
  }
}

const PACKAGE_RE = /^([A-Za-z][\w-]*\.)+[A-Za-z][\w-]*$/;
const LINK_RE = /^(https?:\/\/[^\s]{3,500}|key:KEYCODE_[A-Z0-9_]+|keys:KEYCODE_[A-Z0-9_]+(,KEYCODE_[A-Z0-9_]+){0,9}|([A-Za-z][\w-]*\.)+[A-Za-z][\w-]*)$/;
const { KeyCode } = require('./lib/protocol');
/** Toutes les touches citées par un lien key:/keys: existent-elles ? */
const keysKnown = (link) => !/^keys?:/.test(link) || link.replace(/^keys?:/, '').split(',').every((k) => KeyCode[k] !== undefined);

/**
 * Sources de la configuration, validées ; liste par défaut si absente.
 * Chaque source : { name, link, package? } — `link` ouvre la source,
 * `package` (un ou plusieurs, séparés par des virgules) la reconnaît.
 */
function sanitizeApps(apps, log, name) {
  if (!Array.isArray(apps) || !apps.length) return DEFAULT_APPS;
  const ok = [];
  for (const a of apps) {
    const appName = a && typeof a.name === 'string' ? a.name.trim().slice(0, 64) : '';
    const pkgText = a && typeof a.package === 'string' ? a.package : '';
    const packages = pkgText.split(',').map((s) => s.trim()).filter(Boolean);
    // Sans lien, on tente le nom de paquet (marche sur d'autres Android TV, pas sur le POP).
    const link = a && typeof a.link === 'string' && a.link.trim() ? a.link.trim() : packages[0] || '';
    if (!appName || !LINK_RE.test(link) || !keysKnown(link) || !packages.every((p) => PACKAGE_RE.test(p))) {
      log.warn(`[${name}] Source ignorée (nom, lien ou paquet invalide) : ${JSON.stringify(a)}`);
      continue;
    }
    ok.push({ name: appName, link, packages });
    if (ok.length >= MAX_APPS) break;
  }
  return ok;
}

module.exports.sanitizeApps = sanitizeApps;
module.exports.DEFAULT_APPS = DEFAULT_APPS;

# homebridge-freebox-player-pop

[![npm](https://img.shields.io/npm/v/homebridge-freebox-player-pop)](https://www.npmjs.com/package/homebridge-freebox-player-pop)
[![Tests](https://github.com/noom60/homebridge-freebox-player-pop/actions/workflows/publish.yml/badge.svg)](https://github.com/noom60/homebridge-freebox-player-pop/actions/workflows/publish.yml)

Plugin [Homebridge](https://homebridge.io) qui fait d'un **Freebox Player POP**
un **téléviseur HomeKit** :

- **allumage / mise en veille**, avec l'état réel annoncé par le Player (si on
  l'éteint avec la vraie télécommande, HomeKit suit) ;
- **télécommande** du Centre de contrôle de l'iPhone (flèches, OK, retour,
  accueil, lecture/pause, avance/retour rapide) ;
- **volume** et **muet** (boutons latéraux de l'iPhone quand la télécommande est
  ouverte) ;
- **sources** : FreeTV (liste des chaînes), Accueil Free, Netflix, YouTube,
  Prime Video, Disney+, ou toute appli
  ajoutée dans les réglages — l'app Maison affiche l'appli réellement ouverte.

Un mode **interrupteur** simple (allumé / veille) reste disponible.

Compatible Homebridge 1.8+ et 2.x, Node.js 22, 24 et 26.

> **English summary** — Homebridge plugin exposing a Freebox Player POP (the
> Android TV set-top box of French ISP Free) as a HomeKit **Television**: power
> with real state, Control Center remote keys, volume/mute, and app inputs
> (launched via https app links, which the POP accepts; it rejects market://
> links), with the foreground app reflected as the active input. A plain switch
> mode is also available. It speaks the Android TV Remote v2 protocol
> directly (the Freebox OS API cannot control the POP). Pairing is done from the
> plugin settings screen: click **Pair**, type the code shown on the TV, save,
> restart. No open ports, no analytics, Player identity pinned by certificate
> fingerprint, files kept in the Homebridge storage directory.

## Installation

1. Dans l'interface Homebridge, onglet **Plugins**, chercher
   **`homebridge-freebox-player-pop`** et l'installer.
2. Ouvrir les **réglages du plugin**. Allumer le Player (image à l'écran), saisir
   son adresse IP et cliquer sur **Appairer**, puis taper le code à 6 caractères
   affiché sur la TV. Une faute de frappe se corrige sans tout recommencer. Le
   Player est alors **ajouté tout seul à la liste**, avec son IP, en mode
   Téléviseur, et la configuration est enregistrée.
3. Dans la liste, ajuster si besoin le nom ou le type (**Téléviseur** ou
   **Interrupteur**). En JSON :

   ```json
   {
     "platform": "FreeboxPlayerPop",
     "players": [
       { "name": "Freebox Player", "host": "192.168.1.XX", "accessoryType": "television" }
     ]
   }
   ```

4. Redémarrer Homebridge. Le journal affiche `Connecté au Player`, puis
   `Allumé` ou `En veille`.
5. **Mode Téléviseur seulement** : HomeKit impose qu'un téléviseur soit ajouté à
   part. Dans l'app Maison : **+ → Ajouter un accessoire → Autres options**,
   choisir le Player, et saisir le **« Setup Code »** indiqué dans le journal
   Homebridge (ligne « Please add [Freebox Player …] manually in Home app »). Si
   le plugin tourne dans un pont séparé (*child bridge*), c'est le code de ce
   pont, pas celui de la page d'accueil.

> ⚠️ **Le Player POP ne garde qu'un seul appareil appairé.** Appairer un autre
> appareil (appli Google TV du téléphone, autre Homebridge…) efface l'appairage de
> Homebridge : le journal affiche alors « Le Player refuse le certificat ».
> Refaire l'appairage dans les réglages, puis redémarrer le pont.

Sans `accessoryType`, un Player configuré avant la 0.3.0 reste un interrupteur.
Changer de type crée un nouvel accessoire dans l'app Maison : les automatisations
qui utilisaient l'ancien sont à refaire.

### Sources

Chaque source a un **lien d'ouverture** et, facultatif, le **paquet Android** qui
permet de reconnaître l'appli affichée (plusieurs paquets séparés par des
virgules). Liens vérifiés sur un Player POP le 07/11/2026 :

| Source | Lien | Paquet |
|---|---|---|
| FreeTV | `keys:KEYCODE_HOME,KEYCODE_DPAD_DOWN,KEYCODE_DPAD_CENTER` | `net.oqee.androidtv` |
| Accueil Free | `key:KEYCODE_HOME` | `net.oqee.launcher` |
| Netflix | `https://www.netflix.com/browse` | `com.netflix.ninja` |
| YouTube | `https://www.youtube.com` | `com.google.android.youtube.tv` |
| Prime Video | `https://app.primevideo.com` | `com.amazon.amazonvideo.livingroom` |
| Disney+ | `https://www.disneyplus.com` | `com.disney.disneyplus` |

**FreeTV** (ex-Oqee) n'a pas de lien : c'est la 1re vignette de l'accueil Free,
juste sous la barre de menu. La source rejoue donc Accueil, ↓, OK (12 sur 12 sur
un vrai Player, quel que soit le point de départ), vérifie que FreeTV est bien au
premier plan et recommence sinon (3 essais). Un lien `keys:` accepte jusqu'à
10 touches séparées par des virgules.

Le Player POP **refuse** les liens `market://`, `intent:` et `android-app://` (il répond par une
erreur et coupe la connexion ; le journal l'indique). Pour une autre appli,
utiliser son adresse web `https://…` : Android la confie à l'appli installée.
Laisser la liste vide revient à la liste ci-dessus.

**Une source n'apparaît pas dans l'app Maison ?** L'app Maison masque d'office
les sources ajoutées après l'ajout du téléviseur. Ouvrir les réglages du
téléviseur → **Entrées**, et activer la source. Ce choix (afficher / masquer) est
mémorisé par le plugin dans `<stockage Homebridge>/freebox-player-pop/<IP>-sources.json`.

**Mise à jour** : bouton « Mettre à jour » de l'onglet Plugins. L'appairage est
conservé.

**Secours sans interface** : `node <dossier du plugin>/bin/fbxpop-pair.js <IP>`
dans le terminal Homebridge fait le même appairage.

## Comment il parle au Player

Le Player POP tourne sous Android TV. L'API Freebox OS ne le pilote pas
(`/api/v8/player/` le liste avec `api_available: false`). Le plugin utilise donc
le **protocole télécommande Android TV v2**, celui de l'appli Google TV :

- port **6467** : appairage, une seule fois ;
- port **6466** : connexion permanente en TLS avec le certificat client appairé.
  Le Player y annonce son état (`remoteStart.started`) et l'appli au premier
  plan, et reçoit les touches (`remoteKeyInject`) et les ouvertures d'appli
  (`remoteAppLinkLaunchRequest`).

### Pourquoi pas homebridge-androidtv ?

Avec le Player POP, `homebridge-androidtv` tombe dans une boucle
`secureConnect → timeout → Connection closed false`. Sa bibliothèque n'accepte
une trame que si `premier octet === longueur restante`, alors que le Player
envoie plusieurs messages **collés dans le même paquet** juste après la
connexion : rien n'est lu, le Player n'obtient pas de réponse, la connexion
expire au bout de 10 s, et ainsi de suite. Ici, `FrameReader` découpe les trames
correctement (longueurs varint, messages collés ou coupés).

## Comportement

- **Reconnexion** : nouvel essai après 2, 5, 10, 30 puis 60 s au plus.
- **Player injoignable** : reconnexion rapide tentée pendant 8 s, sinon HomeKit
  affiche « Pas de réponse » plutôt qu'un faux état.
- **Appuis rapides** : `KEYCODE_POWER` bascule l'état ; la commande en cours est
  mémorisée 15 s pour qu'un deuxième appui identique ne l'annule pas.
- **Journal détaillé** : option `debug`.

## Sécurité

- Le plugin **n'ouvre aucun port** : il se connecte seulement au Player.
- **Identité du Player vérifiée** : l'empreinte SHA-256 de son certificat est
  mémorisée à l'appairage (ou à la première connexion pour un appairage antérieur
  à la 0.1.1). Un autre appareil sur la même IP est refusé avant tout échange.
- **Messages malformés ou démesurés** (> 64 Ko) : connexion coupée, sans faire
  planter Homebridge.
- **Journal** : jamais le texte saisi sur la TV (recherches, identifiants).
- **Dépendances figées et embarquées** dans le paquet (`bundleDependencies`).
  Le paquet npm est publié par GitHub Actions avec
  [provenance](https://docs.npmjs.com/generating-provenance-statements), et
  chaque version doit être approuvée par le mainteneur (2FA) avant d'être en ligne.
- Le certificat client est rangé dans
  `<stockage Homebridge>/freebox-player-pop/<IP>.json` (droits 600). Il permet de
  piloter le Player comme une télécommande : ne pas partager les sauvegardes
  Homebridge.

## Limites connues

- Comportement après une très longue veille non encore documenté : si le Player
  coupe son service télécommande, « Allumer » répond « Pas de réponse » et le
  journal l'indique.
- Après une réinitialisation du Player, refaire l'appairage (le journal le
  signale : « n'est pas le Player appairé »).

## Développement

```sh
npm ci
npm test          # 22 tests : faux Player TLS local (télécommande et appairage),
                  # serveur et logique de l'écran de réglages
```

Publier une version :

1. mettre à jour `version` dans `package.json`, pousser ;
2. créer une Release GitHub `vX.Y.Z` : le workflow teste, puis met la version
   **en attente** sur npm (`npm stage publish`, avec provenance) ;
3. l'approuver avec la 2FA du mainteneur, sur npmjs.com ou par
   `npm stage list` puis `npm stage approve <id>`.

Rien n'est installable par les utilisateurs avant l'étape 3.

## Fichiers

- `index.js` : plateforme Homebridge et interrupteur.
- `lib/remote.js` : connexion télécommande, empreinte, reconnexion, état.
- `lib/pairing.js` : appairage.
- `lib/protocol.js` : protobuf, trames, certificat, secret d'appairage, journal.
- `lib/store.js` : certificat par Player dans le stockage Homebridge.
- `lib/pairing-session.js` : appairage pas à pas (écran de réglages).
- `homebridge-ui/` : écran de réglages (bouton « Appairer »), via
  `@homebridge/plugin-ui-utils`.
- `bin/fbxpop-pair.js` : appairage en ligne de commande (secours).
- `lib/proto/*.proto` : repris de [androidtv-remote](https://github.com/louis49/androidtv-remote) (louis49, ISC).

## Licence

ISC — © 2026 Alexandre Clabault.

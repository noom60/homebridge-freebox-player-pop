# homebridge-freebox-player-pop

[![npm](https://img.shields.io/npm/v/homebridge-freebox-player-pop)](https://www.npmjs.com/package/homebridge-freebox-player-pop)
[![Tests](https://github.com/noom60/homebridge-freebox-player-pop/actions/workflows/publish.yml/badge.svg)](https://github.com/noom60/homebridge-freebox-player-pop/actions/workflows/publish.yml)

Plugin [Homebridge](https://homebridge.io) qui ajoute un **interrupteur HomeKit**
pour allumer et mettre en veille un **Freebox Player POP**.
L'état affiché est celui que le Player annonce lui-même : si on l'éteint avec la
vraie télécommande, HomeKit suit.

Compatible Homebridge 1.8+ et 2.x, Node.js 22, 24 et 26.

> **English summary** — Homebridge plugin exposing a HomeKit switch that turns a
> Freebox Player POP (the Android TV set-top box of French ISP Free) on and off,
> and reflects its real state. It speaks the Android TV Remote v2 protocol
> directly (the Freebox OS API cannot control the POP). Pairing is done from the
> plugin settings screen: click **Pair**, type the code shown on the TV, save,
> restart. No open ports, no analytics, Player identity pinned by certificate
> fingerprint, files kept in the Homebridge storage directory.

## Installation

1. Dans l'interface Homebridge, onglet **Plugins**, chercher
   **`homebridge-freebox-player-pop`** et l'installer.
2. Ouvrir les **réglages du plugin**. Allumer le Player (image à l'écran), saisir
   son adresse IP et cliquer sur **Appairer**, puis taper le code à 6 caractères
   affiché sur la TV. Une faute de frappe se corrige sans tout recommencer.
3. Dans la liste en dessous, ajouter le Player (nom + IP), puis **Enregistrer**.
   En JSON, ça donne :

   ```json
   {
     "platform": "FreeboxPlayerPop",
     "players": [ { "name": "Freebox Player", "host": "192.168.1.XX" } ]
   }
   ```

4. Redémarrer Homebridge. Le journal affiche `Identité du Player mémorisée`,
   `Connecté au Player`, puis `Allumé` ou `En veille`.

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
  Le Player y annonce son état (`remoteStart.started`) et reçoit la touche
  `KEYCODE_POWER`.

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
npm test          # 14 tests : faux Player TLS local (télécommande et appairage),
                  # serveur de l'écran de réglages piloté comme par Homebridge
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

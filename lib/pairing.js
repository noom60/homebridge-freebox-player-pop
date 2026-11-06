'use strict';
// Appairage (port 6467) : le Player affiche un code à 6 caractères, on le
// renvoie haché avec les deux certificats. Une fois fait, le Player accepte
// notre certificat sur le port télécommande (6466).

const tls = require('node:tls');
const P = require('./protocol');

const PAIRING_PORT = 6467;

/**
 * @param {object} o
 * @param {string} o.host
 * @param {{cert:string,key:string}} o.certs
 * @param {() => Promise<string>} o.askCode  appelé quand le code s'affiche à l'écran
 * @param {(msg:string) => void} [o.log]
 * @returns {Promise<{fingerprint: string|null}>} empreinte du certificat du Player
 */
function pair({ host, certs, askCode, log = () => {}, clientName = 'Homebridge' }) {
  return new Promise((resolve, reject) => {
    const reader = new P.FrameReader();
    let done = false;
    let fingerprint = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      err ? reject(err) : resolve({ fingerprint });
    };
    const send = (payload) => socket.write(P.encode(P.PairingMessage, {
      protocolVersion: 2, status: P.PairingStatus.STATUS_OK, ...payload,
    }));
    const hexEncoding = { type: P.EncodingType.ENCODING_TYPE_HEXADECIMAL, symbolLength: 6 };

    const socket = tls.connect({
      host, port: PAIRING_PORT, cert: certs.cert, key: certs.key, rejectUnauthorized: false,
    });
    socket.setTimeout(120000, () => finish(new Error("Délai dépassé pendant l'appairage")));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(new Error("Le Player a fermé la connexion d'appairage")));

    socket.on('secureConnect', () => {
      // Empreinte du Player, mémorisée pour refuser ensuite tout autre appareil.
      fingerprint = P.fingerprintOf(socket.getPeerCertificate());
      log('Connecté au port d\'appairage, demande envoyée');
      send({ pairingRequest: { serviceName: 'homebridge-freebox-player-pop', clientName } });
    });

    socket.on('data', async (chunk) => {
      let frames;
      try { frames = reader.push(chunk); } catch (e) { return finish(e); }
      for (const frame of frames) {
        let msg;
        try { msg = P.PairingMessage.decode(frame); } catch (e) { return finish(new Error(`Message illisible : ${e.message}`)); }
        if (msg.status !== P.PairingStatus.STATUS_OK) {
          const label = msg.status === P.PairingStatus.STATUS_BAD_SECRET ? 'code refusé par le Player' : `statut ${msg.status}`;
          return finish(new Error(`Appairage refusé (${label})`));
        }
        if (msg.pairingRequestAck) {
          send({ pairingOption: { preferredRole: P.RoleType.ROLE_TYPE_INPUT, inputEncodings: [hexEncoding] } });
        } else if (msg.pairingOption) {
          send({ pairingConfiguration: { clientRole: P.RoleType.ROLE_TYPE_INPUT, encoding: hexEncoding } });
        } else if (msg.pairingConfigurationAck) {
          try {
            const code = await askCode();
            const secret = P.pairingSecret(socket.getCertificate(), socket.getPeerCertificate(), code);
            send({ pairingSecret: { secret } });
          } catch (e) { return finish(e); }
        } else if (msg.pairingSecretAck) {
          log('Appairage réussi');
          return finish();
        }
      }
    });
  });
}

module.exports = { pair, PAIRING_PORT };

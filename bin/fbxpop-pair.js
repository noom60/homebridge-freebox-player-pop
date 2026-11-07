#!/usr/bin/env node
'use strict';
// Appairage en ligne de commande — solution de secours : l'appairage se fait
// normalement depuis l'écran de réglages du plugin dans Homebridge.
//   node bin/fbxpop-pair.js 192.168.1.37
// Options :      --storage <dossier>   (défaut : dossier de stockage Homebridge)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { pair } = require('../lib/pairing');
const store = require('../lib/store');

function defaultStorage() {
  if (process.env.UIX_STORAGE_PATH) return process.env.UIX_STORAGE_PATH;
  if (fs.existsSync('/var/lib/homebridge/config.json')) return '/var/lib/homebridge';
  return path.join(os.homedir(), '.homebridge');
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--storage');
  const storage = i >= 0 ? args.splice(i, 2)[1] : defaultStorage();
  const host = args[0];
  if (!host) {
    console.error('Usage : fbxpop-pair <IP du Player> [--storage <dossier Homebridge>]');
    process.exit(1);
  }

  const certs = store.loadOrCreateCerts(storage, host);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Connexion au Player ${host}… (il doit être allumé, image à l'écran)`);
  try {
    const { fingerprint } = await pair({
      host, certs,
      log: (m) => console.log(m),
      askCode: (lastError) => {
        if (lastError) console.log(`⚠ ${lastError}, réessaie.`);
        return rl.question('Code affiché sur la TV : ');
      },
    });
    const file = store.saveCerts(storage, host, { ...certs, paired: true, serverFingerprint: fingerprint });
    console.log(`Identité du Player mémorisée : ${fingerprint}`);
    console.log(`✅ Appairé. Certificat enregistré dans ${file}`);
    console.log('Redémarre Homebridge pour que le plugin l\'utilise.');
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();

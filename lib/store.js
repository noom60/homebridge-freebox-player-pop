'use strict';
// Certificat client par Player, rangé dans le dossier de stockage Homebridge.

const fs = require('node:fs');
const path = require('node:path');
const { generateCertificate } = require('./protocol');

const DIR = 'freebox-player-pop';

function certPath(storagePath, host) {
  return path.join(storagePath, DIR, `${host.replace(/[^\w.-]/g, '_')}.json`);
}

/** @returns {{cert:string,key:string,paired:boolean}|null} */
function loadCerts(storagePath, host) {
  try { return JSON.parse(fs.readFileSync(certPath(storagePath, host), 'utf8')); }
  catch { return null; }
}

function saveCerts(storagePath, host, data) {
  const file = certPath(storagePath, host);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
}

function loadOrCreateCerts(storagePath, host) {
  return loadCerts(storagePath, host) || { ...generateCertificate(), paired: false };
}

module.exports = { certPath, loadCerts, saveCerts, loadOrCreateCerts };

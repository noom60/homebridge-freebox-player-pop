'use strict';
// Logique de l'écran de réglages (homebridge-ui/public/index.html) exécutée
// avec une fausse API « homebridge », comme dans l'interface.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
const src = html.match(/async function addPlayerToConfig[\s\S]*?\n  }\n/)[0];

function load(initialConfig) {
  const calls = { saved: 0 };
  let config = JSON.parse(JSON.stringify(initialConfig));
  const homebridge = {
    getPluginConfig: async () => JSON.parse(JSON.stringify(config)),
    updatePluginConfig: async (c) => { config = c; return c; },
    savePluginConfig: async () => { calls.saved++; },
  };
  // eslint-disable-next-line no-new-func
  const addPlayerToConfig = new Function('homebridge', `${src}; return addPlayerToConfig;`)(homebridge);
  return { addPlayerToConfig, calls, config: () => config };
}

test("appairage : un Player sans IP (le cas réel) reçoit l'IP appairée", async () => {
  const ui = load([{ platform: 'FreeboxPlayerPop', players: [{ name: 'Freebox Player', accessoryType: 'television' }], _bridge: { port: 32623 } }]);
  assert.strictEqual(await ui.addPlayerToConfig('192.168.1.37'), true);
  assert.deepStrictEqual(ui.config()[0].players, [{ name: 'Freebox Player', accessoryType: 'television', host: '192.168.1.37' }]);
  assert.deepStrictEqual(ui.config()[0]._bridge, { port: 32623 }, 'le reste de la configuration est conservé');
  assert.strictEqual(ui.calls.saved, 1);
});

test('appairage : Player déjà présent avec cette IP → rien ne change', async () => {
  const ui = load([{ platform: 'FreeboxPlayerPop', players: [{ name: 'Salon', host: '192.168.1.37' }] }]);
  assert.strictEqual(await ui.addPlayerToConfig('192.168.1.37'), false);
  assert.strictEqual(ui.calls.saved, 0);
});

test('appairage : configuration vide → Player ajouté en mode téléviseur', async () => {
  const ui = load([]);
  assert.strictEqual(await ui.addPlayerToConfig('192.168.1.50'), true);
  assert.deepStrictEqual(ui.config(), [{ platform: 'FreeboxPlayerPop', players: [{ name: 'Freebox Player', host: '192.168.1.50', accessoryType: 'television' }] }]);
});

test('appairage : un 2e Player avec une autre IP est ajouté, le 1er intact', async () => {
  const ui = load([{ platform: 'FreeboxPlayerPop', players: [{ name: 'Salon', host: '192.168.1.37' }] }]);
  await ui.addPlayerToConfig('192.168.1.50');
  assert.deepStrictEqual(ui.config()[0].players.map((p) => p.host), ['192.168.1.37', '192.168.1.50']);
});

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
  assert.deepStrictEqual(ui.config(), [{ platform: 'FreeboxPlayerPop', name: 'Freebox Player POP', players: [{ name: 'Freebox Player', host: '192.168.1.50', accessoryType: 'television' }] }]);
});

test('ordre des sources : TLV HomeKit attendu', () => {
  const { displayOrderTlv } = require('../index');
  const buf = Buffer.from(displayOrderTlv([1, 2, 6]), 'base64');
  assert.deepStrictEqual([...buf], [1, 4, 1, 0, 0, 0, 0, 0, 1, 4, 2, 0, 0, 0, 0, 0, 1, 4, 6, 0, 0, 0]);
});

test('sources masquées : mémorisées par Player sur disque', () => {
  const store = require('../lib/store');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbxpop-'));
  assert.deepStrictEqual([...store.loadHiddenInputs(dir, '192.168.1.37')], []);
  store.saveHiddenInputs(dir, '192.168.1.37', new Set(['Disney+', 'Prime Video']));
  assert.deepStrictEqual([...store.loadHiddenInputs(dir, '192.168.1.37')].sort(), ['Disney+', 'Prime Video']);
  assert.deepStrictEqual([...store.loadHiddenInputs(dir, '192.168.1.50')], [], 'autre Player : indépendant');
  fs.writeFileSync(path.join(dir, 'freebox-player-pop', '192.168.1.37-sources.json'), '{pas du json');
  assert.deepStrictEqual([...store.loadHiddenInputs(dir, '192.168.1.37')], [], 'fichier abîmé : rien de masqué, pas de plantage');
});

test('appairage : un 2e Player avec une autre IP est ajouté, le 1er intact', async () => {
  const ui = load([{ platform: 'FreeboxPlayerPop', players: [{ name: 'Salon', host: '192.168.1.37' }] }]);
  await ui.addPlayerToConfig('192.168.1.50');
  assert.deepStrictEqual(ui.config()[0].players.map((p) => p.host), ['192.168.1.37', '192.168.1.50']);
});

test('config.schema.json : conforme aux contrôles Homebridge (required en tableau, name en tête)', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8')).schema;
  assert.strictEqual(schema.properties.name.type, 'string');
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) {
        assert.ok(typeof v.required !== 'boolean', `"required" booléen sur ${k}`);
        walk(v);
      }
      if (node.required) assert.ok(Array.isArray(node.required));
    }
    if (node.items) walk(node.items);
  };
  walk(schema);
  assert.deepStrictEqual(schema.properties.players.items.required, ['name', 'host']);
});

test('type d\'accessoire : même défaut (téléviseur) dans le code que dans le formulaire', () => {
  const { accessoryTypeOf } = require('../index');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8')).schema;
  const formDefault = schema.properties.players.items.properties.accessoryType.default;
  assert.strictEqual(accessoryTypeOf({ host: '192.168.1.37' }), formDefault);
  assert.strictEqual(accessoryTypeOf({ accessoryType: 'television' }), 'television');
  assert.strictEqual(accessoryTypeOf({ accessoryType: 'switch' }), 'switch');
  assert.strictEqual(accessoryTypeOf({ accessoryType: 'n importe quoi' }), 'television');
});

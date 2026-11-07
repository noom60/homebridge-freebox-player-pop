'use strict';
// Serveur de l'écran de réglages (lancé par l'interface Homebridge) :
// appairage du Player sans passer par le terminal.

const { PairingSession } = require('../lib/pairing-session');

(async () => {
  // @homebridge/plugin-ui-utils est un module ESM : import dynamique depuis CommonJS.
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class FreeboxPlayerPopUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      const session = new PairingSession({ storagePath: this.homebridgeStoragePath });
      const guard = (fn) => async (body) => {
        try { return await fn(body || {}); }
        catch (e) { throw new RequestError(e.message, { message: e.message }); }
      };

      this.onRequest('/status', guard(({ host }) => session.status(host)));
      this.onRequest('/pair/start', guard(({ host }) => session.start(host)));
      this.onRequest('/pair/code', guard(({ code }) => session.submitCode(code)));
      this.onRequest('/pair/cancel', guard(() => { session.cancel(); return { status: 'cancelled' }; }));

      this.ready();
    }
  }

  return new FreeboxPlayerPopUiServer();
})().catch((e) => {
  console.error('[homebridge-freebox-player-pop] écran de réglages :', e);
  process.exit(1);
});

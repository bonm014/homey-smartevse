'use strict';
const Homey = require('homey');

module.exports = class SmartEVSEDriver extends Homey.Driver {
  async onInit() {
    this.log('SmartEVSEDriver init');
  }

  async onPair(session) {
    session.setHandler('validate_host', async ({ host }) => {
      host = String(host || '').trim();
      if (!host) throw new Error('Host ontbreekt');

      const url = `http://${host}/settings`;
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`SmartEVSE niet bereikbaar (HTTP ${res.status})`);

      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('Ongeldige response van SmartEVSE');
      if (!('serialnr' in data) && !('version' in data)) throw new Error('Geen SmartEVSE /settings response');

      return {
        serialnr: data.serialnr ?? null,
        version: data.version ?? null,
        name: data.serialnr ? `SmartEVSE ${data.serialnr}` : 'SmartEVSE'
      };
    });
  }
};

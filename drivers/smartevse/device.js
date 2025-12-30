'use strict';

const Homey = require('homey');

module.exports = class SmartEVSEDevice extends Homey.Device {
  async onInit() {
    this.log('SmartEVSEDevice init', this.getName());

    this._pollTimer = null;

    // triggers
    this._triggerChargingStarted = this.homey.flow.getDeviceTriggerCard('charging_started');
    this._triggerChargingStopped  = this.homey.flow.getDeviceTriggerCard('charging_stopped');
    this._triggerRfidScanned      = this.homey.flow.getDeviceTriggerCard('rfid_scanned');

    // state
    this._lastChargingState = null;
    this._lastRfid = null;

    // EV charger standard control (Energy dashboard)
    this.registerCapabilityListener('evcharger_charging', async (value) => {
      if (value) await this._unlockCharging();
      else await this._lockCharging();
      await this.pollOnceSafe();
    });

    // Custom controls
    this.registerCapabilityListener('charger_mode', async (value) => {
      const mode = this._enumToModeId(value);
      await this.apiSetMode(mode);
      await this.pollOnceSafe();
    });

    this.registerCapabilityListener('override_current_a', async (value) => {
      await this.apiSetOverrideCurrent(Number(value));
      await this.pollOnceSafe();
    });

    this.registerCapabilityListener('override_reset', async (value) => {
      if (!value) return;
      await this.apiResetOverrideCurrent();
      await this.setCapabilityValue('override_reset', false).catch(() => {});
      await this.pollOnceSafe();
    });

    await this._startPolling();
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('host') || changedKeys.includes('pollInterval')) {
      await this._startPolling();
    }
  }

  async onDeleted() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  // --- Mode mapping ---
  _modeIdToEnum(modeId) {
    switch (modeId) {
      case 0: return 'off';
      case 1: return 'normal';
      case 2: return 'solar';
      case 3: return 'smart';
      default: return null;
    }
  }

  _enumToModeId(value) {
    switch (value) {
      case 'off': return 0;
      case 'normal': return 1;
      case 'solar': return 2;
      case 'smart': return 3;
      default: throw new Error('Invalid charger_mode');
    }
  }

  // --- Charging state (custom) ---
  _stateToChargingState(data) {
    // SmartEVSE: state_id 2 = Charging.
    // All other state_id values (e.g. 0 Ready, 1 Connected/Waiting, 9 Charging Stopped) are NOT charging.
    const id = data?.evse?.state_id;
    if (Number.isInteger(id)) {
      if (id === 2) return 'charging';
      return 'idle';
    }

    const s = String(data?.evse?.state || '').toLowerCase();
    if (s.includes('complete') || s.includes('finished') || s.includes('done')) return 'finished';
    if (s.includes('charging')) return 'charging';
    return 'idle';
  }

  // --- Helpers: current/power/energy ---
  _normalizeCurrentA(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    // SmartEVSE often reports 0.1A units (e.g. 158 => 15.8A)
    if (v > 80) return v / 10;
    return v;
  }

  _extractTotalCurrentA(data) {
    const a = this._normalizeCurrentA(data?.currents?.TOTAL);
    if (typeof a === 'number') return a;
    const b = this._normalizeCurrentA(data?.phase_currents?.TOTAL);
    if (typeof b === 'number') return b;
    const c = this._normalizeCurrentA(data?.settings?.charge_current);
    if (typeof c === 'number') return c;
    return null;
  }

  _extractPowerW(data, totalA) {
    // Prefer meter power if available: ev_meter.import_active_power is typically kW (e.g. 3.6)
    const kw = data?.ev_meter?.import_active_power;
    if (typeof kw === 'number' && kw > 0) {
      // assume kW if small
      if (kw < 200) return Math.round(kw * 1000);
      return Math.round(kw);
    }

    // Fallback estimate from current
    if (typeof totalA !== 'number') return null;
    const v1 = Number(this.getSetting('voltageSingle') || 230);
    return Math.round(v1 * totalA);
  }

  _extractKwh(data) {
    const total = data?.ev_meter?.total_kwh;
    if (typeof total === 'number' && total >= 0) return total;

    const charged = data?.ev_meter?.charged_kwh;
    if (typeof charged === 'number' && charged >= 0) return charged;

    const imp = data?.ev_meter?.import_active_energy;
    if (typeof imp === 'number' && imp >= 0) return imp;

    const mm = data?.mains_meter?.import_active_energy;
    if (typeof mm === 'number' && mm >= 0) return mm;

    return 0;
  }

  // --- RFID whitelist (read-only display) ---
  _normalizeRfid(rfid) { return String(rfid || '').trim().toUpperCase(); }

  _parseWhitelist() {
    try {
      const txt = String(this.getSetting('rfidWhitelistJson') || '[]');
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(x => x && typeof x.rfid === 'string')
        .map(x => ({ rfid: this._normalizeRfid(x.rfid), name: typeof x.name === 'string' ? x.name : this._normalizeRfid(x.rfid) }));
    } catch (e) {
      this.error('Invalid RFID whitelist JSON', e);
      return [];
    }
  }

  _lookupRfid(rfid) {
    const key = this._normalizeRfid(rfid);
    if (!key) return null;
    return this._parseWhitelist().find(x => x.rfid === key) || null;
  }

  // --- Lock/unlock via EV charger switch ---
  async _lockCharging() { await this.apiSetMode(0); }

  async _unlockCharging() {
    const mode = Number(this.getSetting('unlockMode') ?? 3);
    const currentA = Number(this.getSetting('unlockCurrentA') ?? 0);
    await this.apiSetMode(mode);
    if (Number.isFinite(currentA) && currentA > 0) await this.apiSetOverrideCurrent(currentA);
    else await this.apiResetOverrideCurrent();
  }

  // --- REST helpers ---
  _baseUrl() {
    const host = (this.getSetting('host') || '').trim();
    if (!host) throw new Error('Missing setting: host');
    return `http://${host}`;
  }

  async _getJson(path) {
    const url = `${this._baseUrl()}${path}`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} GET ${path}`);
    return res.json();
  }

  async _post(path, query = {}) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      qs.append(k, String(v));
    });
    const url = `${this._baseUrl()}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} POST ${path}`);
    try { return await res.json(); } catch { return {}; }
  }

  // --- Public API (used by flow cards) ---
  async apiSetMode(mode) { await this._post('/settings', { mode }); }
  async apiSetOverrideCurrent(currentA) { await this._post('/settings', { override_current: Math.round(Number(currentA) * 10) }); }
  async apiResetOverrideCurrent() { await this._post('/settings', { disable_override_current: 1 }); }
  async apiReboot() { await this._post('/reboot'); }

  // --- Polling ---
  async pollOnceSafe() { try { await this._pollOnce(); } catch (err) { this.error(err); } }

  async _pollOnce() {
    const data = await this._getJson('/settings');

    // Plug status
    const plugged = data?.car_connected;
    if (typeof plugged === 'boolean') {
      await this.setCapabilityValue('plug_status', plugged ? 'plugged' : 'unplugged').catch(() => {});
    }

    // Power + kWh
    const totalA = this._extractTotalCurrentA(data);
    const pW = this._extractPowerW(data, totalA);
    if (typeof pW === 'number') await this.setCapabilityValue('measure_power', pW).catch(() => {});

    const kwh = this._extractKwh(data);
    if (typeof kwh === 'number') await this.setCapabilityValue('meter_power', kwh).catch(() => {});

    // Mode
    const modeId = data?.mode_id;
    if (Number.isInteger(modeId)) {
      const enumVal = this._modeIdToEnum(modeId);
      if (enumVal) await this.setCapabilityValue('charger_mode', enumVal).catch(() => {});
    }

    // Error
    const errorId = data?.evse?.error_id;
    await this.setCapabilityValue('alarm_generic', Number.isInteger(errorId) ? errorId !== 0 : false).catch(() => {});

    // Override current UI
    const ov = data?.settings?.override_current;
    if (typeof ov === 'number') await this.setCapabilityValue('override_current_a', ov / 10).catch(() => {});

    // Charging states
    const newChargingState = this._stateToChargingState(data);
    await this.setCapabilityValue('charging_state', newChargingState).catch(() => {});

    // Energy dashboard EV state: disconnected | connected | charging | finished
    const pluggedNow = (plugged === true);
    let evState = pluggedNow ? 'connected' : 'disconnected';
    if (newChargingState === 'charging') evState = 'charging';
    if (newChargingState === 'finished') evState = 'finished';

    await this.setCapabilityValue('evcharger_charging_state', evState).catch(() => {});
    await this.setCapabilityValue('evcharger_charging', newChargingState === 'charging').catch(() => {});

    // Flow triggers (charging started/stopped)
    const prev = this._lastChargingState;
    this._lastChargingState = newChargingState;

    if (prev && prev !== newChargingState) {
      if (prev !== 'charging' && newChargingState === 'charging') {
        await this._maybeNotify('start', pW);
        await this._triggerChargingStarted.trigger(this, {}, {}).catch(this.error);
      }
      if (prev === 'charging' && newChargingState !== 'charging') {
        await this._maybeNotify('stop', pW);
        await this._triggerChargingStopped.trigger(this, {}, {}).catch(this.error);
      }
    }

    // RFID display + flow trigger
    if (typeof data?.rfid === 'string') await this.setCapabilityValue('rfid_status', data.rfid).catch(() => {});
    const last = data?.rfid_lastread;
    if (typeof last === 'string' && last !== '00000000000000') {
      const norm = this._normalizeRfid(last);
      await this.setCapabilityValue('rfid_last', norm).catch(() => {});

      if (norm !== this._lastRfid) {
        this._lastRfid = norm;
        const entry = this._lookupRfid(norm);
        const allowed = Boolean(entry);
        const name = entry ? entry.name : '';

        await this.setCapabilityValue('rfid_allowed', allowed).catch(() => {});
        await this.setCapabilityValue('rfid_name', name).catch(() => {});

        await this._triggerRfidScanned.trigger(this, { rfid: norm, name, allowed }, {}).catch(this.error);
      }
    }

    this.setAvailable();
  }



async _maybeNotify(type, powerW) {
  try {
    const doStart = this.homey.settings.get('notifyChargingStarted') !== false;
    const doStop  = this.homey.settings.get('notifyChargingStopped') !== false;
    const includePower = this.homey.settings.get('notifyIncludePower') !== false;

    if (type === 'start' && !doStart) return;
    if (type === 'stop' && !doStop) return;

    const name = this.getName();
    let excerpt = type === 'start'
      ? `⚡ ${name}: laden gestart`
      : `⏹️ ${name}: laden gestopt`;

    if (includePower && typeof powerW === 'number') excerpt += ` (${Math.round(powerW)} W)`;

    await this.homey.notifications.createNotification({ excerpt });
  } catch (err) {
    this.error('Notification error', err);
  }
}
  async _startPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);

    const pollInterval = Math.max(5, Number(this.getSetting('pollInterval') || 10));

    try { await this._pollOnce(); }
    catch (err) { this.setUnavailable(err.message); }

    this._pollTimer = setInterval(() => {
      this._pollOnce().catch((err) => {
        this.error(err);
        this.setUnavailable(err.message);
      });
    }, pollInterval * 1000);
  }
};

'use strict';
const Homey = require('homey');

class SmartEVSEApp extends Homey.App {
  async onInit() {
    this.log('SmartEVSE app init');

    this.homey.flow.getActionCard('set_mode').registerRunListener(async ({ device, mode }) => {
      await device.apiSetMode(Number(mode));
      await device.pollOnceSafe();
      return true;
    });

    this.homey.flow.getActionCard('set_override_current').registerRunListener(async ({ device, current_a }) => {
      await device.apiSetOverrideCurrent(Number(current_a));
      await device.pollOnceSafe();
      return true;
    });

    this.homey.flow.getActionCard('reset_override_current').registerRunListener(async ({ device }) => {
      await device.apiResetOverrideCurrent();
      await device.pollOnceSafe();
      return true;
    });

    this.homey.flow.getActionCard('reboot').registerRunListener(async ({ device }) => {
      await device.apiReboot();
      return true;
    });

    this.homey.flow.getActionCard('reset_rfid_totals').registerRunListener(async ({ device }) => {
      await device.resetRfidTotals();
      await device.pollOnceSafe();
      return true;
    });
  }
}

module.exports = SmartEVSEApp;

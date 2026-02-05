import Homey from 'homey';
import BESENDriver = require('./driver');

type EmEvseMetaStates = any;

class BESENDevice extends Homey.Device {

  private ip:string = "";
  private password:string = "";
  private userid:string="";
  private evse:any = null

  private get d(): BESENDriver {
    return this.driver as BESENDriver;
  }

  private get Communicator() {
    return this.d.communicator;
  }

  private get Evse():any {
    try
    {
      if(this.evse == null)
        this.evse = this.Communicator.getEvseByIp(this.ip);
    }
    catch{}
    
    return this.evse;
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('BESEN device has been initialized');

    this.ip = this.getStoreValue('ip');
    this.password = this.getStoreValue('password');
    this.userid = this.getStoreValue('userid');

    this.registerCapabilityListener('evcharger_charging', this.StartStopCharging.bind(this))
  }

  async StartStopCharging(value:boolean, opts:any) {
    var metaState = this.Evse.getMetaState();

    if(metaState != "PLUGGED_IN" && metaState != "CHARGING") {
      await this.setUnavailable('Please connect and plug in!');
      return;
    }

    if(value)
      this.Evse.chargeStart({"userId":"homey"});
    else
      this.Evse.chargeStop({"userId":"homey"});
  }

  /*
   * Update is triggered from the driver / communicator
   */
  async Update() {
    this.log(`Update device`);

    if(this.Evse == null)
      return;

    var metaState = this.Evse.getMetaState();
    var charge = this.Evse.getCurrentCharge();
    var state = this.Evse.getState();

    if(state?.innerTemp !== undefined)
      await this.setCapabilityValue('measure_temperature', state?.innerTemp);

    this.log(`${metaState}`);

    if(charge?.currentKWhCounter !== undefined && charge?.currentKWhCounter !== 0)
    {
      await this.setStoreValue("currentKWhCounter", charge?.currentKWhCounter);
    }

    let currentKWhCounter = await this.getStoreValue("currentKWhCounter");
    await this.setCapabilityValue('meter_power', currentKWhCounter);

    if(metaState == "OFFLINE"){
      await this.setUnavailable('Charger is offline');
      return;
    }

    if(metaState == "NOT_LOGGED_IN"){
      if(this.password == "" ||this.password == undefined)
      {
        await this.setUnavailable('Please provide password within the device settings');
      }
      else
      {
        this.Evse.login(this.password);
      }
      return;
    }

    if(metaState == "CHARGING")
    {
      await this.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
      await this.setCapabilityValue('evcharger_charging', true);

      if(state?.currentPower !== undefined)
        await this.setCapabilityValue('measure_power', state?.currentPower);
    }
    else
    {
      await this.setCapabilityValue('evcharger_charging', false);
      await this.setCapabilityValue('measure_power', 0);

      if(metaState == "PLUGGED_IN")
        await this.setCapabilityValue('evcharger_charging_state', 'plugged_in');
      else
        await this.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('BESEN device has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log("MyDevice settings where changed");

    if (changedKeys.includes('userid')) {
      await this.setStoreValue("userid", newSettings.userid);
      this.userid = newSettings.userid as string;
    }

    if (changedKeys.includes('password')) {
      await this.setStoreValue("password", newSettings.password);
      this.password = newSettings.password as string;
    }

    await this.setAvailable();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('BESEN device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('BESEN device has been deleted');
  }

};

export = BESENDevice
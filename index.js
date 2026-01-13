'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

let PlatformAccessory, Service, Characteristic, UUIDGen;

class BraviaFavouritesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.debug = !!this.config.debug;

    this.psk = this.config.psk || '';
    this.favouritesFile =
      this.config.favouritesFile ||
      '/var/lib/homebridge/plugin-persist/bravia-favourites/favourites.txt';

    this.pollIntervalMs = Number.isFinite(this.config.pollIntervalMs)
      ? this.config.pollIntervalMs
      : 5000;

    this.tvs = Array.isArray(this.config.tvs) ? this.config.tvs : [];

    this.accessoriesByUUID = new Map();

    if (!api || !config) return;

    if (!this.psk) {
      this.log('[BraviaFavourites] Missing required config: psk');
      return;
    }
    if (!this.tvs.length) {
      this.log('[BraviaFavourites] No TVs configured.');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.ensureFavouritesFile();
      const favourites = this.loadFavourites();

      const configuredUUIDs = new Set();

      for (const tvCfg of this.tvs) {
        if (!tvCfg || !tvCfg.name || !tvCfg.ip) continue;

        const uuid = UUIDGen.generate(`${tvCfg.name}-BraviaFavourites-${tvCfg.ip}`);
        configuredUUIDs.add(uuid);

        const cachedAccessory = this.accessoriesByUUID.get(uuid);

        if (cachedAccessory) {
          cachedAccessory.context.tvCfg = tvCfg;
          cachedAccessory.context.favourites = favourites;

          // Do not create or remove services here, do it inside the controller constructor.
          this.api.updatePlatformAccessories([cachedAccessory]);
          new BraviaTvController(this, tvCfg, favourites, cachedAccessory);
        } else {
          // IMPORTANT: Create a PlatformAccessory with exactly (name, uuid). Do not pass a category param.
          const accessory = new PlatformAccessory(tvCfg.name, uuid);
          accessory.category = this.api.hap.Categories.TELEVISION;

          accessory.context.tvCfg = tvCfg;
          accessory.context.favourites = favourites;

          new BraviaTvController(this, tvCfg, favourites, accessory);

          this.api.registerPlatformAccessories(
            'homebridge-bravia-favourites',
            'BraviaFavourites',
            [accessory]
          );

          this.log(`[BraviaFavourites] Registered new accessory: ${tvCfg.name}`);
        }
      }

      // Remove stale cached accessories
      const stale = [];
      for (const [uuid, acc] of this.accessoriesByUUID.entries()) {
        if (!configuredUUIDs.has(uuid)) stale.push(acc);
      }
      if (stale.length) {
        this.log(`[BraviaFavourites] Removing ${stale.length} stale accessory(ies)`);
        this.api.unregisterPlatformAccessories(
          'homebridge-bravia-favourites',
          'BraviaFavourites',
          stale
        );
      }
    });
  }

  configureAccessory(accessory) {
    this.accessoriesByUUID.set(accessory.UUID, accessory);
  }

  ensureFavouritesFile() {
    try {
      const dir = path.dirname(this.favouritesFile);
      fs.mkdirSync(dir, { recursive: true });

      if (!fs.existsSync(this.favouritesFile)) {
        const starter =
`# Format: Name=Number
BBC One=1
BBC Two=2
ITV1=3
Channel 4=4
Channel 5=5
BBC News=231
ITV2=6
ITV3=10
Film4=14
Dave=19
5USA-21
`;
        fs.writeFileSync(this.favouritesFile, starter, 'utf8');
        this.log(`[BraviaFavourites] Created starter favourites file at ${this.favouritesFile}`);
      }
    } catch (e) {
      this.log('[BraviaFavourites] Failed to ensure favourites file:', e);
    }
  }

  loadFavourites() {
    const max = Number.isFinite(this.config.maxFavourites) ? this.config.maxFavourites : 30;
    const out = [];

    try {
      const raw = fs.readFileSync(this.favouritesFile, 'utf8');
      for (const lineRaw of raw.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line || line.startsWith('#')) continue;

        const eq = line.indexOf('=');
        if (eq < 1) continue;

        const name = line.slice(0, eq).trim();
        const number = line.slice(eq + 1).trim();

        if (!name) continue;
        if (!/^\d+$/.test(number)) continue;

        out.push({ name, number: String(Number(number)) });
        if (out.length >= max) break;
      }
    } catch (e) {
      this.log('[BraviaFavourites] Failed to load favourites:', e);
    }

    return out;
  }
}

class BraviaTvController {
  constructor(platform, tvCfg, favourites, accessory) {
    this.platform = platform;
    this.log = platform.log;
    this.debug = platform.debug;

    this.name = tvCfg.name;
    this.ip = tvCfg.ip;
    this.port = tvCfg.port || 80;

    // UK Freeview default
    this.tvsource = tvCfg.tvsource || 'tv:dvbt';

    this.psk = platform.psk;
    this.pollIntervalMs = platform.pollIntervalMs;

    this.favourites = Array.isArray(favourites) ? favourites : [];
    this.accessory = accessory;

    this.power = false;
    this.activeIdentifier = 0;

    this.channelUriByNumber = new Map();
    this.lastChannelMapMs = 0;

    this.powerPollTimeout = null;
    this.channelMapTimeout = null;
    this.channelMapInterval = null;

    this.buildServices();
    this.startPollingPower();

    // Build URI map early, then refresh periodically
    this.channelMapTimeout = setTimeout(() => this.refreshChannelMap().catch(() => {}), 2000);
    this.channelMapInterval = setInterval(() => this.refreshChannelMap().catch(() => {}), 6 * 60 * 60 * 1000);

    // Cleanup on shutdown to avoid orphan timers across reloads
    if (this.platform.api) {
      this.platform.api.on('shutdown', () => {
        try {
          if (this.powerPollTimeout) clearTimeout(this.powerPollTimeout);
          if (this.channelMapTimeout) clearTimeout(this.channelMapTimeout);
          if (this.channelMapInterval) clearInterval(this.channelMapInterval);
        } catch (_) {}
      });
    }
  }

  buildServices() {
    // Remove everything except AccessoryInformation (match by UUID, not displayName)
    const infoUUID = Service.AccessoryInformation.UUID;
    for (const s of [...this.accessory.services]) {
      if (s.UUID === infoUUID) continue;
      try { this.accessory.removeService(s); } catch (_) {}
    }

    // Create or reuse Television service
    this.tvService =
      this.accessory.getService(Service.Television) ||
      this.accessory.addService(Service.Television, this.name);

    this.tvService
      .setCharacteristic(Characteristic.ConfiguredName, this.name)
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(
        Characteristic.SleepDiscoveryMode,
        Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
      );

    // Clear existing linked services (helps keep cache stable if favourites change)
    try {
      const linked = this.tvService.linkedServices || [];
      for (const ls of linked) {
        try { this.tvService.removeLinkedService(ls); } catch (_) {}
      }
    } catch (_) {}

    // Wire characteristics
    this.tvService.getCharacteristic(Characteristic.Active)
      .on('get', cb => cb(null, this.power ? 1 : 0))
      .on('set', (value, cb) => {
        this.setPower(!!value)
          .then(() => cb(null))
          .catch(err => {
            this.log(`[BraviaFavourites] ${this.name} setPower error: ${err.message || err}`);
            cb(null);
          });
      });

    this.tvService.getCharacteristic(Characteristic.ActiveIdentifier)
      .on('get', cb => cb(null, this.activeIdentifier))
      .on('set', (identifier, cb) => {
        this.selectIdentifier(identifier)
          .then(() => cb(null))
          .catch(err => {
            this.log(`[BraviaFavourites] ${this.name} selectIdentifier error: ${err.message || err}`);
            cb(null);
          });
      });

    this.identifierToChannel = new Map();
    this.inputServices = [];

    // HomeKit input identifiers must be unique ints
    // We use channel number as identifier, up to 999
    for (const fav of this.favourites) {
      const identifier = Number(fav.number);
      if (!Number.isFinite(identifier) || identifier <= 0 || identifier > 999) continue;

      // Keep subtype stable even if the display name changes
      const subtype = `fav:${fav.number}`;

      const input =
        this.accessory.getServiceById(Service.InputSource, subtype) ||
        this.accessory.addService(Service.InputSource, fav.name, subtype);

      input
        .setCharacteristic(Characteristic.Identifier, identifier)
        .setCharacteristic(Characteristic.ConfiguredName, fav.name)
        .setCharacteristic(Characteristic.Name, fav.name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN)
        .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TUNER);

      this.tvService.addLinkedService(input);

      this.inputServices.push(input);
      this.identifierToChannel.set(identifier, fav.number);
    }

    if (this.debug) {
      this.log(`[BraviaFavourites] ${this.name} loaded ${this.inputServices.length} favourites into HomeKit inputs`);
    }
  }

  startPollingPower() {
    const poll = async () => {
      try {
        const status = await this.getPowerStatus();
        const isOn = (status === 'active');

        if (this.power !== isOn) {
          this.power = isOn;
          this.tvService.getCharacteristic(Characteristic.Active).updateValue(isOn ? 1 : 0);
        }
      } catch (e) {
        if (this.debug) this.log(`[BraviaFavourites] ${this.name} power poll error: ${e.message || e}`);
      } finally {
        this.powerPollTimeout = setTimeout(poll, this.pollIntervalMs);
      }
    };

    poll().catch(() => {});
  }

  async setPower(on) {
    if (this.debug) this.log(`[BraviaFavourites] ${this.name} setPower(${on})`);

    await this.rpc('/sony/system/', {
      id: 2,
      method: 'setPowerStatus',
      version: '1.0',
      params: [{ status: !!on }]
    });

    this.power = !!on;
    this.tvService.getCharacteristic(Characteristic.Active).updateValue(this.power ? 1 : 0);
  }

  async selectIdentifier(identifier) {
    identifier = Number(identifier) || 0;
    this.activeIdentifier = identifier;
    this.tvService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(identifier);

    const channel = this.identifierToChannel.get(identifier);
    if (!channel) return;

    if (this.debug) this.log(`[BraviaFavourites] ${this.name} tuning channel ${channel} (identifier ${identifier})`);
    await this.tuneChannel(channel);
  }

  async refreshChannelMap() {
    const now = Date.now();
    if (now - this.lastChannelMapMs < 60 * 1000) return;
    this.lastChannelMapMs = now;

    const resp = await this.rpc('/sony/avContent/', {
      id: 13,
      method: 'getContentList',
      version: '1.0',
      params: [{ source: this.tvsource, stIdx: 0 }]
    });

    const list = (resp && resp.result && resp.result[0]) ? resp.result[0] : [];
    if (!Array.isArray(list) || !list.length) {
      if (this.debug) this.log(`[BraviaFavourites] ${this.name} getContentList returned no entries for source=${this.tvsource}`);
      return;
    }

    const newMap = new Map();

    for (const item of list) {
      if (!item || !item.uri) continue;

      let num = null;

      if (item.dispNum && /^\d+$/.test(String(item.dispNum))) {
        num = String(Number(item.dispNum));
      }

      if (!num && item.title) {
        const tm = String(item.title).trim().match(/^(\d{1,4})\b/);
        if (tm) num = String(Number(tm[1]));
      }

      if (!num) {
        const um = String(item.uri).match(/(?:dispNum|channel|ch)=(\d+)/i);
        if (um) num = String(Number(um[1]));
      }

      if (num) newMap.set(num, item.uri);
    }

    this.channelUriByNumber = newMap;

    if (this.debug) {
      this.log(`[BraviaFavourites] ${this.name} channel URI map loaded: ${newMap.size} entries`);
    }
  }

  async tuneChannel(channelNumber) {
    const ch = String(Number(channelNumber));

    await this.refreshChannelMap().catch(() => {});
    const channelUri = this.channelUriByNumber.get(ch);

    if (!channelUri) {
      this.log(`[BraviaFavourites] ${this.name} no channel URI for ${ch}. Check tvsource and Live TV availability.`);
      return;
    }

    if (this.debug) this.log(`[BraviaFavourites] ${this.name} setPlayContent uri=${channelUri}`);

    await this.rpc('/sony/avContent/', {
      id: 101,
      method: 'setPlayContent',
      version: '1.0',
      params: [{ uri: channelUri }]
    });
  }

  async getPowerStatus() {
    const resp = await this.rpc('/sony/system/', {
      id: 2,
      method: 'getPowerStatus',
      version: '1.0',
      params: []
    });

    try {
      return resp.result && resp.result[0] && resp.result[0].status ? resp.result[0].status : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async rpc(endpoint, payload) {
    const body = JSON.stringify(payload);
    const data = await this.httpPost(endpoint, body, { 'Content-Type': 'application/json' });
    return JSON.parse(data);
  }

  httpPost(pathname, body, extraHeaders = {}) {
    const headers = Object.assign({}, extraHeaders);
    headers['X-Auth-PSK'] = this.psk;
    headers['Content-Length'] = Buffer.byteLength(body);

    const options = {
      host: this.ip,
      port: this.port,
      path: pathname,
      method: 'POST',
      headers
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} for ${pathname}: ${data.slice(0, 200)}`));
          }
          resolve(data);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = (homebridge) => {
  PlatformAccessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform(
    'homebridge-bravia-favourites',
    'BraviaFavourites',
    BraviaFavouritesPlatform
  );
};

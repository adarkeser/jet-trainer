// DualSense over WebHID: rumble, adaptive triggers and the light bar.
// The Gamepad API only reads buttons and sticks, and on many setups gives no rumble
// at all for the DualSense. WebHID (Chrome and Edge) lets the page write the
// controller's own output report once the player allows it in a browser prompt.
//
// Report layout follows the Linux hid-playstation driver; trigger effects follow
// Nielk1's DualSense trigger effect notes.

const SONY = 0x054c;
const PRODUCTS = [0x0ce6, 0x0df2]; // DualSense, DualSense Edge

// Byte offsets in the 47-byte common part of the output report.
const FLAG0 = 0;
const FLAG1 = 1;
const MOTOR_RIGHT = 2; // weak, high frequency
const MOTOR_LEFT = 3; // strong, low frequency
const RIGHT_TRIGGER = 10; // 11 bytes: mode + 10 parameters
const LEFT_TRIGGER = 21;
const FLAG2 = 38;
const LIGHTBAR_SETUP = 41;
const LED_BRIGHTNESS = 42;
const PLAYER_LEDS = 43;
const LIGHTBAR_RGB = 44;

const F0_COMPATIBLE_VIBRATION = 0x01;
const F0_HAPTICS_SELECT = 0x02;
const F0_RIGHT_TRIGGER = 0x04;
const F0_LEFT_TRIGGER = 0x08;
const F1_LIGHTBAR = 0x04;
const F1_PLAYER_LEDS = 0x10;
const F2_LIGHTBAR_SETUP = 0x02;
const F2_COMPATIBLE_VIBRATION2 = 0x04; // newer firmware wants this one for rumble

// Trigger effects, 11 bytes each. Positions run 0 (released) to 9 (fully pressed).
function zones(position, strength) {
  const s = (Math.max(1, Math.min(8, strength)) - 1) & 7;
  let active = 0;
  let force = 0;
  for (let i = position; i < 10; i++) {
    active |= 1 << i;
    force += s * 2 ** (3 * i); // 30 bits, so plain arithmetic instead of 32-bit shifts
  }
  return { active, force };
}
const bytes = (...b) => { const out = new Uint8Array(11); out.set(b); return out; };

export const TRIGGER = {
  off: () => bytes(0x05),
  // Resistance from a position to the end of travel.
  feedback(position, strength) {
    const { active, force } = zones(position, strength);
    return bytes(0x21, active & 0xff, active >> 8, force & 0xff, (force >>> 8) & 0xff, (force >>> 16) & 0xff, Math.floor(force / 2 ** 24) & 0xff);
  },
  // A gun trigger: resistance that breaks with a click between start (2-7) and end (start+1 to 8).
  weapon(start, end, strength) {
    const z = (1 << start) | (1 << end);
    return bytes(0x25, z & 0xff, z >> 8, Math.max(1, Math.min(8, strength)) - 1);
  },
  // The trigger buzzes from a position on, at a frequency in Hz.
  vibration(position, amplitude, frequency) {
    const { active, force } = zones(position, amplitude);
    return bytes(0x26, active & 0xff, active >> 8, force & 0xff, (force >>> 8) & 0xff, (force >>> 16) & 0xff, Math.floor(force / 2 ** 24) & 0xff, 0, 0, frequency & 0xff);
  },
};

// What the triggers do in each game state.
export const TRIGGER_STATES = {
  off: TRIGGER.off(),
  gun: TRIGGER.weapon(2, 5, 4), // light break right where the gun starts firing
  firing: TRIGGER.vibration(2, 5, 20), // 20 Hz, the gun's rate of fire
  overheat: TRIGGER.feedback(0, 8), // jammed: stiff all the way
  bombs: TRIGGER.weapon(4, 7, 8), // heavy release
  zoom: TRIGGER.feedback(3, 2), // soft resistance on the zoom trigger
};

// Hat switch (0 up, clockwise, 8 released) to the four D-pad buttons.
const HAT_UP = [true, true, false, false, false, false, false, true, false];
const HAT_RIGHT = [false, true, true, true, false, false, false, false, false];
const HAT_DOWN = [false, false, false, true, true, true, false, false, false];
const HAT_LEFT = [false, false, false, false, false, true, true, true, false];

// A report's sticks, triggers and buttons as a Gamepad API object in the standard layout.
function toGamepad(lx, ly, rx, ry, l2, r2, b0, b1, b2, timestamp) {
  const axis = (v) => Math.max(-1, Math.min(1, (v - 128) / 127.5));
  const hat = b0 & 0x0f;
  const pressed = [
    b0 & 0x20, b0 & 0x40, b0 & 0x10, b0 & 0x80, // Cross, Circle, Square, Triangle
    b1 & 0x01, b1 & 0x02, null, null, // L1, R1, L2, R2 (analog, below)
    b1 & 0x10, b1 & 0x20, b1 & 0x40, b1 & 0x80, // Create, Options, L3, R3
    HAT_UP[hat], HAT_DOWN[hat], HAT_LEFT[hat], HAT_RIGHT[hat],
    b2 & 0x01, b2 & 0x02, // PS, touchpad
  ];
  const buttons = pressed.map((p) => ({ pressed: !!p, value: p ? 1 : 0 }));
  buttons[6] = { pressed: l2 > 30, value: l2 / 255 };
  buttons[7] = { pressed: r2 > 30, value: r2 / 255 };
  return {
    id: 'DualSense Wireless Controller (Bluetooth, direct link)',
    index: -1,
    connected: true,
    mapping: 'standard',
    timestamp,
    axes: [axis(lx), axis(ly), axis(rx), axis(ry)],
    buttons,
    vibrationActuator: null,
    direct: true,
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class DualSenseHID {
  static supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  constructor() {
    this.device = null;
    this.bluetooth = false;
    this.seq = 0;
    this.strong = 0;
    this.weak = 0;
    this.rumbleUntil = 0;
    this.right = TRIGGER_STATES.off;
    this.left = TRIGGER_STATES.off;
    this.rightKey = 'off';
    this.leftKey = 'off';
    this.light = [0, 0, 0];
    this.dirty = { rumble: false, right: false, left: false, light: false, setup: true };
    this.busy = false;
    this.error = '';
    this.onchange = null; // called when the device connects or goes away
    // Over Bluetooth the pad switches to its full report once we write to it, and the
    // browser can no longer read its buttons and sticks. We read them here instead.
    this.input = null;
    this.inputAt = 0;
    this.onInput = (e) => this.readInput(e);

    if (DualSenseHID.supported()) {
      navigator.hid.addEventListener('disconnect', (e) => {
        if (e.device === this.device) {
          this.device = null;
          this.onchange?.();
        }
      });
      // A pad allowed before reconnects without a prompt.
      navigator.hid.addEventListener('connect', () => this.reconnect());
    }
  }

  get connected() {
    return !!(this.device && this.device.opened);
  }

  // Needs a click (a browser rule): shows the browser's device picker.
  async connect() {
    if (!DualSenseHID.supported()) throw new Error('WebHID is not available in this browser');
    const [device] = await navigator.hid.requestDevice({ filters: PRODUCTS.map((productId) => ({ vendorId: SONY, productId })) });
    if (!device) return false;
    await this.open(device);
    return true;
  }

  // Previously allowed pads, no prompt.
  async reconnect() {
    if (!DualSenseHID.supported() || this.connected) return false;
    try {
      const devices = await navigator.hid.getDevices();
      const device = devices.find((d) => d.vendorId === SONY && PRODUCTS.includes(d.productId));
      if (!device) return false;
      await this.open(device);
      return true;
    } catch (err) {
      this.error = err.message || String(err);
      return false;
    }
  }

  async open(device) {
    if (!device.opened) await device.open();
    this.device = device;
    device.removeEventListener('inputreport', this.onInput);
    device.addEventListener('inputreport', this.onInput);
    // Over USB the output report is 0x02, over Bluetooth 0x31.
    const outputs = device.collections.flatMap((c) => c.outputReports || []).map((r) => r.reportId);
    this.bluetooth = !outputs.includes(0x02) && outputs.includes(0x31);
    if (this.bluetooth) {
      // Reading the calibration report switches a Bluetooth DualSense to full reports.
      try { await device.receiveFeatureReport(0x05); } catch { /* not fatal */ }
    }
    this.error = '';
    for (const k of Object.keys(this.dirty)) this.dirty[k] = true;
    this.onchange?.();
    this.flush();
  }

  async forget() {
    const d = this.device;
    if (!d) return;
    this.reset();
    await this.flushNow();
    this.device = null;
    this.input = null;
    this.inputAt = 0;
    d.removeEventListener('inputreport', this.onInput);
    try {
      await d.close();
      await d.forget?.();
    } catch { /* already gone */ }
    this.onchange?.();
  }

  readInput(e) {
    if (!this.bluetooth) return;
    const d = e.data;
    const now = performance.now();
    if (e.reportId === 0x31 && d.byteLength >= 11) {
      // Full report: a tag byte, then sticks, triggers, a counter and the buttons.
      const g = (i) => d.getUint8(1 + i);
      this.input = toGamepad(g(0), g(1), g(2), g(3), g(4), g(5), g(7), g(8), g(9), now);
    } else if (e.reportId === 0x01 && d.byteLength >= 9) {
      // Short report the pad sends before it switches: sticks, buttons, then triggers.
      const g = (i) => d.getUint8(i);
      this.input = toGamepad(g(0), g(1), g(2), g(3), g(7), g(8), g(4), g(5), g(6), now);
    } else {
      return;
    }
    const first = !this.inputAt;
    this.inputAt = now;
    if (first) this.onchange?.(); // the menu lists the pad once it is read here
  }

  // The pad as read over the direct Bluetooth link, if it is sending.
  gamepad(now = performance.now()) {
    return this.connected && this.bluetooth && this.input && now - this.inputAt < 5000 ? this.input : null;
  }

  rumble(strong, weak, ms, now = performance.now()) {
    const s = Math.round(Math.min(1, strong) * 255);
    const w = Math.round(Math.min(1, weak) * 255);
    if (s !== this.strong || w !== this.weak) {
      this.strong = s;
      this.weak = w;
      this.dirty.rumble = true;
    }
    this.rumbleUntil = ms > 0 ? now + ms : 0;
    this.flush();
  }

  setTriggers(rightKey, leftKey) {
    if (rightKey !== this.rightKey) {
      this.rightKey = rightKey;
      this.right = TRIGGER_STATES[rightKey] || TRIGGER_STATES.off;
      this.dirty.right = true;
    }
    if (leftKey !== this.leftKey) {
      this.leftKey = leftKey;
      this.left = TRIGGER_STATES[leftKey] || TRIGGER_STATES.off;
      this.dirty.left = true;
    }
    this.flush();
  }

  setLight(r, g, b) {
    if (r === this.light[0] && g === this.light[1] && b === this.light[2]) return;
    this.light = [r, g, b];
    this.dirty.light = true;
    this.flush();
  }

  // Everything off: triggers free, motors still. Used when the game pauses or the tab hides.
  reset() {
    this.rumble(0, 0, 0);
    this.setTriggers('off', 'off');
  }

  // Once per frame: stops the motors when the current rumble runs out.
  tick(now) {
    if (this.rumbleUntil && now >= this.rumbleUntil) {
      this.rumbleUntil = 0;
      if (this.strong || this.weak) this.rumble(0, 0, 0, now);
    }
  }

  build() {
    const c = new Uint8Array(47);
    const d = this.dirty;
    if (d.rumble) {
      c[FLAG0] |= F0_COMPATIBLE_VIBRATION | F0_HAPTICS_SELECT;
      c[FLAG2] |= F2_COMPATIBLE_VIBRATION2;
      c[MOTOR_LEFT] = this.strong;
      c[MOTOR_RIGHT] = this.weak;
    }
    if (d.right) {
      c[FLAG0] |= F0_RIGHT_TRIGGER;
      c.set(this.right, RIGHT_TRIGGER);
    }
    if (d.left) {
      c[FLAG0] |= F0_LEFT_TRIGGER;
      c.set(this.left, LEFT_TRIGGER);
    }
    if (d.setup) {
      // Ends the start-up light animation so the game can set the colour.
      c[FLAG2] |= F2_LIGHTBAR_SETUP;
      c[LIGHTBAR_SETUP] = 0x02;
      c[FLAG1] |= F1_PLAYER_LEDS;
      c[PLAYER_LEDS] = 0x04; // middle player light
      c[LED_BRIGHTNESS] = 0x01;
    }
    if (d.light || d.setup) {
      c[FLAG1] |= F1_LIGHTBAR;
      c.set(this.light, LIGHTBAR_RGB);
    }
    for (const k of Object.keys(d)) d[k] = false;
    if (!this.bluetooth) return { id: 0x02, data: c };
    // Bluetooth: sequence and tag bytes in front, CRC32 at the end.
    const data = new Uint8Array(77);
    data[0] = (this.seq++ & 0x0f) << 4;
    data[1] = 0x10;
    data.set(c, 2);
    const crc = crc32(new Uint8Array([0xa2, 0x31, ...data.subarray(0, 73)]));
    data[73] = crc & 0xff;
    data[74] = (crc >>> 8) & 0xff;
    data[75] = (crc >>> 16) & 0xff;
    data[76] = (crc >>> 24) & 0xff;
    return { id: 0x31, data };
  }

  // One report in flight at a time; changes made meanwhile go in the next one.
  flush() {
    if (!this.connected || this.busy) return;
    if (!Object.values(this.dirty).some(Boolean)) return;
    this.flushNow();
  }

  async flushNow() {
    if (!this.connected) return;
    this.busy = true;
    const { id, data } = this.build();
    try {
      await this.device.sendReport(id, data);
      this.error = '';
    } catch (err) {
      this.error = err.message || String(err);
    }
    this.busy = false;
    if (Object.values(this.dirty).some(Boolean)) this.flush();
  }
}

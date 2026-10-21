// Pause menu, drawn as a preflight card on a pilot's kneeboard.
import { ACTIONS, PRESETS, keyLabel, padLabel } from './controls.js';
import { JET_TYPES } from './flight.js';
import { DualSenseHID } from './dualsense.js';

const IS_MAC = /Mac/.test(navigator.platform);
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Pencil tick for checked boxes.
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.8c2.1 1.5 3.7 3.3 5.1 5.5 2.7-5.3 6.5-10.2 11.9-14.6" /></svg>';

const NOTES = { mouseYaw: 'Recommended' };

const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const canFullscreen = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
function setFullscreen(on) {
  const el = document.documentElement;
  if (on) (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  else (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
}

// Controller navigation in the menu. Fixed buttons, whatever the flight bindings are:
// D-pad or left stick moves, Cross presses, Circle or Options starts flying,
// left and right move a slider, the right stick scrolls the card.
const NAV_DIRS = {
  up: ['Pad12', 'Axis1-'],
  down: ['Pad13', 'Axis1+'],
  left: ['Pad14', 'Axis0-'],
  right: ['Pad15', 'Axis0+'],
};
const NAV_DELAY = 380; // ms before a held direction repeats
const NAV_REPEAT = 110;

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
// The real checkboxes are hidden, their drawn box is the label next to them.
const rectOf = (el) => (el.classList.contains('sr') && el.nextElementSibling ? el.nextElementSibling : el).getBoundingClientRect();

// A selector that finds the same control again after the card is redrawn.
function keyOf(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = [...el.attributes].filter((a) => a.name.startsWith('data-'));
  if (!attrs.length) return null;
  return attrs.map((a) => (a.value ? `[${a.name}="${CSS.escape(a.value)}"]` : `[${a.name}]`)).join('');
}

export function createMenu(root, controls, { onFly, onPadFly, onQuality, onJetType, onUnits }) {
  let waiting = null; // { action, slot } while rebinding
  let message = '';
  let leaveTimer = 0;
  let visible = false;
  let hidMessage = '';
  let keyView = null; // 'keys' or 'pad' once picked; until then it follows whether a controller is connected
  const nav = { dir: null, next: 0 };

  // Show the focus ring only while the controller drives the menu.
  const padNavOff = () => root.classList.remove('pad-nav');
  root.addEventListener('mousemove', padNavOff);
  root.addEventListener('mousedown', padNavOff);
  addEventListener('keydown', padNavOff);

  // Keep the checkbox right when full screen ends another way (Esc, the browser's own button).
  const syncFullscreen = () => {
    const box = root.querySelector('#fullscreen');
    if (box) box.checked = isFullscreen();
  };
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);

  root.addEventListener('click', (e) => {
    if (e.target === root) fly();
  });

  function fly() {
    stopWaiting();
    const tag = root.querySelector('.tag');
    if (tag && !REDUCED_MOTION) tag.classList.add('pulled');
    onFly();
  }

  function stopWaiting() {
    waiting = null;
    controls.capture = null;
    controls.padCapture = null;
  }

  const line = (what, set, forId = '') =>
    `<div class="line">${forId ? `<label class="what" for="${forId}">${what}</label>` : `<span class="what">${what}</span>`}<span class="dots"></span><span class="set">${set}</span></div>`;

  function slider(key, label, min = 0.2, max = 3, step = 0.05) {
    const v = controls.config[key];
    return line(label, `<input type="range" id="${key}" data-sens="${key}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="num" data-val="${key}">${v.toFixed(2)}</span>`, key);
  }

  function checkbox(id, label, checked) {
    return line(label, `<input type="checkbox" class="sr" id="${id}" ${checked ? 'checked' : ''}><label class="box" for="${id}">${TICK}</label>`, id);
  }

  function render() {
    const c = controls.config;
    const keyButton = (action, slot) => {
      const code = c.keys[action][slot];
      const isWaiting = waiting && waiting.action === action && waiting.slot === slot;
      if (!code && slot === 1 && !isWaiting) {
        return `<button class="key add" data-action="${action}" data-slot="1" aria-label="Add a second key">+</button>`;
      }
      const cls = isWaiting ? 'key waiting' : code ? 'key' : 'key empty';
      return `<button class="${cls}" data-action="${action}" data-slot="${slot}">${isWaiting ? 'press a key' : keyLabel(code)}</button>`;
    };
    // Controller column: one binding per action, a button, trigger or stick direction.
    const padButton = (action) => {
      const code = c.pad[action];
      const isWaiting = waiting && waiting.action === action && waiting.slot === 'pad';
      const cls = isWaiting ? 'key pad waiting' : code ? 'key pad' : 'key pad empty';
      return `<button class="${cls}" data-pad="${action}" aria-label="Controller input for this action">${isWaiting ? 'press input' : padLabel(code, controls.padStyle)}</button>`;
    };
    const gp = controls.gamepad;
    // The name comes from the device, so it is escaped before it goes into the page.
    const escape = (t) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const padName = gp ? escape(gp.id.replace(/\s*\(.*\)\s*$/, '')) || 'Controller' : '';
    const menuBtn = controls.padStyle === 'xbox' ? 'Menu' : 'Options';
    const padStatus = gp
      ? `<p class="pad-status on"><b>${padName}</b> connected. Move through this card with the D-pad or left stick, ${controls.padStyle === 'xbox' ? 'A' : 'Cross'} to choose. ${menuBtn} flies, and brings you back here.</p>
        ${gp.mapping !== 'standard' ? '<p class="hint">This browser does not report a standard layout for this controller, so the defaults may be wrong. Chrome and Edge read the DualSense correctly, or rebind the inputs below.</p>' : ''}`
      : '<p class="pad-status">No controller found. Connect a DualSense (or any gamepad) by USB or Bluetooth and press a button on it.</p>';
    // Every device the browser reports, and whether it can rumble: explains a silent Test.
    const padReport = gp
      ? `<p class="hint pad-report">Browser sees: ${controls.padReport().map((r) => `${escape(r.name)} (${r.mapping}, ${r.rumble ? 'vibration' : 'no vibration'})${r.ignored ? ' [not a controller, ignored]' : r.used ? '' : ' [unused]'}`).join('; ')}</p>`
      : '';
    const view = keyView || (gp ? 'pad' : 'keys');
    const usesCtrl = Object.values(c.keys).some((k) => k.some((code) => code && code.startsWith('Control')));

    // Rebinding redraws the card, so keep its scroll position.
    const oldCard = root.querySelector('.card');
    const scroll = oldCard ? oldCard.scrollTop : 0;
    // Same for the focused control, so controller navigation does not jump back to the top.
    const focused = root.contains(document.activeElement) ? keyOf(document.activeElement) : null;
    root.innerHTML = `
      <div class="board">
        <div class="clip" aria-hidden="true"></div>
        <div class="card">
          <header>
            <h1>Jet trainer</h1>
          </header>
          <ol class="steps">
            <li>
              <h2>Pick your jet</h2>
              <div class="choices" role="radiogroup" aria-label="Jet">
                ${Object.entries(JET_TYPES).map(([id, j]) => `
                  <button class="choice" role="radio" aria-checked="${id === c.jetType}" data-jet="${id}">
                    <span class="box">${id === c.jetType ? TICK : ''}</span>
                    <span class="choice-text">
                      <span class="choice-name">${j.name}</span>
                      <span class="choice-sum">${j.summary}</span>
                    </span>
                  </button>`).join('')}
              </div>
            </li>
            <li>
              <h2>Pick your controls</h2>
              <div class="choices" role="radiogroup" aria-label="Control setup">
                ${Object.entries(PRESETS).map(([id, p]) => `
                  <button class="choice" role="radio" aria-checked="${id === c.preset}" data-preset="${id}">
                    <span class="box">${id === c.preset ? TICK : ''}</span>
                    <span class="choice-text">
                      <span class="choice-name">${p.name}${id === c.preset && c.custom ? ' (edited)' : ''}${NOTES[id] ? `<span class="pencil">${NOTES[id]}</span>` : ''}</span>
                      <span class="choice-sum">${p.summary}</span>
                    </span>
                  </button>`).join('')}
              </div>
            </li>
            <li>
              <h2>Set the mouse</h2>
              ${c.mouse === 'stick' ? `
                ${line('Mouse left and right', ['roll', 'yaw'].map((v) => `<button class="pick" data-mousex="${v}" aria-pressed="${c.mouseX === v}">${v === 'roll' ? 'Roll' : 'Yaw'}</button>`).join(''))}
                ${slider('sensPitch', 'Pitch sensitivity')}
                ${slider('sensX', c.mouseX === 'roll' ? 'Roll sensitivity' : 'Yaw sensitivity')}`
                : slider('sensAim', 'Aim sensitivity')}
              ${checkbox('invertY', 'Invert pitch', c.invertY)}
            </li>
            <li>
              <h2>Set the controller</h2>
              ${padStatus}
              ${padReport}
              ${slider('padSensPitch', 'Pitch sensitivity')}
              ${slider('padSensRoll', c.mouse === 'aim' ? 'Turn sensitivity' : 'Roll sensitivity')}
              ${slider('padSensYaw', 'Yaw sensitivity')}
              ${slider('padDeadzone', 'Stick deadzone', 0, 0.4, 0.01)}
              ${checkbox('padInvertY', 'Invert pitch', c.padInvertY)}
              ${checkbox('padToggle', 'Tap for afterburner and free look', c.padToggle)}
              ${line('Vibration', `<span class="rumble-res" data-rumble-res></span><button class="reset inline" data-rumble-test ${gp ? '' : 'disabled'}>Test</button><input type="checkbox" class="sr" id="rumble" ${c.rumble ? 'checked' : ''}><label class="box" for="rumble">${TICK}</label>`, 'rumble')}
              ${DualSenseHID.supported() ? `
                ${line('Triggers and light bar', controls.hid.connected
                  ? '<span class="hid-on">Direct link on</span><button class="reset inline" data-hid-forget>Disconnect</button>'
                  : '<button class="reset inline" data-hid-connect>Connect DualSense</button>')}
                ${controls.hid.connected ? checkbox('triggers', 'Adaptive triggers', c.triggers) + checkbox('lightbar', 'Light bar', c.lightbar) : ''}
                <p class="hint">${hidMessage || controls.hid.error
                  ? escape(hidMessage || controls.hid.error)
                  : controls.hid.connected
                    ? 'R2 breaks like a trigger with the gun, buzzes while firing, goes stiff when the gun overheats and clicks heavy with bombs. L2 has a soft stop for zoom. Rumble goes through this link too.'
                    : 'Gives the page direct access to the DualSense for adaptive triggers, the light bar and rumble, also where the browser offers no rumble. Click it with the mouse: the browser asks once.'}</p>` : ''}
              <p class="hint">BF6 layout: left stick throttle and yaw, L3 afterburner, right stick pitch and roll (pull back to climb), R2 fire, L2 zoom, R3 camera, D-pad down free look, Cross respawn, touchpad stats. Attack jet: Triangle switches weapon, D-pad left gun, D-pad right bombs.</p>
            </li>
            <li>
              <h2>Check your keys</h2>
              ${line('Show', [['keys', 'Keyboard and mouse'], ['pad', 'Controller']].map(([v, label]) => `<button class="pick" data-keyview="${v}" aria-pressed="${view === v}">${label}</button>`).join(''))}
              <div class="keys-${view}">
                ${ACTIONS.map(([action, label]) => line(label, view === 'pad' ? padButton(action) : keyButton(action, 0) + keyButton(action, 1))).join('')}
              </div>
              ${view === 'pad' ? `
                <p class="hint">Click or choose an input, then press a button or trigger or push a stick. ${menuBtn} cancels, Backspace clears it.</p>
                <button class="reset" data-pad-reset>Reset controller</button>` : `
                <p class="hint">Click a key, then press the new key or mouse button. Backspace clears it, Esc cancels.${usesCtrl && !IS_MAC ? ' On Windows, Ctrl can trigger browser shortcuts like Ctrl+W.' : ''}</p>
                <button class="reset" data-reset>Reset keys to ${PRESETS[c.preset].name}</button>`}
            </li>
            <li>
              <h2>Graphics and sound</h2>
              ${line('Graphics', [['performance', 'Performance'], ['high', 'High']].map(([v, label]) => `<button class="pick" data-quality="${v}" aria-pressed="${c.quality === v}">${label}</button>`).join(''))}
              ${line('Ground units', [['few', 'Few'], ['many', 'Many']].map(([v, label]) => `<button class="pick" data-units="${v}" aria-pressed="${c.units === v}">${label}</button>`).join(''))}
              ${checkbox('sound', 'Sound', c.sound)}
              ${canFullscreen ? checkbox('fullscreen', 'Full screen', isFullscreen()) : ''}
            </li>
          </ol>
          <footer>Fan made, not affiliated with EA or DICE. <a href="https://github.com/adarkeser/jet-trainer" target="_blank" rel="noopener">Source on GitHub</a></footer>
        </div>
        <button class="tag" data-fly>
          <span class="grommet" aria-hidden="true"></span>
          <span class="tag-main">Start flying</span>
        </button>
        ${message ? `<p class="msg" role="alert">${message}</p>` : ''}
      </div>`;

    root.querySelector('.card').scrollTop = scroll;
    if (focused && !root.querySelector('.key.waiting')) root.querySelector(focused)?.focus({ preventScroll: true });

    root.querySelectorAll('[data-jet]').forEach((b) => b.addEventListener('click', () => {
      if (c.jetType === b.dataset.jet) return;
      c.jetType = b.dataset.jet;
      controls.save();
      onJetType(c.jetType);
      render();
    }));
    root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      stopWaiting();
      controls.applyPreset(b.dataset.preset);
      render();
    }));
    root.querySelectorAll('[data-mousex]').forEach((b) => b.addEventListener('click', () => {
      c.mouseX = b.dataset.mousex;
      c.custom = true;
      controls.save();
      render();
    }));
    root.querySelectorAll('[data-sens]').forEach((input) => input.addEventListener('input', () => {
      const key = input.dataset.sens;
      c[key] = Number(input.value);
      root.querySelector(`[data-val="${key}"]`).textContent = c[key].toFixed(2);
      controls.save();
    }));
    root.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => {
      c.quality = b.dataset.quality;
      c.qualityChosen = true;
      controls.save();
      onQuality(c.quality);
      render();
    }));
    root.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
      if (c.units === b.dataset.units) return;
      c.units = b.dataset.units;
      controls.save();
      onUnits(c.units);
      render();
    }));
    root.querySelector('#fullscreen')?.addEventListener('change', (e) => setFullscreen(e.target.checked));
    root.querySelector('[data-hid-connect]')?.addEventListener('click', () => {
      hidMessage = '';
      controls.hid.connect().then(() => render(), (err) => {
        // Closing the picker is not an error. A press from the controller is not a click, so the browser refuses.
        if (err && err.name === 'NotFoundError') hidMessage = '';
        else if (err && err.name === 'SecurityError') hidMessage = 'The browser only opens this after a mouse click. Click Connect DualSense with the mouse.';
        else hidMessage = (err && err.message) || String(err);
        render();
      });
    });
    root.querySelector('[data-hid-forget]')?.addEventListener('click', () => {
      hidMessage = '';
      controls.hid.forget().then(() => render());
    });
    for (const id of ['invertY', 'sound', 'padInvertY', 'padToggle', 'rumble', 'triggers', 'lightbar']) {
      root.querySelector(`#${id}`)?.addEventListener('change', (e) => {
        c[id] = e.target.checked;
        controls.save();
      });
    }
    root.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
      waiting = { action: b.dataset.action, slot: Number(b.dataset.slot) };
      controls.capture = (code) => {
        const w = waiting;
        stopWaiting();
        if (code !== 'Escape') controls.bind(w.action, w.slot, code === 'Backspace' ? null : code);
        render();
      };
      render();
      root.querySelector('.key.waiting')?.focus();
    }));
    root.querySelector('[data-rumble-test]').addEventListener('click', () => {
      const out = root.querySelector('[data-rumble-res]');
      out.textContent = '';
      controls.testRumble().then((res) => {
        // 'complete' means the pad took it. Anything else is worth showing.
        out.textContent = res === 'complete' ? 'ok' : String(res);
      });
    });
    root.querySelectorAll('[data-pad]').forEach((b) => b.addEventListener('click', () => {
      const w = { action: b.dataset.pad, slot: 'pad' };
      waiting = w;
      // Keyboard or mouse while waiting: Backspace clears the slot, anything else cancels.
      controls.capture = (code) => {
        stopWaiting();
        if (code === 'Backspace') controls.bindPad(w.action, null);
        render();
      };
      controls.padCapture = (code) => {
        stopWaiting();
        if (code !== 'Pad9') controls.bindPad(w.action, code);
        render();
      };
      render();
      root.querySelector('.key.waiting')?.focus();
    }));
    root.querySelectorAll('[data-keyview]').forEach((b) => b.addEventListener('click', () => {
      stopWaiting();
      keyView = b.dataset.keyview;
      render();
    }));
    root.querySelector('[data-pad-reset]')?.addEventListener('click', () => {
      stopWaiting();
      controls.resetPad();
      render();
    });
    root.querySelector('[data-reset]')?.addEventListener('click', () => {
      stopWaiting();
      controls.applyPreset(c.preset);
      render();
    });
    root.querySelector('[data-fly]').addEventListener('click', fly);
  }

  function focusables() {
    return [...root.querySelectorAll('.card button:not([disabled]), .card input, .tag')]
      .filter((el) => rectOf(el).width > 0);
  }

  function focus(el) {
    root.classList.add('pad-nav');
    el.focus({ preventScroll: true });
    if (!el.classList.contains('tag')) (el.classList.contains('sr') ? el.nextElementSibling : el).scrollIntoView({ block: 'center', behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  }

  // Nearest control in a direction: distance along it, plus a penalty for drifting sideways.
  function move(dir) {
    const list = focusables();
    const cur = document.activeElement;
    if (!list.includes(cur)) {
      // First press: start at the first control in view.
      const card = root.querySelector('.card').getBoundingClientRect();
      const first = list.find((el) => rectOf(el).top >= card.top) || list[0];
      if (first) focus(first);
      return;
    }
    if (cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      const step = Number(cur.step) || 0.05;
      const v = Number(cur.value) + (dir === 'right' ? step : -step);
      cur.value = Math.min(Number(cur.max), Math.max(Number(cur.min), v));
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      root.classList.add('pad-nav');
      return;
    }
    const a = center(rectOf(cur));
    let best = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const b = center(rectOf(el));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const along = { up: -dy, down: dy, left: -dx, right: dx }[dir];
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      // Left and right stay on the same line.
      if ((dir === 'left' || dir === 'right') && across > 12) continue;
      const score = along + across * (dir === 'up' || dir === 'down' ? 0.5 : 2);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) focus(best);
  }

  // Called once per frame while the menu is open.
  function padNav(now, dt) {
    if (!visible || !controls.gamepad || controls.padCapture) {
      nav.dir = null;
      return;
    }
    const dir = Object.keys(NAV_DIRS).find((d) => NAV_DIRS[d].some((code) => controls.padDown.has(code))) || null;
    if (dir !== nav.dir) {
      nav.dir = dir;
      if (dir) {
        move(dir);
        nav.next = now + NAV_DELAY;
      }
    } else if (dir && now >= nav.next) {
      move(dir);
      nav.next = now + NAV_REPEAT;
    }
    const pressed = controls.padPressed;
    if (pressed.has('Pad0')) {
      const el = document.activeElement;
      if (el && el.matches('[data-fly]')) {
        stopWaiting();
        onPadFly();
      } else if (root.contains(el) && el.type !== 'range') {
        root.classList.add('pad-nav');
        el.click();
      } else if (!root.contains(el)) move('down');
    }
    if (pressed.has('Pad1')) {
      stopWaiting();
      onPadFly();
    }
    // Right stick scrolls the card.
    const scroll = (controls.padVal.get('Axis3+') || 0) - (controls.padVal.get('Axis3-') || 0);
    if (scroll) root.querySelector('.card').scrollTop += scroll * 900 * dt;
  }

  return {
    padNav,
    show(v) {
      visible = v;
      clearTimeout(leaveTimer);
      if (!visible) {
        stopWaiting();
        if (root.contains(document.activeElement)) document.activeElement.blur();
        nav.dir = null;
      }
      if (visible) {
        root.classList.remove('hidden', 'leaving');
        message = '';
        render();
        return;
      }
      // The kneeboard drops out of view as you take off.
      if (REDUCED_MOTION || root.classList.contains('hidden')) {
        root.classList.add('hidden');
        return;
      }
      root.classList.add('leaving');
      leaveTimer = setTimeout(() => {
        root.classList.add('hidden');
        root.classList.remove('leaving');
      }, 320);
    },
    refresh() {
      if (visible) render();
    },
    setMessage(m) {
      message = m;
      render();
    },
  };
}

import * as THREE from 'three';
import { createWorld, WORLD } from './world.js';
import { Jet, Explosion, COCKPIT_LAYER, COCKPIT_VIEW_LAYER, EYE } from './jet.js';
import { FlightModel, aimInputs, TUNING, applyJetType } from './flight.js';
import { Bombs, bombGeometry, bombMaterial, BOMBS } from './bombs.js';
import { Controls } from './controls.js';
import { Hud } from './hud.js';
import { createMenu } from './menu.js';
import { createGraphics } from './graphics.js';
import { createTuner } from './tuner.js';
import { Targets } from './targets.js';
import { Gun } from './weapons.js';
import { Sfx } from './audio.js';
import { Stats } from './stats.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const canvas = document.getElementById('scene');
// Log depth keeps far surfaces apart. Without it the water flickers over the ground under it.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight), false);
renderer.info.autoReset = false; // the stats overlay counts every pass of a frame
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, Math.max(1, innerWidth) / Math.max(1, innerHeight), 0.5, 40000);
const world = createWorld(scene, renderer);
const jet = new Jet(scene);
const explosion = new Explosion(scene);
const fm = new FlightModel();
const controls = new Controls();
const hud = new Hud(document.getElementById('hud'));
const targets = new Targets(scene, world, controls.config.units);
const gun = new Gun(scene, world);
const bombs = new Bombs(scene, world, targets);
jet.mountBombs(bombGeometry(), bombMaterial);
const impact = new THREE.Vector3();
let weapon = 'gun'; // 'gun' or 'bombs' (attack jet only)
const isAttack = () => controls.config.jetType === 'attack';

// Picking a jet changes its handling, look and weapons, and starts a fresh run.
function setJetType(type) {
  applyJetType(type);
  jet.setType(type);
  weapon = 'gun';
}
const sfx = new Sfx();
const stats = new Stats(renderer);
const score = { shots: 0, hits: 0, kills: 0 };
const fx = { hitAge: 9, killAge: 9, killed: {} };
const KILL_NAMES = { air: 'drone', tank: 'tank', aa: 'AA gun', cannon: 'field gun', soldier: 'soldier' };
// Count what was destroyed. Kills within the 1.6 s the message shows add up, so a bomb run reads
// as one line ("3 soldiers, 1 tank destroyed").
function noteKills(kinds) {
  if (!kinds.length) return;
  if (fx.killAge >= 1.6) fx.killed = {};
  for (const k of kinds) fx.killed[k] = (fx.killed[k] || 0) + 1;
  fx.killAge = 0;
}
function killText() {
  const parts = Object.entries(fx.killed).map(([k, n]) => `${n} ${KILL_NAMES[k] || k}${n > 1 ? 's' : ''}`);
  if (!parts.length) return '';
  if (parts.length === 1 && parts[0].startsWith('1 ')) {
    const name = parts[0].slice(2);
    return `${name[0].toUpperCase()}${name.slice(1)} destroyed`;
  }
  return `${parts.join(', ')} destroyed`;
}
const gunPoint = new THREE.Vector3();

// Spawn about 1.6 km from the town, where the tanks and AA are, flying toward it.
const SPAWN = new THREE.Vector3();
let spawnHeading = 0;
{
  const town = world.town ? new THREE.Vector3(world.town.x, 0, world.town.y) : new THREE.Vector3();
  const inward = town.lengthSq() > 1 ? town.clone().negate().normalize() : new THREE.Vector3(0, 0, 1);
  SPAWN.copy(town).addScaledVector(inward, 1600);
  SPAWN.y = Math.max(600, world.groundHeight(SPAWN.x, SPAWN.z) + 400);
  const toTown = town.clone().sub(SPAWN).setY(0).normalize();
  spawnHeading = Math.atan2(-toTown.x, -toTown.z);
}
const OUT_OF_BOUNDS_TIME = 10;

const state = { flyMode: null, paused: true, cameraMode: 'chase', crashed: false, oob: 0, agl: 0, warnings: [] };
const aim = { yaw: 0, pitch: 0, dir: new THREE.Vector3(0, 0, -1) };
const auto = { pitch: 0, roll: 0, yaw: 0 };
const cmd = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false };
const look = { yaw: 0, pitch: 0, zoom: false };
const lookQuat = new THREE.Quaternion();
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

const camQuat = new THREE.Quaternion();
const targetQuat = new THREE.Quaternion();
const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.07);
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const CHASE_OFFSET = new THREE.Vector3(0, 4.2, 19);
const COCKPIT_OFFSET = EYE;
const _v = new THREE.Vector3();

function updateAimDir() {
  const cp = Math.cos(aim.pitch);
  aim.dir.set(-Math.sin(aim.yaw) * cp, Math.sin(aim.pitch), -Math.cos(aim.yaw) * cp);
}

function syncAimToJet() {
  aim.yaw = Math.atan2(-fm.fwd.x, -fm.fwd.z);
  aim.pitch = Math.asin(clamp(fm.fwd.y, -1, 1));
  updateAimDir();
}

function respawn() {
  fm.reset(SPAWN, spawnHeading);
  jet.reset(fm);
  explosion.stop();
  gun.clear();
  bombs.reset();
  state.crashed = false;
  state.oob = 0;
  cmd.pitch = cmd.roll = cmd.yaw = cmd.throttle = 0;
  cmd.boost = false;
  look.yaw = look.pitch = 0;
  syncAimToJet();
  camQuat.copy(fm.quaternion);
  placeCamera(1);
}

function crash() {
  state.crashed = true;
  controls.buzz(1, 1, 700);
  explosion.start(fm.position);
  jet.hide();
  gun.firing = false;
  sfx.boom();
}


function pullUpWarning() {
  for (let t = 1; t <= 4; t++) {
    _v.copy(fm.position).addScaledVector(fm.velDir, fm.speed * t);
    if (_v.y < Math.max(world.groundHeight(_v.x, _v.z), 0) + 15 || world.insideBuilding(_v, 12)) return true;
  }
  return false;
}

function step(dt) {
  const inp = controls.sample(dt);
  if (controls.tapped('stats')) {
    controls.config.showStats = !controls.config.showStats;
    controls.save();
  }
  if (controls.tapped('camera')) state.cameraMode = state.cameraMode === 'chase' ? 'cockpit' : 'chase';
  if (controls.tapped('respawn')) {
    respawn();
    return;
  }
  explosion.update(dt);
  targets.update(dt, fm.position);
  fx.hitAge += dt;
  fx.killAge += dt;
  // Weapons: 1 machine gun, 2 bombs, F switches. Only the attack jet has bombs.
  if (controls.tapped('weapon1')) weapon = 'gun';
  if (controls.tapped('weapon2') && isAttack()) weapon = 'bombs';
  if (controls.tapped('nextWeapon') && isAttack()) weapon = weapon === 'gun' ? 'bombs' : 'gun';
  const trigger = !state.crashed && controls.held('fire');
  const shot = gun.update(dt, fm, trigger && weapon === 'gun', targets);
  const bombRun = bombs.update(dt, fm, trigger && weapon === 'bombs');
  jet.setBombCount(bombs.ammo);
  score.kills += bombRun.kills;
  noteKills(bombRun.killed);
  if (bombRun.kills) sfx.kills(bombRun.killed);
  if (bombRun.drops) sfx.drop();
  if (bombRun.booms) {
    sfx.boom();
    controls.buzz(0.6, 0.45, 260);
  }
  score.shots += shot.shots;
  score.hits += shot.hits;
  score.kills += shot.kills;
  if (shot.hits) fx.hitAge = 0;
  noteKills(shot.killed);
  sfx.gun(shot.shots);
  if (shot.hits) sfx.hit(shot.kills > 0);
  // Controller rumble: gun chatter, hits, kills and the afterburner.
  if (shot.shots) controls.buzz(0.08, 0.35, 70);
  if (shot.hits) controls.buzz(0.3, 0.5, 90);
  if (shot.kills) controls.buzz(0.75, 0.6, 250);
  if (fm.boost && !state.crashed) controls.buzz(0.12, 0, 80);
  sfx.engine(fm.throttle, fm.boost, fm.kmh, !state.crashed);

  // Free look (hold): the mouse orbits the camera, releasing it swings back behind the jet.
  look.zoom = inp.zoom;
  if (inp.freeLook) {
    look.yaw = clamp(look.yaw - inp.mouseDX * 0.003, -Math.PI, Math.PI);
    look.pitch = clamp(look.pitch - inp.mouseDY * 0.003, -1.2, 1.2);
    look.yaw = clamp(look.yaw - inp.padLookX * dt * 2.6, -Math.PI, Math.PI);
    look.pitch = clamp(look.pitch + inp.padLookY * dt * 1.8, -1.2, 1.2);
  } else {
    const k = Math.exp(-dt * 6);
    look.yaw *= k;
    look.pitch *= k;
  }
  if (state.crashed) return;

  const c = controls.config;
  if (c.mouse === 'aim') {
    if (!inp.freeLook) {
      const k = 0.0021 * c.sensAim;
      aim.yaw -= inp.mouseDX * k;
      aim.pitch = clamp(aim.pitch - inp.mouseDY * k * (c.invertY ? -1 : 1), -1.5, 1.5);
      // Right stick moves the aim point at a steady rate (BF6 simplified controls on a pad).
      aim.yaw -= inp.padRoll * 1.6 * dt;
      aim.pitch = clamp(aim.pitch + inp.padPitch * 1.2 * dt, -1.5, 1.5);
      updateAimDir();
    }
    aimInputs(fm, aim.dir, auto);
    cmd.pitch = Math.abs(inp.keyPitch) > 0.05 ? inp.keyPitch : auto.pitch;
    cmd.roll = Math.abs(inp.keyRoll) > 0.05 ? inp.keyRoll : auto.roll;
    cmd.yaw = Math.abs(inp.keyYaw) > 0.05 ? inp.keyYaw : auto.yaw;
  } else {
    cmd.pitch = inp.pitch;
    cmd.roll = inp.roll;
    cmd.yaw = inp.yaw;
  }
  cmd.throttle = inp.throttle;
  cmd.boost = inp.boost;

  fm.update(dt, cmd);
  jet.sync(fm, cmd);

  const ground = Math.max(world.groundHeight(fm.position.x, fm.position.z), 0);
  state.agl = fm.position.y - ground;
  if (state.agl < 1.3 || targets.collides(fm.position, 6) || world.insideBuilding(fm.position, 3.5)) {
    crash();
    return;
  }

  const outside = Math.max(Math.abs(fm.position.x), Math.abs(fm.position.z)) > WORLD.bound;
  state.oob = outside ? state.oob + dt : 0;
  if (state.oob > OUT_OF_BOUNDS_TIME) {
    crash();
    return;
  }

  const w = state.warnings;
  w.length = 0;
  if (pullUpWarning()) w.push(['Pull up', 'danger']);
  if (fm.lift < 0.9) w.push(['Stall', 'danger']);
  if (fm.position.y > TUNING.ceiling) w.push(['Altitude ceiling', 'warn']);
  if (state.oob > 0) w.push([`Return to the combat area  ${Math.ceil(OUT_OF_BOUNDS_TIME - state.oob)}`, 'warn']);
}

// The cockpit camera hides the pilot, seat and canopy so they don't block the view.
// They still cast shadows, and the chase camera still shows them.
world.sun.shadow.camera.layers.enable(COCKPIT_LAYER);

function placeCamera(dt) {
  // Chase view shows the pilot and canopy; cockpit view shows the panel and HUD glass instead.
  camera.layers.set(0);
  camera.layers.enable(state.cameraMode === 'cockpit' ? COCKPIT_VIEW_LAYER : COCKPIT_LAYER);
  const aimMode = controls.config.mouse === 'aim';
  if (state.crashed) {
    camera.lookAt(explosion.group.position);
    return;
  }
  if (aimMode) targetQuat.setFromEuler(euler.set(aim.pitch, aim.yaw, 0));
  else targetQuat.copy(fm.quaternion);
  lookQuat.setFromEuler(lookEuler.set(look.pitch, look.yaw, 0));

  if (state.cameraMode === 'cockpit') {
    camQuat.slerp(targetQuat, aimMode ? 1 - Math.exp(-dt * 12) : 1);
    camera.position.copy(COCKPIT_OFFSET).applyQuaternion(fm.quaternion).add(fm.position);
    camera.quaternion.copy(camQuat).multiply(lookQuat);
  } else {
    camQuat.slerp(targetQuat, 1 - Math.exp(-dt * 5.5));
    camera.quaternion.copy(camQuat).multiply(lookQuat);
    camera.position.copy(CHASE_OFFSET).applyQuaternion(camera.quaternion).add(fm.position);
    camera.quaternion.multiply(tilt);
  }

  camera.near = state.cameraMode === 'cockpit' ? 0.25 : 1.5;
  const base = state.cameraMode === 'cockpit' ? 78 : 70;
  let fov = base + clamp((fm.kmh - TUNING.cruiseKmh) / 330, -0.5, 1) * 7;
  if (look.zoom) fov /= 1.8;
  camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * (look.zoom ? 12 : 4)));
  camera.updateProjectionMatrix();
}

// Flying runs with the mouse locked, or unlocked when only a controller is used
// (a gamepad button cannot request pointer lock, browsers want a click for that).
const graphics = createGraphics({ renderer, scene, camera, world });
graphics.setQuality(controls.config.quality);
createTuner({ world, graphics });

const menu = createMenu(document.getElementById('menu'), controls, {
  onFly: () => requestFly(false),
  onPadFly: () => requestFly(true),
  onQuality: (mode) => graphics.setQuality(mode),
  onUnits: (level) => targets.setUnits(level),
  onJetType: (type) => {
    setJetType(type);
    respawn();
  },
});
const LOCK_FAILED = 'The browser did not lock the mouse. Click Fly again in a second.';

function setFlying(mode) {
  state.flyMode = mode;
  controls.locked = mode === 'lock';
  controls.reset();
  state.paused = !mode;
  menu.show(!mode);
  sfx.setEnabled(controls.config.sound);
  if (mode) sfx.start();
  else sfx.pause();
  if (mode && controls.config.mouse === 'aim') syncAimToJet();
}

function requestFly(fromPad) {
  sfx.start();
  if (fromPad) {
    setFlying('pad');
    return;
  }
  const fail = () => {
    if (controls.gamepad) setFlying('pad');
    else menu.setMessage(LOCK_FAILED);
  };
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(fail);
  } catch {
    fail();
  }
}

function stopFlying() {
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  else setFlying(null);
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) setFlying('lock');
  else if (state.flyMode === 'lock') setFlying(null);
});
document.addEventListener('pointerlockerror', () => {
  if (controls.gamepad) setFlying('pad');
  else menu.setMessage(LOCK_FAILED);
});
// Esc does not unlock anything in controller flight, so handle it here.
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && state.flyMode === 'pad' && !controls.capture) setFlying(null);
});
addEventListener('gamepadconnected', () => {
  controls.poll();
  menu.refresh();
});
addEventListener('gamepaddisconnected', () => {
  controls.poll();
  menu.refresh();
  if (state.flyMode === 'pad') setFlying(null);
});

addEventListener('resize', () => graphics.resize());

// Lower the render resolution a step when frames are slow. Raise it again only after a long
// fast stretch, and never straight after lowering it, so it does not bounce (that looked like flicker).
const perf = { time: 0, frames: 0, fastWindows: 0, holdUntil: 0, slowAtFloor: 0 };
const toast = { text: '', until: 0 };
function adaptResolution(rawDt) {
  perf.time += rawDt;
  perf.frames++;
  if (perf.time < 2) return;
  const ms = (perf.time / perf.frames) * 1000;
  perf.time = perf.frames = 0;
  const now = performance.now();
  const pixelRatio = renderer.getPixelRatio();
  let next = pixelRatio;
  // Still slow at the lowest resolution for 6 s: drop High to Performance, unless the player
  // picked High themselves. Remembered, so the next visit starts on Performance.
  perf.slowAtFloor = ms > 22 && pixelRatio <= 1 ? perf.slowAtFloor + 1 : 0;
  const c = controls.config;
  if (perf.slowAtFloor >= 3 && graphics.high && !c.qualityChosen) {
    perf.slowAtFloor = 0;
    c.quality = 'performance';
    controls.save();
    graphics.setQuality('performance');
    graphics.setPixelRatio(1);
    perf.holdUntil = now + 30000;
    toast.text = 'Switched to Performance graphics to keep it smooth. You can change it in the menu.';
    toast.until = now + 6000;
    return;
  }
  if (ms > 20) {
    next = Math.max(1, pixelRatio - 0.25);
    perf.fastWindows = 0;
    perf.holdUntil = now + 30000;
  } else if (ms < 10 && now > perf.holdUntil) {
    perf.fastWindows++;
    if (perf.fastWindows >= 3) {
      next = Math.min(graphics.maxPixelRatio, pixelRatio + 0.25);
      perf.fastWindows = 0;
    }
  } else {
    perf.fastWindows = 0;
  }
  if (next !== pixelRatio) {
    graphics.setPixelRatio(next);
  }
}

// The small green cockpit screen, redrawn four times a second.
let screenTimer = 0;
function updateCockpitScreen() {
  const now = performance.now();
  if (now < screenTimer) return;
  screenTimer = now + 250;
  const thr = fm.boost ? 'AFTERBURNER' : fm.throttle > 0 ? 'THROTTLE UP' : fm.throttle < 0 ? 'AIR BRAKE' : 'CRUISE';
  const acc = score.shots ? Math.round((100 * score.hits) / score.shots) : 0;
  jet.setDisplay([
    thr,
    `SPD ${String(Math.round(fm.kmh)).padStart(4)} KMH`,
    `ALT ${String(Math.round(fm.position.y)).padStart(4)} M`,
    `KILLS ${score.kills}  ACC ${acc}%`,
    weapon === 'bombs' ? `BOMBS ${bombs.ammo}/${BOMBS.capacity}` : gun.overheated ? 'GUN OVERHEAT' : `GUN HEAT ${Math.round(gun.heat * 100)}%`,
  ]);
}

const clock = new THREE.Clock();
function frame() {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  stats.begin(controls.config.showStats);
  controls.poll();
  if (controls.menuButton) {
    controls.menuButton = false;
    if (state.paused) requestFly(true);
    else stopFlying();
  }
  if (state.paused) menu.padNav(performance.now(), dt);
  if (!state.paused && rawDt < 0.25) adaptResolution(rawDt);
  if (!state.paused) step(dt);
  placeCamera(dt);
  world.update(camera, fm.position);
  graphics.render();
  gun.muzzle(fm, gunPoint).addScaledVector(fm.fwd, 500);
  if (state.cameraMode === 'cockpit') updateCockpitScreen();
  hud.draw({
    glass: state.cameraMode === 'cockpit' ? jet.glassPoints() : null,
    dt,
    gunPoint,
    targetList: targets.list,
    sites: world.sites,
    gun,
    weapon,
    groundHeight: world.groundHeight,
    bombs: isAttack() ? {
      selected: weapon === 'bombs',
      ammo: bombs.ammo,
      capacity: BOMBS.capacity,
      impact: weapon === 'bombs' && bombs.ammo > 0 && !state.crashed ? bombs.predictImpact(fm, impact) : null,
    } : null,
    score,
    stats: controls.config.showStats ? stats.out : null,
    toast: performance.now() < toast.until ? toast.text : '',
    hitAge: fx.hitAge,
    killAge: fx.killAge,
    killText: killText(),
    fm,
    camera,
    cmd,
    crashed: state.crashed,
    agl: state.agl,
    warnings: state.warnings,
    cameraMode: state.cameraMode,
    aimDir: controls.config.mouse === 'aim' ? aim.dir : null,
    presetName: controls.presetName(),
    keyNames: { fire: controls.actionLabel('fire'), camera: controls.actionLabel('camera'), respawn: controls.actionLabel('respawn'), menu: controls.menuLabel() },
  });
  stats.end(rawDt);
  controls.endFrame();
  requestAnimationFrame(frame);
}

setJetType(controls.config.jetType);
respawn();
state.agl = fm.position.y - Math.max(world.groundHeight(fm.position.x, fm.position.z), 0);
menu.show(true);
frame();

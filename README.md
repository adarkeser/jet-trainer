# Jet trainer

A browser practice range for Battlefield 6 style jet flying: a fighter and an attack jet with bombs, BF6 control presets you can rebind, and drones, tanks, AA guns, field guns and soldiers to shoot. Three.js from a CDN, no build step, no installs.

Play it at **https://adarkeser.com/jet/**.

Not affiliated with, endorsed by or connected to Electronic Arts or DICE. Battlefield is a trademark of Electronic Arts Inc.

## Run locally

```bash
python3 -m http.server 8137
```

Open http://127.0.0.1:8137. ES modules do not load from `file://`, so a server is needed.

## Files

- `src/flight.js`: arcade flight model. Every feel number is in `TUNING` at the top (speeds, best turn band, turn rates, ceiling); `JET_TYPES` holds the attack jet's slower, heavier overrides. They are guesses, not measured from BF6.
- `src/controls.js`: key bindings, mouse handling, the three presets. Settings save to localStorage.
- `src/menu.js`: pause menu (Esc). Rebinding, sensitivity, preset choice.
- `src/hud.js`: canvas HUD, including the live input monitor at the bottom and a pin over each place that shows only from more than 1 km away (`PLACE_NEAR`).
- `src/world.js`: island terrain with a per-pixel ground shader (fields, forest floor, rock, snow, beaches), mountain shadows and valley darkening baked at load, height haze that replaces three's fog, sky, soft billboard clouds, rippled water, trees, town. The look's defaults are `DEFAULT_LOOK`.
- `src/places.js`: the places on the island (town, airfield, military base, industrial area, four villages, radar station): where they go, the leveled ground under them, their buildings and collision boxes.
- `src/jet.js`: jet model built in code (lofted fuselage, airfoil wings, camo shader), afterburner, wingtip vapor, crash effect.
- `src/weapons.js`: nose cannon. Rate, damage, bullet speed and overheat are in `GUN` at the top.
- `src/bombs.js`: the attack jet's unguided bombs, blast damage and the impact prediction the HUD shows. Numbers are in `BOMBS` at the top.
- `src/targets.js`: orange drones flying circles and weaves, and a garrison at every place: tanks (some driving), AA guns that track the jet, field guns and soldiers. Counts per place are in `GARRISON` at the top, one set for each menu setting (Ground units: Few or Many). Ground units beyond 1.5 km (`SEE`) are not drawn, and every part type draws as one instanced batch, so unit counts barely cost draw calls. All respawn after a kill.
- `src/audio.js`: procedural gun, hit, explosion and engine sounds (no audio files).
- `src/graphics.js`: rendering and the Performance and High modes (bloom, shadow quality, tree and cloud counts, resolution cap).
- `src/tuner.js`: look tuner, shown only with `?tune` in the address. Sliders for exposure, sun, sky fill, haze and bloom, with a copy button for the values.
- `src/stats.js`: performance overlay (P): fps, frame, page CPU and GPU time, JS memory, draw calls and GPU object counts.

## Control presets

All presets share EA's BF6 defaults: W/S throttle, Left Shift afterburner, left mouse fire, right mouse zoom, hold V free look, C camera. Respawn is Enter (R is reload in BF6). Saved settings use `jet-trainer.controls.v2` in localStorage.

- **BF6 default**: mouse pitch and roll, A/D yaw, arrow keys pitch and roll.
- **Mouse yaw**: mouse pitch and yaw, A/D roll, Space pitch up, Left Ctrl pitch down. On macOS Ctrl+click is a right click, so `controls.js` keeps it as fire while flying.
- **Look and turn**: BF6's simplified jet controls (added in Season 4). The mouse aims and the jet flies to the aim point.

## Controller (DualSense)

Connect a DualSense by USB or Bluetooth and press any button on it; the menu shows it as connected. Press **Options** to fly and Options again to come back to the menu. Chrome and Edge report it in the standard gamepad layout; other browsers may need the buttons rebound. Xbox pads work too, with Xbox button names. The menu works from the controller too: D-pad or left stick moves between settings, Cross chooses, left and right move a slider, the right stick scrolls and Circle starts flying.

Defaults follow EA's BF6 controller layout for jets: left stick up and down throttle and air brake, left and right yaw, L3 afterburner, right stick pitch and roll (stick down pulls the nose up, as in BF6), R2 fire, L2 zoom, R3 camera, D-pad down free look (the right stick moves the camera while it is on), Cross respawn, touchpad stats. On the attack jet Triangle switches weapon, D-pad left picks the gun and D-pad right the bombs. Afterburner and free look toggle on a tap, as in BF6, or hold if you turn that off. In Look and turn the right stick moves the aim point.

The "Set the controller" step of the menu has per-axis sensitivity, deadzone, invert pitch and vibration (gun, hits, kills, afterburner, crash). Every action can be rebound in the last column of "Check your keys". "Connect DualSense" in the menu gives the page direct access to the controller through WebHID (Chrome and Edge, one browser prompt). That adds adaptive triggers (R2 breaks like a trigger with the gun, buzzes while firing, goes stiff when the gun overheats and clicks heavy with bombs; L2 has a soft stop for zoom), the light bar, and rumble where the browser itself gives none. `src/dualsense.js` builds the output report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed, see [LICENSE](LICENSE).

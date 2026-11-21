# Rocket Rebuild (WebXR)

An AR puzzle. Find a flat surface, place the build pad, and the 15 broken parts of your
`rocket.fbx` scatter across it. Grab each one, carry it to the pad and let go near its spot.
It snaps in. A progress bar counts parts placed and a counter tracks wrong moves.
A finished copy of the rocket stands on a plinth beside the pad as the goal.

## Run it

WebXR needs HTTPS (or `localhost`). From this folder:

    python3 -m http.server 8000          # then open http://localhost:8000 on a desktop to try it on screen

For a headset or phone, host the folder on any HTTPS static host (GitHub Pages, Netlify, Vercel),
or tunnel your local server (`npx localtunnel --port 8000`, ngrok, or Cloudflare Tunnel).

- Meta Quest: open the URL in Quest Browser, tap Start in AR.
- Android phone: Chrome with ARCore, tap Start in AR, then tap to place. If AR cannot start, the
  message under the buttons says why (page not on HTTPS, no WebXR, ARCore missing).
- iPhone, iPad, or any phone without WebXR AR: tap Camera view. It shows your camera behind the
  game and uses the motion sensors to look around. Tilt the phone down until the ring appears on
  the table, tap Place here, then drag pieces with your finger. It has no surface detection or
  position tracking, so the table stays put as you turn but does not shift as you walk.
- Desktop: Play on screen. Drag a piece, scroll to lift it, Q and E to turn it.

## Controls in AR

| Action | Headset | Phone |
| --- | --- | --- |
| Place the pad | trigger or pinch on the ring | tap |
| Grab and carry | hold trigger or pinch, aim at a piece | touch and drag on a piece |
| Turn a piece | thumbstick left/right, grip button, or Rotate | Rotate button |
| Lift or lower | thumbstick up/down (optional, see below) | not needed |
| Hints, restart | buttons on the floating panel | buttons at the bottom |

Headsets show the HUD as a panel floating behind the pad. Phones use the on-screen HUD.

Height and facing are automatic: fins turn to the right angle as you carry them over a spot,
and the snap rotates them into place. Height is mostly automatic too: a grabbed piece hovers above the table, and when you carry it over
its matching spot it is pulled up to the right height, so you can stack parts without judging
height in the air. Releasing within about 9 cm of the right spot snaps it.

## How the model is used

`js/pieces.js` splits the 35 meshes of `rocket.fbx` into 15 parts (nose, upper nose, grey body,
yellow band, fuel tank, engine core, copper coil, 4 tail fins, 4 side fins). Fins of the same
shape are detected automatically and can fill each other's slot, but they must face the right way.

To use a different model, edit the `PARTS` list in `js/pieces.js`. Each entry lists the mesh names
(`polySurface<N>`) that make up one part. Mark `sym: true` for parts that look the same at any
rotation around the vertical axis.

## Tuning (top of `js/main.js` and `js/pieces.js`)

- `S` (pieces.js): metres per FBX unit. 0.025 makes the rocket 42 cm tall.
- `SNAP_SAME`: how close the right piece must be to snap, in metres. `SNAP` is the stricter range that counts a wrong piece as a wrong move.
- `MAGNET`: how far from a spot the height assist reaches.
- `YAW_TOL`: how far off a fin may face and still snap.
- `COPPER_BOOST` (pieces.js): lifts the near-black fin colour toward the copper in rocket.jpg.

Three.js r160 is bundled in `vendor/` so the game has no build step.
Only the Barlow Condensed font is loaded from Google Fonts, with a system fallback.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildPieces, convertMaterial, S, PAD_H } from './pieces.js';

/* ------------------------------------------------------------------ config */
const FBX_URL = 'assets/rocket.fbx';
const GOAL_IMG = 'assets/rocket.jpg';
const SNAP = 0.065;                                   // metres: how close counts as 'trying a spot' for a wrong piece
const SNAP_SAME = 0.09;                               // metres: how close the right piece must be to snap
const ROT_STEP = THREE.MathUtils.degToRad(15);
const REF_POS = new THREE.Vector3(0.62, 0, -0.12);    // the finished-rocket display, in table space
const UP = new THREE.Vector3(0, 1, 0);
const COL = { ink: '#171a1f', panel: '#20252b', track: '#313840', cream: '#ece4cb', dim: '#a9a590', copper: '#c4622d', brass: '#ccc550', alert: '#e5593f' };

const $ = (s) => document.querySelector(s);
const now = () => performance.now() / 1000;
const angDiff = (a, b) => { const t = Math.PI * 2; return ((a - b + Math.PI) % t + t) % t - Math.PI; };
const ease = (t) => 1 - Math.pow(1 - t, 3);

const game = {
  phase: 'loading',   // loading | title | scan | play | done
  mode: 'desktop',    // desktop | xr
  domMode: true,      // DOM HUD (desktop, phone AR) or in-world panel (headsets)
  hints: false, wrong: 0, snapped: 0, total: 0, t0: 0, tDone: 0,
  toast: '', toastT: 0, toastBad: false, surfaceFound: false,
};

/* ------------------------------------------------------------------- scene */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xaebbcb);
scene.background = SKY;
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 50);
camera.position.set(0.7, 0.62, 0.85);

const root = new THREE.Group();          // table space: origin on the surface, +z faces the player
scene.add(root);
const assembly = new THREE.Group();      // holds the pieces so the finished rocket can spin
root.add(assembly);

root.add(new THREE.HemisphereLight(0xffffff, 0xa09b92, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(0.6, 1.5, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -0.9, right: 0.9, top: 0.9, bottom: -0.9, near: 0.2, far: 4 });
sun.shadow.bias = -0.0004;
root.add(sun, sun.target);

const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.28 }));
shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = 0.0004; shadowCatcher.receiveShadow = true;
root.add(shadowCatcher);

const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.MeshStandardMaterial({ color: 0xcfc4b3, roughness: 1 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -0.001; floor.receiveShadow = true;
root.add(floor);

const controls = new OrbitControls(camera, renderer.domElement);   // created after our pointer handler below
controls.target.set(0.05, 0.16, 0);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.4; controls.maxDistance = 2.6;
controls.enableDamping = true;

/* ------------------------------------------------------------- game state */
let pieces = [], slots = [], pad, refGroup, base = 0;
let lastHeld = null, lastHeldAt = 0, celebrate = false;
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xccc550, transparent: true, opacity: 0.3, depthWrite: false });
const ghostNear = new THREE.MeshBasicMaterial({ color: 0xece4cb, transparent: true, opacity: 0.6, depthWrite: false });

function setEmissive(p, hex, k) {
  p.group.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.emissive.setHex(hex).multiplyScalar(k); }
  });
}

function buildWorld(fbx) {
  const built = buildPieces(fbx);
  pieces = built.pieces; base = built.base; game.total = pieces.length;
  const rocketBottomY = built.minY;

  // Build pad
  pad = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.155, PAD_H, 64), new THREE.MeshStandardMaterial({ color: 0x20252b, roughness: 0.8 }));
  disc.position.y = PAD_H / 2; disc.receiveShadow = true;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.128, 0.138, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc4622d }));
  ring.position.y = PAD_H + 0.0005;
  pad.add(disc, ring); root.add(pad);

  // Slots + ghosts
  slots = pieces.map((p) => {
    const ghost = new THREE.Group();
    for (const m of p.group.children) ghost.add(new THREE.Mesh(m.geometry, ghostMat));
    ghost.scale.setScalar(S); ghost.position.copy(p.home); ghost.visible = false; ghost.renderOrder = 2;
    root.add(ghost);
    p.group.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });
    assembly.add(p.group);
    return { index: p.index, kind: p.kind, pos: p.home.clone(), phi: p.phi, filled: null, ghost, near: false };
  });

  // Finished model on a plinth: the goal to match
  refGroup = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.105, 0.014, 48), new THREE.MeshStandardMaterial({ color: 0x20252b, roughness: 0.8 }));
  plinth.position.y = 0.007; plinth.receiveShadow = true;
  const ref = fbx.clone(true);
  ref.traverse((o) => { if (o.isMesh) { o.material = convertMaterial(o.material); o.castShadow = true; } });
  const rs = S * 0.78;
  ref.scale.setScalar(rs); ref.position.y = 0.014 - rocketBottomY * rs;
  const label = makeLabel('The goal');
  label.position.set(0, 0.014 + 16.9 * rs + 0.05, 0);
  refGroup.add(plinth, ref, label);
  refGroup.position.copy(REF_POS);
  root.add(refGroup);
}

function makeLabel(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 80;
  const x = c.getContext('2d');
  x.fillStyle = COL.ink; roundRect(x, 8, 8, 240, 64, 16); x.fill();
  x.fillStyle = COL.cream; x.font = "700 42px 'Barlow Condensed','Arial Narrow',sans-serif"; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 128, 42);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(0.16, 0.05, 1); s.renderOrder = 5; return s;
}

function scatter() {
  const placed = [];
  for (const p of pieces) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 300; tries++) {
      const a = Math.random() * Math.PI * 2, r = 0.27 + Math.random() * 0.2;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      if (Math.hypot(x - REF_POS.x, z - REF_POS.z) < 0.2) continue;
      if (placed.some((q) => Math.hypot(x - q.x, z - q.z) < p.radius + q.r + 0.02)) continue;
      break;
    }
    placed.push({ x, z, r: p.radius });
    p.group.position.set(x, p.restY, z);
    p.group.rotation.set(0, Math.random() * Math.PI * 2, 0);
    Object.assign(p, { locked: false, held: null, vy: 0, tween: null, flash: 0 });
    setEmissive(p, 0, 0);
  }
  for (const s of slots) { s.filled = null; s.ghost.visible = false; }
  assembly.rotation.y = 0; celebrate = false;
  Object.assign(game, { wrong: 0, snapped: 0, t0: now(), tDone: 0 });
}

/* ------------------------------------------------------------ game actions */
function toast(msg, bad = false) { game.toast = msg; game.toastBad = bad; game.toastT = now() + 2.4; markDirty(); }

function snapTo(p, s) {
  s.filled = p; p.locked = true; s.ghost.visible = false;
  const cur = p.group.rotation.y;
  const ry = p.sym ? cur + angDiff(0, cur) : cur + angDiff(p.phi - s.phi, cur);
  p.tween = { t: 0, dur: 0.2, from: p.group.position.clone(), to: s.pos.clone(), ry0: cur, ry1: ry, arc: 0, done: null };
  p.flash = 1; p.flashHex = 0xccc550;
  game.snapped++;
  beep(520 + game.snapped * 28, 0.14, 'triangle'); haptic(p, 0.7, 70);
  toast('Locked in');
  if (game.snapped === game.total) p.tween.done = finish;
  markDirty();
}

function wrong(p, msg) {
  game.wrong++;
  p.flash = 1; p.flashHex = 0xe5593f;
  beep(150, 0.22, 'sawtooth', 0.06); haptic(p, 1, 120);
  toast(msg, true);
  // bounce the piece back out onto the table
  const pos = p.group.position;
  let a = Math.atan2(pos.z, pos.x);
  const dest = () => new THREE.Vector3(Math.cos(a) * 0.33, p.restY, Math.sin(a) * 0.33);
  let to = dest();
  for (let i = 0; i < 8 && Math.hypot(to.x - REF_POS.x, to.z - REF_POS.z) < 0.2; i++) { a += 0.7; to = dest(); }
  p.tween = { t: 0, dur: 0.5, from: pos.clone(), to, ry0: p.group.rotation.y, ry1: p.group.rotation.y, arc: 0.09, done: null };
  markDirty();
}

function release(p) {
  if (p.target) { p.group.position.copy(p.target); p.target = null; }   // judge where it was heading, not where it lagged
  p.held = null; lastHeld = p; lastHeldAt = now();
  const pos = p.group.position;
  let best = null, bestD = Infinity;
  for (const s of slots) {
    if (s.filled || s.kind !== p.kind) continue;
    const d = pos.distanceTo(s.pos);
    if (d >= SNAP_SAME) continue;
    if (d < bestD) { best = s; bestD = d; }   // any facing is fine: the snap turns the part into place
  }
  if (best) return snapTo(p, best);
  for (const s of slots) {
    if (!s.filled && s.kind !== p.kind && pos.distanceTo(s.pos) < SNAP * 0.75) return wrong(p, 'That piece belongs somewhere else.');
  }
}

function finish() {
  game.phase = 'done'; game.tDone = now(); celebrate = true;
  for (const p of pieces) { p.flash = 1; p.flashHex = 0xccc550; }
  [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'triangle'), i * 120));
  dockToView(); syncUI(); markDirty();
}

function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function act(id) {
  unlockAudio();
  if (id === 'start') { game.phase = 'scan'; dockToView(); }
  else if (id === 'exit') { exitGame(); return; }
  else if (id === 'placeAhead') { placeAhead(); return; }
  else if (id === 'hint') game.hints = !game.hints;
  else if (id === 'rotate') {
    const p = pieces.find((q) => q.held) || (now() - lastHeldAt < 5 && lastHeld && !lastHeld.locked ? lastHeld : null);
    if (p) p.group.rotation.y += ROT_STEP; else toast('Pick up a piece first');
  } else if (id === 'restart' || id === 'again') {
    scatter(); game.phase = 'play'; game.hints = false; toast('Pieces scattered');
    if (game.mode === 'xr') dockToWorld();
  }
  syncUI(); markDirty();
}

/* ----------------------------------------------------- audio and haptics */
let actx = null;
function unlockAudio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } } actx?.resume?.(); }
function beep(f, d = 0.12, type = 'sine', v = 0.07) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + d);
  o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d);
}
function haptic(p, strength, ms) {
  const c = ctrls.find((k) => k.userData.lastPiece === p);
  const gp = c?.userData.src?.gamepad;
  try { gp?.hapticActuators?.[0]?.pulse(strength, ms); } catch { /* ignore */ }
}

/* ------------------------------------------------------- picking + input */
const HOVER = 0.05;      // a grabbed piece lifts this far off the table
const MAGNET = 0.2;      // horizontal reach (m) of the height assist around a matching slot
// Pulls a carried piece up (or down) to the height of the nearest matching empty slot when it is
// over that spot, so you never need to judge height in the air.
function assist(p, v, dt = 0.016) {
  let best = null, bd = MAGNET;
  for (const s of slots) {
    if (s.filled || s.kind !== p.kind) continue;
    const h = Math.hypot(v.x - s.pos.x, v.z - s.pos.z);
    if (h < bd) { bd = h; best = s; }
  }
  if (!best) return;
  const w = THREE.MathUtils.smoothstep(1 - bd / MAGNET, 0, 1);
  const wy = Math.min(1, w * 2.2);                       // height catches up first, then position
  v.y = THREE.MathUtils.lerp(v.y, best.pos.y, wy);
  v.x = THREE.MathUtils.lerp(v.x, best.pos.x, w * 0.75);
  v.z = THREE.MathUtils.lerp(v.z, best.pos.z, w * 0.75);
  if (!p.sym) {                                          // fins turn to face the right way on their own
    const cur = p.group.rotation.y, need = p.phi - best.phi;
    p.group.rotation.y = cur + angDiff(need, cur) * Math.min(1, wy) * (1 - Math.pow(1e-3, dt));
  }
}
const raycaster = new THREE.Raycaster();
function pickPiece(ray) {
  let best = null, bd = Infinity; const c = new THREE.Vector3(), hit = new THREE.Vector3(), sph = new THREE.Sphere();
  for (const p of pieces) {
    if (p.locked || p.held || p.tween) continue;
    p.group.getWorldPosition(c); sph.set(c, p.radius * 1.3 + 0.035);
    if (ray.intersectSphere(sph, hit)) { const d = hit.distanceTo(ray.origin); if (d < bd) { bd = d; best = p; } }
  }
  return best ? { piece: best, dist: bd } : null;
}

// XR controllers, hands and phone touches all arrive as targeting rays.
const reticle = new THREE.Group();
const flat = (g) => g.rotateX(-Math.PI / 2);
reticle.add(new THREE.Mesh(flat(new THREE.RingGeometry(0.135, 0.15, 64)), new THREE.MeshBasicMaterial({ color: 0xc4622d })));            // the build pad
reticle.add(new THREE.Mesh(flat(new THREE.CircleGeometry(0.135, 48)), new THREE.MeshBasicMaterial({ color: 0xc4622d, transparent: true, opacity: 0.28, depthWrite: false })));
reticle.add(new THREE.Mesh(flat(new THREE.RingGeometry(0.495, 0.5, 96)), new THREE.MeshBasicMaterial({ color: 0xece4cb, transparent: true, opacity: 0.45, depthWrite: false })));  // the play area
reticle.add(new THREE.Mesh(flat(new THREE.CircleGeometry(0.012, 24)), new THREE.MeshBasicMaterial({ color: 0xece4cb })));
reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);

const ctrls = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  c.userData = { piece: null, mode: null, dist: 0, off: new THREE.Vector3(), src: null, lastPiece: null, hand: false, lift: 0 };
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xece4cb }));
  line.scale.z = 1.2; line.visible = false; c.add(line);
  c.addEventListener('connected', (e) => { c.userData.src = e.data; line.visible = e.data.targetRayMode === 'tracked-pointer'; });
  c.addEventListener('disconnected', () => { endGrab(c); c.userData.src = null; line.visible = false; });
  c.addEventListener('selectstart', () => onSelectStart(c));
  c.addEventListener('selectend', () => endGrab(c));
  c.addEventListener('squeezestart', () => { if (c.userData.piece) c.userData.piece.group.rotation.y += ROT_STEP; });
  scene.add(c);
  return c;
});

// Hand tracking: a thumb-and-finger pinch near a piece picks it up directly.
const hands = [0, 1].map((i) => {
  const h = renderer.xr.getHand(i);
  h.addEventListener('pinchstart', () => onPinchStart(i));
  h.addEventListener('pinchend', () => endGrab(ctrls[i]));
  scene.add(h);
  return h;
});
const pinchDots = [0, 1].map(() => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.009, 16, 12), new THREE.MeshBasicMaterial({ color: 0xece4cb, depthTest: false }));
  m.renderOrder = 9; m.visible = false; scene.add(m); return m;
});
const cursors = [0, 1].map(() => {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.011, 24), new THREE.MeshBasicMaterial({ color: 0xccc550, depthTest: false }));
  m.renderOrder = 10; m.visible = false; scene.add(m); return m;
});
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

function pinchPoint(i, out) {
  const j = hands[i].joints, a = j?.['index-finger-tip'], b = j?.['thumb-tip'];
  if (!a || !b || !a.visible || !b.visible) return null;
  a.getWorldPosition(out); b.getWorldPosition(_b);
  return out.add(_b).multiplyScalar(0.5);
}
// The point a controller or hand "holds with": pinch point for hands, controller tip otherwise.
function holdPoint(i, out) {
  const u = ctrls[i].userData;
  if (!u.src) return null;
  return u.src.hand ? pinchPoint(i, out) : out.setFromMatrixPosition(ctrls[i].matrixWorld);
}
function nearestPiece(pt, extra = 0) {
  let best = null, bd = Infinity;
  for (const p of pieces) {
    if (p.locked || p.held || p.tween) continue;
    p.group.getWorldPosition(_c);
    const d = _c.distanceTo(pt);
    if (d < p.radius * 1.3 + 0.05 + extra && d < bd) { bd = d; best = p; }
  }
  return best;
}
function grabDirect(i, p, pt) {
  const c = ctrls[i], u = c.userData;
  if (u.piece && u.piece !== p) u.piece.held = null;
  const loc = root.worldToLocal(pt.clone());
  Object.assign(u, { piece: p, lastPiece: p, mode: 'direct', lift: 0 });
  u.off.copy(p.group.position).sub(loc);
  p.held = c; p.vy = 0; lastHeld = p; lastHeldAt = now();
  beep(330, 0.05); haptic(p, 0.4, 40);
}
function onPinchStart(i) {
  if (game.phase !== 'play') return;
  const pt = pinchPoint(i, new THREE.Vector3()); if (!pt) return;
  const p = nearestPiece(pt);
  if (p) grabDirect(i, p, pt);
}
function endGrab(c) {
  const u = c.userData, p = u.piece;
  if (!p) return;
  u.piece = null; u.mode = null;
  release(p);
}

function ctrlRay(c) {
  return new THREE.Ray(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld), new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld));
}

function panelButtonAt(ray) {
  raycaster.set(ray.origin, ray.direction);
  const h = raycaster.intersectObject(panel)[0];
  if (!h) return { hit: null, id: null };
  const x = h.uv.x * PW, y = (1 - h.uv.y) * PH;
  const b = panelButtons.find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
  return { hit: h, id: b ? b.id : null };
}

function onSelectStart(c) {
  unlockAudio();
  const i = ctrls.indexOf(c), u = c.userData, ray = ctrlRay(c);
  if (panel.visible) {
    const { id } = panelButtonAt(ray);
    if (id) { beep(440, 0.06); act(id); return; }
  }
  if (game.phase === 'scan' && reticle.visible) return placeAtReticle();
  if (game.phase !== 'play' || u.piece) return;
  if (!u.src?.hand) {                      // controller: a piece touching the tip is grabbed directly
    const near = nearestPiece(ray.origin, 0.02);
    if (near) return grabDirect(i, near, ray.origin.clone());
  }
  const hit = pickPiece(ray);              // otherwise grab from a distance along the ray
  if (!hit) return;
  const p = hit.piece;
  const tgt = ray.origin.clone().addScaledVector(ray.direction, hit.dist); root.worldToLocal(tgt);
  Object.assign(u, { piece: p, lastPiece: p, mode: 'ray', lift: 0, dist: hit.dist });
  u.off.copy(p.group.position).sub(tgt);
  p.held = c; p.vy = 0;
  beep(330, 0.05); haptic(p, 0.3, 30);
}

// Desktop: drag pieces on a horizontal plane, wheel to lift. (registered before OrbitControls listens)
const mouse = { drag: null };
const dom = renderer.domElement;
function mouseRay(e) {
  const r = dom.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.ray;
}
function dragPoint(ray, y) {
  const plane = new THREE.Plane(UP, -(root.position.y + y)), out = new THREE.Vector3();
  return ray.intersectPlane(plane, out) ? root.worldToLocal(out) : null;
}
dom.addEventListener('pointerdown', (e) => {
  unlockAudio();
  if (game.mode === 'xr' || game.phase !== 'play' || e.button !== 0) return;
  const hit = pickPiece(mouseRay(e));
  if (!hit) return;
  e.stopImmediatePropagation();
  const p = hit.piece; p.held = 'mouse'; p.vy = 0;
  const y = p.group.position.y, pt = dragPoint(mouseRay(e), y);
  mouse.drag = { p, y, raw: null, off: pt ? p.group.position.clone().setY(0).sub(pt.setY(0)) : new THREE.Vector3() };
  controls.enabled = false; dom.setPointerCapture(e.pointerId); beep(330, 0.05);
}, true);
dom.addEventListener('pointermove', (e) => {
  const d = mouse.drag; if (!d) return;
  const pt = dragPoint(mouseRay(e), d.y); if (!pt) return;
  d.raw = new THREE.Vector3(pt.x + d.off.x, Math.max(d.y, d.p.restY + HOVER), pt.z + d.off.z);
});
function endDrag() { const d = mouse.drag; if (!d) return; mouse.drag = null; controls.enabled = game.mode === 'desktop'; release(d.p); }
dom.addEventListener('pointerup', endDrag);
dom.addEventListener('pointercancel', endDrag);
dom.addEventListener('wheel', (e) => {
  const d = mouse.drag; if (!d) return;
  e.preventDefault(); e.stopImmediatePropagation();
  d.y = THREE.MathUtils.clamp(d.y - e.deltaY * 0.0006, d.p.restY, 0.62);
  if (d.raw) d.raw.y = Math.max(d.y, d.p.restY + HOVER);
}, { passive: false, capture: true });
addEventListener('keydown', (e) => {
  const p = mouse.drag?.p || pieces.find((q) => q.held);
  if (!p) return;
  if (e.key === 'q' || e.key === 'Q') p.group.rotation.y += ROT_STEP;
  if (e.key === 'e' || e.key === 'E') p.group.rotation.y -= ROT_STEP;
});

/* ------------------------------------------------------------- XR session */
let hitSource = null, session = null, xrFrames = 0, panelSnap = true;
const rayHitSources = new Map();   // controller / hand rays also look for surfaces

async function addRaySource(src) {
  if (!session || src.targetRayMode !== 'tracked-pointer' || rayHitSources.has(src)) return;
  try { rayHitSources.set(src, await session.requestHitTestSource({ space: src.targetRaySpace })); } catch { /* hit-test unavailable */ }
}

function arHelp() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!window.isSecureContext) return 'AR needs a secure page. Open this game from an https:// link.';
  if (ios) return 'iPhone and iPad browsers do not support WebXR AR. Tap Camera view instead.';
  if (!navigator.xr) return 'This browser has no WebXR. On Android use Chrome, or tap Camera view.';
  return '';
}
async function startAR() {
  unlockAudio();
  const help = arHelp();
  if (help) { $('#support').textContent = help; return; }
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['hit-test', 'local-floor', 'dom-overlay', 'hand-tracking'],
      domOverlay: { root: $('#ui') },
    });
  } catch (err) {
    $('#support').textContent = `Could not start AR (${err.name}). Check that Google Play Services for AR is installed and camera access is allowed, or tap Camera view.`;
    return;
  }
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
  } catch { hitSource = null; }                      // no hit-test: "Place ahead" still works
  rayHitSources.clear();
  session.addEventListener('inputsourceschange', (e) => {
    for (const x of e.removed) { rayHitSources.get(x)?.cancel?.(); rayHitSources.delete(x); }
    for (const x of e.added) addRaySource(x);
  });
  for (const x of session.inputSources) addRaySource(x);
  game.mode = 'xr'; game.domMode = !!session.domOverlayState; game.phase = 'title'; game.surfaceFound = false;
  scene.background = null; floor.visible = false; controls.enabled = false;
  xrFrames = 0; panelSnap = true; panel.visible = false;
  root.position.set(0, 0, -10); root.rotation.set(0, 0, 0);   // park the table until a surface is chosen
  hideTable(true); showPreview();
  session.addEventListener('end', () => {
    hitSource = null; session = null; rayHitSources.clear(); reticle.visible = false; panel.visible = false;
    for (const d of pinchDots) d.visible = false;
    for (const d of cursors) d.visible = false;
    backToDesktop(); syncUI(); markDirty();
  });
  syncUI(); markDirty();
}
function showPreview() {           // assembled rocket behind the title card
  for (const p of pieces) { Object.assign(p, { locked: false, held: null, tween: null, flash: 0, vy: 0 }); p.group.position.copy(p.home); p.group.rotation.set(0, 0, 0); setEmissive(p, 0, 0); }
  for (const x of slots) { x.filled = null; x.ghost.visible = false; }
  assembly.rotation.y = 0; celebrate = false;
  for (const c of ctrls) { c.userData.piece = null; c.userData.mode = null; }
  Object.assign(game, { wrong: 0, snapped: 0, hints: false });
}
function backToDesktop() {
  game.mode = 'desktop'; game.domMode = true; game.phase = 'title';
  scene.background = SKY; floor.visible = true; controls.enabled = true;
  camera.fov = 50; camera.updateProjectionMatrix(); camera.position.set(0.7, 0.62, 0.85); camera.quaternion.identity();
  controls.target.set(0.05, 0.16, 0); controls.update();
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); hideTable(false); showPreview();
}
function exitGame() {
  if (session) session.end();
  else if (game.mode === 'cam') stopCam();
}

/* --------------------------------------- camera view: any phone, no WebXR needed */
const CAM_H = 0.7;                       // assumed height of the phone above the table (m)
const camVideo = document.createElement('video');
camVideo.setAttribute('playsinline', ''); camVideo.muted = true;
Object.assign(camVideo.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '-1' });
const orient = { q: new THREE.Quaternion(), a0: null, have: false };
const _e = new THREE.Euler(), _q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2), _q0 = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1);
const camPoint = new THREE.Vector3();
function onOrient(e) {
  if (e.alpha == null) return;
  if (orient.a0 === null) orient.a0 = e.alpha;
  const D = Math.PI / 180, ang = (screen.orientation?.angle ?? window.orientation ?? 0) * D;
  _e.set(e.beta * D, (e.alpha - orient.a0) * D, -e.gamma * D, 'YXZ');
  orient.q.setFromEuler(_e).multiply(_q1).multiply(_q0.setFromAxisAngle(_z, -ang));
  if (!orient.have) camera.quaternion.copy(orient.q);
  orient.have = true;
}
async function startCam() {
  unlockAudio();
  const support = $('#support');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { support.textContent = 'Camera view needs a secure page. Open this game from an https:// link.'; return; }
  try {
    if (window.DeviceOrientationEvent?.requestPermission) {       // iOS asks for motion access
      try { await DeviceOrientationEvent.requestPermission(); } catch { /* checked below: we warn if no tilt data arrives */ }
    }
    camVideo.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    document.body.prepend(camVideo); await camVideo.play();
  } catch (err) { support.textContent = 'Could not start the camera: ' + err.message; return; }
  addEventListener('deviceorientation', onOrient, true);
  game.motionWarn = false;
  setTimeout(() => { if (!orient.have) { game.motionWarn = true; syncUI(); } }, 2500);
  document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent';   // let the camera feed show through
  game.mode = 'cam'; game.domMode = true; game.phase = 'scan'; game.surfaceFound = false;
  scene.background = null; floor.visible = false; controls.enabled = false;
  camera.fov = 62; camera.updateProjectionMatrix(); camera.position.set(0, CAM_H, 0);
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); hideTable(true);
  syncUI(); markDirty();
}
function stopCam() {
  camVideo.srcObject?.getTracks().forEach((t) => t.stop());
  camVideo.srcObject = null; camVideo.remove();
  removeEventListener('deviceorientation', onOrient, true);
  orient.have = false; orient.a0 = null; reticle.visible = false;
  document.documentElement.style.background = ''; document.body.style.background = '';
  backToDesktop(); syncUI(); markDirty();
}
function updateCamReticle() {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  let found = false;
  if (dir.y < -0.12) {
    const t = -camera.position.y / dir.y;
    if (t < 4) { camPoint.copy(camera.position).addScaledVector(dir, t); camPoint.y = 0; reticle.matrix.makeTranslation(camPoint.x, 0.002, camPoint.z); found = true; }
  }
  reticle.visible = found;
  if (found !== game.surfaceFound) { game.surfaceFound = found; syncUI(); }
}
function placeCam() {
  if (!game.surfaceFound) return;
  root.position.set(camPoint.x, 0, camPoint.z);
  root.rotation.y = Math.atan2(camera.position.x - camPoint.x, camera.position.z - camPoint.z);
  hideTable(false); reticle.visible = false; scatter(); game.phase = 'play';
  beep(600, 0.1, 'triangle'); toast('Pieces scattered'); syncUI(); markDirty();
}

function hideTable(h) { assembly.visible = !h; pad.visible = !h; refGroup.visible = !h; shadowCatcher.visible = !h; }

function headPose() {
  if (renderer.xr.isPresenting) { const xc = renderer.xr.getCamera(); return { pos: xc.position, q: xc.quaternion }; }
  return { pos: camera.position, q: camera.quaternion };
}
function finishPlace() {
  const { pos } = headPose();
  root.rotation.y = Math.atan2(pos.x - root.position.x, pos.z - root.position.z);   // the player stands on +z
  hideTable(false); reticle.visible = false;
  scatter(); game.phase = 'play'; dockToWorld(); beep(600, 0.1, 'triangle'); toast('Pieces scattered');
  syncUI(); markDirty();
}
function placeAtReticle() { root.position.setFromMatrixPosition(reticle.matrix); finishPlace(); }
function placeAhead() {            // fallback when no surface is detected: set the game on the floor in front of you
  const { pos, q } = headPose(), f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  f.y = 0; if (f.lengthSq() < 1e-4) f.set(0, 0, -1); f.normalize();
  root.position.set(pos.x + f.x * 0.9, 0, pos.z + f.z * 0.9);
  finishPlace();
}

function startDesktop() {
  unlockAudio(); game.mode = 'desktop'; game.domMode = true; hideTable(false);
  scatter(); game.phase = 'play'; syncUI(); markDirty();
}

function handleHitTest(frame) {
  if (!frame || game.phase !== 'scan') { if (game.phase !== 'scan' && game.mode === 'xr') reticle.visible = false; return; }
  const space = renderer.xr.getReferenceSpace();
  const m = new THREE.Matrix4();
  let found = false;
  const sources = [...rayHitSources.values()]; if (hitSource) sources.push(hitSource);   // controller / hand rays first, then gaze
  for (const src of sources) {
    for (const r of frame.getHitTestResults(src)) {
      const pose = r.getPose(space); if (!pose) continue;
      m.fromArray(pose.transform.matrix);
      if (m.elements[5] > 0.85) { reticle.matrix.copy(m); found = true; break; }   // horizontal surfaces only
    }
    if (found) break;
  }
  reticle.visible = found;
  if (found !== game.surfaceFound) { game.surfaceFound = found; syncUI(); markDirty(); }
}

/* ------------------------------------------------- in-world panel (headsets) */
const PW = 1024, PH = 640;
const panelCanvas = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
const pctx = panelCanvas.getContext('2d');
const panelTex = new THREE.CanvasTexture(panelCanvas); panelTex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.45), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, toneMapped: false }));
panel.visible = false; scene.add(panel);
let panelButtons = [], panelDirty = true, lastPanelDraw = 0, panelHover = null;
const goalImg = new Image(); goalImg.src = GOAL_IMG; goalImg.onload = markDirty;
let uiDirty = false;
function markDirty() { panelDirty = true; uiDirty = true; }

function dockToView() { if (game.mode === 'xr') panelSnap = true; }
// Title, scan and finish screens float in front of you and drift after your gaze.
function followHead(dt) {
  const { pos, q } = headPose(), f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  f.y = 0; if (f.lengthSq() < 1e-4) return; f.normalize();
  const target = pos.clone().addScaledVector(f, 0.85); target.y = pos.y - 0.08;
  if (panelSnap || panel.position.distanceTo(target) > 0.3) panel.position.lerp(target, panelSnap ? 1 : 1 - Math.exp(-dt * 3));
  const want = Math.atan2(pos.x - panel.position.x, pos.z - panel.position.z);
  panel.rotation.y = panelSnap ? want : panel.rotation.y + angDiff(want, panel.rotation.y) * (1 - Math.exp(-dt * 4));
  panelSnap = false; panel.updateMatrixWorld();
}
function dockToWorld() {           // during play the panel stands behind the pad
  panel.position.copy(root.localToWorld(new THREE.Vector3(0, 0.3, -0.56)));
  panel.rotation.set(0, root.rotation.y, 0); panel.updateMatrixWorld();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
const FONT = "'Barlow Condensed','Arial Narrow','Helvetica Neue',sans-serif";
function text(s, x, y, size, color, weight = 600, align = 'left', maxW = 0) {
  pctx.font = `${weight} ${size}px ${FONT}`;
  while (maxW && size > 18 && pctx.measureText(s).width > maxW) { size -= 2; pctx.font = `${weight} ${size}px ${FONT}`; } pctx.fillStyle = color; pctx.textAlign = align; pctx.textBaseline = 'alphabetic'; pctx.fillText(s, x, y);
}
function button(id, label, x, y, w, h, o = {}) {
  panelButtons.push({ id, x, y, w, h });
  const hov = panelHover === id;
  pctx.fillStyle = o.fill || (o.active ? COL.brass : 'transparent');
  roundRect(pctx, x, y, w, h, 16); pctx.fill();
  if (hov && (o.fill || o.active)) { pctx.fillStyle = 'rgba(255,255,255,0.18)'; roundRect(pctx, x, y, w, h, 16); pctx.fill(); }
  if (!o.fill && !o.active) {
    pctx.fillStyle = hov ? 'rgba(236,228,203,0.12)' : 'transparent'; roundRect(pctx, x, y, w, h, 16); pctx.fill();
    pctx.strokeStyle = hov ? COL.brass : (o.danger ? COL.alert : COL.track); pctx.lineWidth = hov ? 6 : 4; roundRect(pctx, x + 2, y + 2, w - 4, h - 4, 14); pctx.stroke();
  }
  text(label, x + w / 2, y + h / 2 + 12, 38, o.fill ? '#fff' : o.active ? COL.ink : (o.danger ? COL.alert : COL.cream), 700, 'center');
}
function goalThumb(x, y, w, h) {
  pctx.save(); roundRect(pctx, x, y, w, h, 14); pctx.clip();
  if (goalImg.complete && goalImg.naturalWidth) {
    const ir = goalImg.naturalWidth / goalImg.naturalHeight, br = w / h;
    let sw = goalImg.naturalWidth, sh = goalImg.naturalHeight, sx = 0, sy = 0;
    if (ir > br) { sw = sh * br; sx = (goalImg.naturalWidth - sw) / 2; } else { sh = sw / br; sy = (goalImg.naturalHeight - sh) / 2; }
    pctx.drawImage(goalImg, sx, sy, sw, sh, x, y, w, h);
  } else { pctx.fillStyle = COL.track; pctx.fillRect(x, y, w, h); }
  pctx.restore(); text('The goal', x + w / 2, y + h + 34, 30, COL.dim, 500, 'center');
}

function drawPanel() {
  const c = pctx; panelButtons = [];
  c.clearRect(0, 0, PW, PH);
  c.fillStyle = COL.ink; roundRect(c, 0, 0, PW, PH, 40); c.fill();
  if (game.phase === 'title') {
    text('Rocket Rebuild', 52, 118, 104, COL.cream, 700, 'left', 700);
    text('Fifteen broken parts. One rocket.', 52, 170, 38, COL.brass, 500, 'left', 700);
    const steps = ['Aim at a table or the floor, then place the pad.', 'Pinch a piece, or squeeze the trigger, to pick it up.', 'Let go near its spot and it snaps in.', 'Pieces turn and lift themselves into place.'];
    steps.forEach((s, i) => { const y = 250 + i * 58; text(String(i + 1), 52, y, 46, COL.copper, 700); text(s, 100, y - 2, 36, COL.cream, 500, 'left', 660); });
    goalThumb(782, 52, 190, 294);
    button('start', 'Start', 52, 506, 300, 84, { fill: COL.copper });
    button('exit', 'Exit', 372, 506, 180, 84, { danger: true });
  } else if (game.phase === 'scan') {
    text(game.surfaceFound ? 'Surface found' : 'Find a surface', 52, 130, 100, COL.cream, 700, 'left', 920);
    text(game.surfaceFound ? 'Pinch or squeeze the trigger to place the game there.' : 'Point a controller or your hand at a table or the floor.', 52, 205, 42, game.surfaceFound ? COL.brass : COL.dim, 500, 'left', 920);
    text('A ring shows where the pad and play area will go.', 52, 262, 34, COL.dim, 500, 'left', 920);
    text('No ring? Use Place ahead to set it on the floor in front of you.', 52, 312, 34, COL.dim, 500, 'left', 920);
    button('placeAhead', 'Place ahead', 52, 470, 330, 96, { fill: COL.copper });
    button('exit', 'Exit', 742, 470, 230, 96, { danger: true });
  } else if (game.phase === 'play') {
    text(`${game.snapped} of ${game.total}`, 52, 130, 110, COL.cream, 700);
    text('parts placed', 52, 176, 36, COL.dim, 500);
    text('Wrong moves', 560, 94, 36, COL.dim, 500, 'left', 200); text(String(game.wrong), 560, 176, 96, game.toastBad && game.toastT > now() ? COL.alert : COL.cream, 700);
    const sw = (680 - (game.total - 1) * 5) / game.total;
    for (let i = 0; i < game.total; i++) {
      c.fillStyle = i < game.snapped ? (i % 3 === 2 ? COL.brass : COL.copper) : COL.track;
      roundRect(c, 52 + i * (sw + 5), 214, sw, 30, 4); c.fill();
    }
    if (game.toastT > now()) text(game.toast, 52, 316, 46, game.toastBad ? COL.alert : COL.brass, 700, 'left', 690);
    goalThumb(782, 52, 190, 294);
    button('hint', 'Hints', 52, 470, 210, 96, { active: game.hints });
    button('rotate', 'Rotate', 282, 470, 210, 96);
    button('restart', 'Restart', 512, 470, 210, 96);
    button('exit', 'Exit', 742, 470, 230, 96, { danger: true });
  } else if (game.phase === 'done') {
    text('Rocket rebuilt', 52, 150, 112, COL.cream, 700);
    text(game.wrong === 0 ? 'Not a single wrong move.' : 'Every part is back where it belongs.', 52, 212, 42, COL.brass, 500);
    text(fmtTime(game.tDone - game.t0), 52, 360, 120, COL.cream, 700); text('time', 52, 404, 34, COL.dim, 500);
    text(String(game.wrong), 420, 360, 120, COL.cream, 700); text('wrong moves', 420, 404, 34, COL.dim, 500);
    button('again', 'Play again', 52, 480, 330, 96, { fill: COL.copper });
    button('exit', 'Exit', 400, 480, 200, 96, { danger: true });
  }
  panelTex.needsUpdate = true;
}

/* -------------------------------------------------------------- DOM HUD */
const segs = $('#segs');
function syncUI() {
  const dom = game.domMode;
  const ph = game.phase, xr = game.mode === 'xr';
  $('#loading').hidden = ph !== 'loading';
  $('#card-title').hidden = !(dom && ph === 'title');
  $('#hud').hidden = !(dom && ph === 'play');
  $('#card-done').hidden = !(dom && ph === 'done');
  const banner = $('#banner');
  const cam = game.mode === 'cam';
  banner.hidden = !(dom && (xr || cam) && ph === 'scan');
  if (!banner.hidden) banner.innerHTML = cam
    ? (game.surfaceFound ? 'Table spotted<small>Tilt to move the ring, then tap Place.</small><button id="btn-place" class="primary">Place here</button>'
                         : 'Aim at a table or the floor<small>Tilt the phone down until the ring appears.</small>')
      + (game.motionWarn ? '<small>Tilt not detected. Allow motion access for this site in your browser settings.</small>' : '')
    : (game.surfaceFound ? 'Flat surface found<small>Point at the ring and tap to place the pad.</small>'
                         : 'Looking for a flat surface<small>Move your device slowly over a table or the floor.</small>');
  $('#keys').hidden = xr;
  $('#keys').textContent = cam ? 'Drag a piece with your finger. Tilt the phone to look around.' : 'Drag a piece, scroll to lift it, Q and E to turn it. Drag empty space to look around.';
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  $('#btn-cam').hidden = xr || cam || !touch;
  for (const b of document.querySelectorAll('.exit-btn')) b.hidden = !(xr || cam);
  const arBtn = $('#btn-ar');
  if (xr) { arBtn.textContent = 'Begin'; arBtn.disabled = false; $('#btn-desk').hidden = true; $('#support').hidden = true; }
  else { arBtn.textContent = 'Start in AR'; $('#btn-desk').hidden = false; $('#support').hidden = false; }
  $('#btn-hint').setAttribute('aria-pressed', String(game.hints));
  $('#count').textContent = `${game.snapped} of ${game.total}`;
  $('#wrong-n').textContent = String(game.wrong);
  segs.setAttribute('aria-valuenow', String(game.snapped));
  if (segs.children.length !== game.total) { segs.innerHTML = '<i></i>'.repeat(game.total); }
  [...segs.children].forEach((el, i) => el.classList.toggle('on', i < game.snapped));
  if (ph === 'done') {
    $('#d-time').textContent = fmtTime(game.tDone - game.t0);
    $('#d-wrong').textContent = String(game.wrong);
    $('#d-line').textContent = game.wrong === 0 ? 'Not a single wrong move.' : 'Every part is back where it belongs.';
  }
}
let shownToast = '';
function updateToastDOM() {
  const el = $('#toast'), live = game.toastT > now() && game.domMode && game.phase === 'play';
  el.hidden = !live;
  if (live && shownToast !== game.toast) { el.textContent = game.toast; el.classList.toggle('bad', game.toastBad); shownToast = game.toast; }
  if (!live) shownToast = '';
  const w = $('#wrong'); w.classList.toggle('bump', game.toastBad && game.toastT > now());
}

for (const el of document.querySelectorAll('#ui .hit')) el.addEventListener('beforexrselect', (e) => e.preventDefault());
$('#btn-desk').addEventListener('click', startDesktop);
$('#btn-cam').addEventListener('click', startCam);
for (const b of document.querySelectorAll('.exit-btn')) b.addEventListener('click', exitGame);
$('#banner').addEventListener('click', (e) => { if (e.target.id === 'btn-place') placeCam(); });
$('#btn-ar').addEventListener('click', () => (game.mode === 'xr' ? act('start') : startAR()));
$('#btn-hint').addEventListener('click', () => act('hint'));
$('#btn-rotate').addEventListener('click', () => act('rotate'));
$('#btn-restart').addEventListener('click', () => act('restart'));
$('#btn-again').addEventListener('click', () => act('again'));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

/* ------------------------------------------------------------------- loop */
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();

function updatePanelHover() {
  let hov = null;
  for (let i = 0; i < ctrls.length; i++) {
    const cur = cursors[i]; cur.visible = false;
    if (!panel.visible || !ctrls[i].userData.src) continue;
    const { hit, id } = panelButtonAt(ctrlRay(ctrls[i]));
    if (!hit) continue;
    cur.visible = true; cur.position.copy(hit.point).addScaledVector(_c.set(0, 0, 1).applyQuaternion(panel.quaternion), 0.004); cur.quaternion.copy(panel.quaternion);
    if (id && !hov) hov = id;
  }
  if (hov !== panelHover) { panelHover = hov; panelDirty = true; }
}

function update(dt, frame) {
  handleHitTest(frame);
  if (game.mode === 'cam') {
    if (orient.have) camera.quaternion.slerp(orient.q, 0.4);
    if (game.phase === 'scan') updateCamReticle(); else reticle.visible = false;
  }
  if (game.mode === 'xr') {
    if (frame) xrFrames++;
    panel.visible = !game.domMode && game.phase !== 'loading' && xrFrames > 3;   // wait until the headset pose is real
    if (panel.visible && game.phase !== 'play') followHead(dt);
    if (reticle.visible) reticle.visible = game.phase === 'scan';
    updatePanelHover();
  }

  // held pieces follow the controller tip / pinch point (direct) or the ray (far)
  for (let i = 0; i < ctrls.length; i++) {
    const c = ctrls[i], u = c.userData, p = u.piece; if (!p) continue;
    if (u.mode === 'direct') {
      if (!holdPoint(i, _a)) continue;               // tracking lost for a moment: keep the piece where it is
      tmp.copy(_a); root.worldToLocal(tmp).add(u.off);
    } else {
      const ray = ctrlRay(c);
      tmp.copy(ray.origin).addScaledVector(ray.direction, u.dist); root.worldToLocal(tmp).add(u.off);
    }
    const gp = u.src?.gamepad;
    const ay = gp?.axes?.[3] || 0;                                   // thumbstick up/down lifts
    if (Math.abs(ay) > 0.25) u.lift = THREE.MathUtils.clamp(u.lift - ay * dt * 0.35, -0.1, 0.5);
    tmp.y = Math.max(tmp.y + u.lift, p.restY + HOVER);
    assist(p, tmp, dt);
    p.target = (p.target || new THREE.Vector3()).copy(tmp);
    p.group.position.lerp(tmp, 1 - Math.pow(1e-4, dt));
    const ax = gp?.axes?.[2] || 0;
    if (Math.abs(ax) > 0.25) p.group.rotation.y -= ax * dt * 3;
  }

  // glow on pieces that a hand or controller is close enough to grab; dots at pinch points
  const glow = new Set();
  for (let i = 0; i < ctrls.length; i++) {
    const u = ctrls[i].userData, dot = pinchDots[i];
    dot.visible = false;
    if (game.mode !== 'xr' || game.phase !== 'play' || !u.src) continue;
    const pt = holdPoint(i, _a); if (!pt) continue;
    if (u.src.hand) { dot.visible = true; dot.position.copy(pt); dot.scale.setScalar(u.piece ? 1.7 : 1); }
    if (!u.piece) { const n = nearestPiece(pt, u.src.hand ? 0 : 0.02); if (n) glow.add(n); }
  }
  for (const p of pieces) p.glow = glow.has(p);

  const md = mouse.drag;   // mouse / touch drag: follow the pointer with the same assists as XR
  if (md?.raw) {
    tmp.copy(md.raw); assist(md.p, tmp, dt);
    md.p.target = (md.p.target || new THREE.Vector3()).copy(tmp);
    md.p.group.position.lerp(tmp, 1 - Math.pow(1e-4, dt));
  }

  // slot ghosts: shown by Hints, or when a held piece is near a matching slot
  for (const s of slots) s.near = false;
  for (const p of pieces) {
    if (!p.held) continue;
    for (const s of slots) if (!s.filled && s.kind === p.kind && Math.hypot(p.group.position.x - s.pos.x, p.group.position.z - s.pos.z) < MAGNET) s.near = true;
  }
  for (const s of slots) {
    s.ghost.visible = !s.filled && (game.hints || s.near);
    const m = s.near ? ghostNear : ghostMat;
    s.ghost.children.forEach((o) => { o.material = m; });
  }

  for (const p of pieces) {
    const g = p.group;
    if (p.tween) {
      const t = p.tween; t.t += dt / t.dur; const k = ease(Math.min(1, t.t));
      g.position.lerpVectors(t.from, t.to, k); g.position.y += Math.sin(Math.min(1, t.t) * Math.PI) * t.arc;
      g.rotation.y = THREE.MathUtils.lerp(t.ry0, t.ry1, k);
      if (t.t >= 1) { const done = t.done; p.tween = null; done?.(); }
    } else if (!p.held && !p.locked) {
      if (g.position.y > p.restY + 1e-4) { p.vy -= 3 * dt; g.position.y = Math.max(p.restY, g.position.y + p.vy * dt); if (g.position.y === p.restY) p.vy = 0; }
      else g.position.y = p.restY;
    }
    if (p.flash > 0) { p.flash = Math.max(0, p.flash - dt * 2.2); setEmissive(p, p.flashHex || 0xffffff, p.flash * 0.6); p._g = false; }
    else if (p.glow) { setEmissive(p, 0xece4cb, 0.3); p._g = true; }
    else if (p._g) { setEmissive(p, 0, 0); p._g = false; }
  }

  if (celebrate) assembly.rotation.y += dt * 0.7;
  if (refGroup) refGroup.rotation.y += dt * 0.35;
  if (game.mode === 'desktop') controls.update();

  if (game.toastT && game.toastT < now()) { game.toastT = 0; markDirty(); }
  if (uiDirty) { uiDirty = false; syncUI(); }
  updateToastDOM();
  if (panel.visible && panelDirty && now() - lastPanelDraw > 0.08) { drawPanel(); panelDirty = false; lastPanelDraw = now(); }
}

renderer.setAnimationLoop((t, frame) => { update(Math.min(clock.getDelta(), 0.05), frame); renderer.render(scene, camera); });

/* ------------------------------------------------------------------- boot */
(async function boot() {
  try {
    await document.fonts.load("700 40px 'Barlow Condensed'");
  } catch { /* fall back to system condensed */ }
  try {
    const fbx = await new FBXLoader().loadAsync(FBX_URL);
    buildWorld(fbx);
  } catch (err) {
    $('#loading').textContent = 'Could not load ' + FBX_URL + '. Serve this folder over http(s) rather than opening the file directly.';
    console.error(err); return;
  }
  hideTable(false);
  game.phase = 'title';
  showPreview();   // the pieces assembled behind the title card
  const support = $('#support'), arBtn = $('#btn-ar');
  arBtn.disabled = false;
  const help = arHelp();
  let note = help;
  if (!help) {
    try { note = (await navigator.xr.isSessionSupported('immersive-ar')) ? 'AR is ready on this device.' : 'AR may not be supported here. Tap Start in AR to try, or use Camera view.'; }
    catch { note = 'Tap Start in AR to try, or use Camera view.'; }
  }
  support.textContent = note;
  syncUI(); markDirty();
  window.game = game;   // handy for debugging in the console
  window.__rr = { pieces, slots, release, camera, root, THREE, S, panel, drawPanel, renderer, headPose, ctrls, hands, reticle, nearestPiece, act };
})();

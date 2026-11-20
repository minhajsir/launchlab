// Splits the loaded FBX into playable pieces and works out which pieces are interchangeable.
import * as THREE from 'three';

export const S = 0.025;      // metres per FBX unit (rocket ends up ~42 cm tall)
export const PAD_H = 0.012;  // height of the build pad

// sym: rotationally symmetric around the rocket axis, so its yaw never matters.
export const PARTS = [
  { label: 'Nose cone',   names: [24], sym: true },
  { label: 'Upper nose',  names: [26], sym: true },
  { label: 'Grey body',   names: [28], sym: true },
  { label: 'Yellow band', names: [30], sym: true },
  { label: 'Fuel tank',   names: [32], sym: true },
  { label: 'Engine core', names: [34], sym: true },
  { label: 'Copper coil', names: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], sym: true },
  { label: 'Tail fin',    names: [14] },
  { label: 'Tail fin',    names: [15] },
  { label: 'Tail fin',    names: [16] },
  { label: 'Tail fin',    names: [17] },
  { label: 'Side fin',    names: [19] },
  { label: 'Side fin',    names: [20] },
  { label: 'Side fin',    names: [21] },
  { label: 'Side fin',    names: [22] },
];

const UP = new THREE.Vector3(0, 1, 0);

// The fins are authored as a near-black brown that looks muddy without the original lighting.
// Lift that one colour toward the copper seen in rocket.jpg. Set to false to keep the raw FBX colour.
const COPPER_BOOST = true;
function liftCopper(c) {
  if (COPPER_BOOST && c.r > c.g * 1.6 && c.g > c.b && c.r < 0.12) c.set(0xa4501f);
  return c;
}

export function convertMaterial(m) {
  const one = (mat) => new THREE.MeshStandardMaterial({
    color: liftCopper(mat.color ? mat.color.clone() : new THREE.Color(0x888888)),
    roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide,
  });
  return Array.isArray(m) ? m.map(one) : one(m);
}

// Are two fins the same shape, one rotated around the rocket axis?
function congruent(a, b) {
  if (a.pts.length !== b.pts.length) return false;
  const theta = a.phi - b.phi, v = new THREE.Vector3();
  for (const p of a.pts) {
    v.copy(p).applyAxisAngle(UP, theta);
    let best = Infinity;
    for (const q of b.pts) best = Math.min(best, v.distanceToSquared(q));
    if (best > 0.08 * 0.08) return false;
  }
  return true;
}

export function buildPieces(fbx) {
  fbx.updateMatrixWorld(true);
  const byName = new Map();
  fbx.traverse((o) => { if (o.isMesh) byName.set(o.name, o); });
  const box = new THREE.Box3().setFromObject(fbx);
  const base = PAD_H - box.min.y * S;           // y of FBX origin when the rocket stands on the pad
  const v = new THREE.Vector3();
  const pieces = [];

  for (const def of PARTS) {
    const meshes = def.names.map((n) => byName.get('polySurface' + n)).filter(Boolean);
    if (!meshes.length) continue;
    const parts = meshes.map((m) => ({
      geo: m.geometry.clone().applyMatrix4(m.matrixWorld), // bake into rocket space
      mat: convertMaterial(m.material),
    }));
    const sum = new THREE.Vector3(); let n = 0; const pts = [];
    for (const p of parts) {
      const a = p.geo.attributes.position;
      for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i); sum.add(v); n++; if (!def.sym) pts.push(v.clone()); }
    }
    const pivot = sum.divideScalar(n);          // vertex centroid: rotates cleanly with the part
    let minY = Infinity, maxR2 = 0;
    const group = new THREE.Group();
    for (const p of parts) {
      p.geo.translate(-pivot.x, -pivot.y, -pivot.z);
      const a = p.geo.attributes.position;
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i);
        minY = Math.min(minY, v.y); maxR2 = Math.max(maxR2, v.lengthSq());
      }
      const mesh = new THREE.Mesh(p.geo, p.mat);
      mesh.castShadow = true;
      group.add(mesh);
    }
    group.scale.setScalar(S);
    pieces.push({
      index: pieces.length, label: def.label, sym: !!def.sym, group,
      pivot, phi: Math.atan2(pivot.z, pivot.x), pts,
      home: new THREE.Vector3(pivot.x * S, pivot.y * S + base, pivot.z * S),
      restY: -minY * S, radius: Math.sqrt(maxR2) * S,
      kind: -1, locked: false, held: null, vy: 0, tween: null, flash: 0,
    });
  }

  // Cluster interchangeable pieces (same kind => can fill each other's slot).
  let kinds = 0;
  for (const a of pieces) {
    if (a.kind >= 0) continue;
    a.kind = kinds++;
    if (a.sym) continue;
    for (const b of pieces) if (b.kind < 0 && !b.sym && congruent(a, b)) b.kind = a.kind;
  }
  for (const p of pieces) p.pts = null;
  return { pieces, base, minY: box.min.y, size: box.getSize(new THREE.Vector3()) };
}

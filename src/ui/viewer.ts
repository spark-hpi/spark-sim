// 3D view. Uses z-up like MuJoCo, so positions and rotations are taken over 1:1.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Arena } from "../shared/arenas.ts";
import type { WorldSnapshot } from "../shared/protocol.ts";
import { ZUMO } from "../shared/zumo-spec.ts";
import { PixelPass, type PixelMode } from "./pixel.ts";

const Z = ZUMO;

interface RobotView {
  root: THREE.Group;
  cleats: THREE.InstancedMesh[];
  leds: THREE.MeshStandardMaterial[];
  yellow: THREE.MeshStandardMaterial;
  oled: THREE.CanvasTexture;
  ring: THREE.Mesh;
  overlay: THREE.Group;
  proxFans: THREE.Mesh[];
  lineDots: THREE.Mesh[];
  label: HTMLDivElement;
}

export type Theme = "dark" | "light";

/** Scene colours per theme, derived from spark-hpi.de and the star */
const THEMES: Record<
  Theme,
  { bg: number; floor: number; grid: [number, number]; sky: number; ground: number; ramp: string[]; levels: number }
> = {
  dark: {
    bg: 0x070720,
    floor: 0x0e1036,
    grid: [0x2a3590, 0x1a2060],
    sky: 0xc8d6ff,
    ground: 0x1a1d48,
    ramp: ["#04041c", "#0a1a9e", "#2a55ff", "#8db0ff", "#ffffff"],
    levels: 6,
  },
  light: {
    bg: 0xd4e3fe,
    floor: 0xc3d6fb,
    grid: [0x9fb4ea, 0xb4c7f3],
    sky: 0xffffff,
    ground: 0x9fb5e8,
    ramp: ["#11053b", "#25207a", "#3a88fe", "#9cc0ff", "#eef4ff"],
    levels: 9, // bright surfaces need finer steps, otherwise the floor shows bands
  },
};

/** Path of a track (stadium around both axles) as a function of arc length */
function trackPath(s: number): [number, number, number] {
  const R = Z.outerRadius;
  const L = Z.axleFront - Z.axleRear;
  const total = 2 * L + 2 * Math.PI * R;
  s = ((s % total) + total) % total;
  // top, around the front wheel, bottom, around the rear wheel (driving forward moves the top forward)
  if (s < L) return [Z.axleRear + s, R + R, 0]; // top: rear to front
  s -= L;
  if (s < Math.PI * R) {
    const a = s / R; // around the front wheel downwards
    return [Z.axleFront + R * Math.sin(a), R + R * Math.cos(a), a];
  }
  s -= Math.PI * R;
  if (s < L) return [Z.axleFront - s, 0, Math.PI]; // bottom: front to rear
  s -= L;
  const a = s / R;
  return [Z.axleRear - R * Math.sin(a), R - R * Math.cos(a), Math.PI + a];
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private robots: RobotView[] = [];
  private arenaMesh: THREE.Object3D | null = null;
  private arena: Arena | null = null;
  private overlayOn = true;
  private selected = 0;
  private last: WorldSnapshot | null = null;
  private raycaster = new THREE.Raycaster();
  private drag: { slot: number; yaw: number } | null = null;
  /** camera follows the selected robot (orbiting around it still works) */
  private following = false;
  private pixel = new PixelPass();
  private pixelCss = 2; // pixel size in CSS pixels
  private labelLayer: HTMLDivElement;
  private floorMat!: THREE.MeshStandardMaterial;
  private grid!: THREE.GridHelper;
  private hemi!: THREE.HemisphereLight;
  onSelect: (slot: number) => void = () => {};
  onPlace: (slot: number, x: number, y: number, yaw: number) => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // same colours with and without the pixel filter
    container.appendChild(this.renderer.domElement);
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "tag-layer";
    container.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-0.04, -0.78, 0.58);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.02);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.12;
    this.controls.maxDistance = 4;

    this.scene.background = new THREE.Color();
    this.scene.fog = new THREE.Fog(0x000000, 3, 8);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.25);
    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(0.6, -0.8, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -1;
    sc.right = sc.top = 1;
    sc.near = 0.1;
    sc.far = 4;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.floorMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), this.floorMat);
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.setTheme("dark");

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindPointer();
    this.renderer.setAnimationLoop(() => {
      this.followSelected();
      this.controls.update();
      this.pixel.render(this.renderer, this.scene, this.camera);
      this.placeLabels();
    });
  }

  setTheme(theme: Theme) {
    const t = THEMES[theme];
    (this.scene.background as THREE.Color).setHex(t.bg);
    (this.scene.fog as THREE.Fog).color.setHex(t.bg);
    this.floorMat.color.setHex(t.floor);
    this.hemi.color.setHex(t.sky);
    this.hemi.groundColor.setHex(t.ground);
    if (this.grid) this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(6, 60, t.grid[0], t.grid[1]);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = 0.0005;
    this.scene.add(this.grid);
    this.pixel.setRamp(t.ramp);
    this.pixel.setLevels(t.levels);
  }

  setPixelMode(mode: PixelMode) {
    this.pixel.mode = mode;
  }

  /** Name tags as HTML over the scene: they stay sharp even with the pixel filter */
  private placeLabels() {
    if (!this.last) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = new THREE.Vector3();
    this.last.robots.forEach((s, i) => {
      const r = this.robots[i];
      if (!r) return;
      v.set(s.pos[0], s.pos[1], s.pos[2] + 0.07).project(this.camera);
      const hidden = v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2;
      r.label.style.display = hidden ? "none" : "";
      r.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    });
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const dpr = this.renderer.getPixelRatio();
    this.pixel.setSize(w * dpr, h * dpr, this.pixelCss * dpr);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- Arena

  setArena(arena: Arena) {
    // the floor texture is drawn pixel by pixel: only when the arena really changes
    if (this.arenaMesh && this.arena?.id === arena.id) return;
    this.arena = arena;
    if (this.arenaMesh) {
      this.scene.remove(this.arenaMesh);
      disposeTree(this.arenaMesh);
    }
    const e = arena.extent;
    const pxPerM = arena.shape.kind === "disc" ? 1400 : 1100;
    const W = Math.round((e.x1 - e.x0) * pxPerM);
    const H = Math.round((e.y1 - e.y0) * pxPerM);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    for (let j = 0; j < H; j++) {
      const y = e.y1 - ((j + 0.5) / H) * (e.y1 - e.y0);
      for (let i = 0; i < W; i++) {
        const x = e.x0 + ((i + 0.5) / W) * (e.x1 - e.x0);
        const c = arena.color(x, y);
        const k = (j * W + i) * 4;
        img.data[k] = c[0];
        img.data[k + 1] = c[1];
        img.data[k + 2] = c[2];
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
    const side = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6 });
    let mesh: THREE.Object3D;
    if (arena.shape.kind === "disc") {
      // Top as a circle in the XY plane: its UVs map u = x, v = y exactly like the texture. (A cylinder cap would
      // map them rotated by 90° — the shikiri lines ended up parallel to the approach axis.)
      const s = arena.shape;
      const group = new THREE.Group();
      const topMesh = new THREE.Mesh(new THREE.CircleGeometry(s.radius, 160), top);
      topMesh.position.z = s.height;
      topMesh.receiveShadow = true;
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(s.radius, s.radius, s.height, 160, 1, true), side);
      wall.rotation.x = Math.PI / 2;
      wall.position.z = s.height / 2;
      wall.castShadow = true;
      group.add(topMesh, wall);
      mesh = group;
    } else {
      const s = arena.shape;
      // the +z face of a BoxGeometry maps u = x, v = y (canvas row 0 = +y), matching the texture
      const box = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.height), [side, side, side, side, top, side]);
      box.position.z = s.height / 2;
      box.receiveShadow = true;
      box.castShadow = true;
      mesh = box;
    }
    this.arenaMesh = mesh;
    this.scene.add(mesh);
    // a new arena: the camera shows all of it
    if (!this.following) this.view("side");
  }

  // ---------------------------------------------------------------- robots

  setRobots(list: { name: string; color: string }[]) {
    for (const r of this.robots) {
      this.scene.remove(r.root);
      disposeTree(r.root);
      r.label.remove();
    }
    this.robots = list.map((r) => this.makeRobot(r.name, r.color));
    for (const r of this.robots) this.scene.add(r.root);
    this.select(Math.min(this.selected, list.length - 1));
  }

  private makeRobot(name: string, color: string): RobotView {
    const root = new THREE.Group();
    const accent = new THREE.Color(color);
    const box = (sx: number, sy: number, sz: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      root.add(m);
      return m;
    };
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.7 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.9 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.9, roughness: 0.28 });
    const pcb = new THREE.MeshStandardMaterial({ color: 0x14325c, roughness: 0.5 });
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, emissive: accent, emissiveIntensity: 0.15 });

    // chassis between the tracks, battery box
    const inner = 2 * (Z.trackY - Z.trackWidth / 2) - 0.002;
    box(0.074, inner, 0.024, dark, 0.004, 0, 0.006 + 0.012);
    // main board on top with a team-coloured edge
    box(0.083, 2 * Z.halfWidth - 0.004, 0.0016, pcb, 0.004, 0, 0.0318);
    box(0.083, 0.003, 0.002, accentMat, 0.004, Z.halfWidth - 0.002, 0.0322);
    box(0.083, 0.003, 0.002, accentMat, 0.004, -Z.halfWidth + 0.002, 0.0322);
    // OLED on standoffs
    box(0.036, 0.02, 0.004, dark, -0.004, 0, 0.0346);
    const oledCanvas = document.createElement("canvas");
    oledCanvas.width = 128;
    oledCanvas.height = 64;
    const oled = new THREE.CanvasTexture(oledCanvas);
    oled.magFilter = THREE.NearestFilter;
    oled.minFilter = THREE.LinearFilter;
    oled.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.031, 0.0155),
      new THREE.MeshBasicMaterial({ map: oled, toneMapped: false }),
    );
    screen.position.set(-0.004, 0, 0.0367);
    screen.rotation.z = -Math.PI / 2; // the display reads from behind (buttons are at the back)
    root.add(screen);

    // tracks: body + moving cleats
    const cleats: THREE.InstancedMesh[] = [];
    for (const side of [1, -1]) {
      const y = side * Z.trackY;
      const R = Z.outerRadius - 0.0018;
      const shape = new THREE.Shape();
      shape.absarc(Z.axleFront, Z.outerRadius, R, -Math.PI / 2, Math.PI / 2, false);
      shape.absarc(Z.axleRear, Z.outerRadius, R, Math.PI / 2, (3 * Math.PI) / 2, false);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: Z.trackWidth, bevelEnabled: false, curveSegments: 24 });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, y + Z.trackWidth / 2, 0);
      const body = new THREE.Mesh(geo, rubber);
      body.castShadow = true;
      root.add(body);
      const n = 26;
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0034, Z.trackWidth + 0.0006, 0.0022), rubber, n);
      im.castShadow = true;
      im.position.y = y;
      root.add(im);
      cleats.push(im);
      // visible sprocket hubs
      for (const ax of [Z.axleRear, Z.axleFront]) {
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.002, 16), dark);
        hub.position.set(ax, y + side * (Z.trackWidth / 2 + 0.0008), Z.outerRadius);
        root.add(hub);
      }
    }

    // blade exactly as in the physics model
    const a = (Z.bladeAngleDeg * Math.PI) / 180;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(Z.bladeLength, 2 * Z.halfWidth, 0.0016), steel);
    blade.position.set(Z.front - (Z.bladeLength / 2) * Math.cos(a), 0, Z.bladeGap + (Z.bladeLength / 2) * Math.sin(a) + 0.0008);
    blade.rotation.y = a;
    blade.castShadow = true;
    root.add(blade);
    // front sensor array
    box(0.008, 0.07, 0.008, dark, 0.044, 0, 0.012);

    // RGB LEDs (A-C at the back, D-F at the front, counter-clockwise) and the yellow LED
    const ledPos: [number, number][] = [
      [-0.03, -0.022],
      [-0.032, 0],
      [-0.03, 0.022],
      [0.038, 0.022],
      [0.04, 0],
      [0.038, -0.022],
    ];
    const leds = ledPos.map(([x, y]) => {
      const m = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0x000000, emissiveIntensity: 3, toneMapped: false });
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.0016), m);
      led.position.set(x, y, 0.0333);
      root.add(led);
      return m;
    });
    const yellow = new THREE.MeshStandardMaterial({ color: 0x554400, emissive: 0x000000, emissiveIntensity: 3, toneMapped: false });
    const ym = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.003, 0.0014), yellow);
    ym.position.set(-0.036, -0.03, 0.0332);
    root.add(ym);

    // selection ring on the floor
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.068, 0.074, 64),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    ring.position.set(0.01, 0, 0.0008);
    root.add(ring);

    // sensor view
    const overlay = new THREE.Group();
    root.add(overlay);
    const proxFans = Z.proxSensors.map((s) => {
      const geo = new THREE.CircleGeometry(1, 32, -Math.PI / 6, Math.PI / 3);
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
      );
      m.position.set(s.pos[0], s.pos[1], Z.proxSensorZ);
      m.rotation.z = (s.dir * Math.PI) / 180;
      overlay.add(m);
      return m;
    });
    const lineDots = Z.lineSensors.map(([x, y]) => {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(0.0042, 16),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
      );
      m.position.set(x + 0.012, y, 0.0372);
      m.renderOrder = 10;
      overlay.add(m);
      return m;
    });

    // name tag (HTML, see placeLabels)
    const label = document.createElement("div");
    label.className = "tag";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = color;
    label.append(chip, document.createTextNode(name));
    this.labelLayer.append(label);

    return { root, cleats, leds, yellow, oled, ring, overlay, proxFans, lineDots, label };
  }

  /** Rename a robot's tag without rebuilding the scene */
  setName(slot: number, name: string) {
    const r = this.robots[slot];
    if (r) r.label.lastChild!.textContent = name;
  }

  select(slot: number) {
    this.selected = slot;
    this.robots.forEach((r, i) => {
      (r.ring.material as THREE.MeshBasicMaterial).opacity = i === slot ? 0.95 : 0.25;
      r.label.classList.toggle("on", i === slot);
    });
  }

  setOverlay(on: boolean) {
    this.overlayOn = on;
    for (const r of this.robots) r.overlay.visible = on;
  }

  /** Draw an OLED buffer (SH1106, MONO_VLSB, hex) onto the robot's screen */
  setDisplay(slot: number, hex: string, inverted: boolean) {
    const r = this.robots[slot];
    if (!r) return;
    drawOled(r.oled.image as HTMLCanvasElement, hex, inverted);
    r.oled.needsUpdate = true;
  }

  setLeds(slot: number, rgb: number[]) {
    const r = this.robots[slot];
    if (!r) return;
    r.leds.forEach((m, i) => {
      const c = new THREE.Color(rgb[i * 3] / 255, rgb[i * 3 + 1] / 255, rgb[i * 3 + 2] / 255);
      m.emissive.copy(c);
      m.color.copy(c.clone().multiplyScalar(0.5).add(new THREE.Color(0x222222)));
    });
  }

  setYellow(slot: number, on: boolean) {
    const r = this.robots[slot];
    if (!r) return;
    r.yellow.emissive.set(on ? 0xffbb00 : 0x000000);
  }

  update(snap: WorldSnapshot) {
    this.last = snap;
    snap.robots.forEach((s, i) => {
      const r = this.robots[i];
      if (!r) return;
      r.root.position.set(s.pos[0], s.pos[1], s.pos[2]);
      r.root.quaternion.set(s.quat[1], s.quat[2], s.quat[3], s.quat[0]);
      // cleats move with the sprocket (pitch circle)
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const total = 2 * (Z.axleFront - Z.axleRear) + 2 * Math.PI * Z.outerRadius;
      r.cleats.forEach((im, side) => {
        const shift = s.sprocket[side] * Z.pitchRadius;
        for (let k = 0; k < im.count; k++) {
          const [x, z, rot] = trackPath((k / im.count) * total + shift);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
          m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, 1, 1));
          im.setMatrixAt(k, m);
        }
        im.instanceMatrix.needsUpdate = true;
      });
      if (this.overlayOn) {
        // prox: a fan per sensor only on hits, length roughly like the distance (6 = close), team colour
        r.proxFans.forEach((fan, k) => {
          const c = Math.max(s.prox[k * 2] ?? 0, s.prox[k * 2 + 1] ?? 0);
          fan.visible = c > 0;
          (fan.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.05 * c;
          const len = 0.36 - 0.045 * c;
          fan.scale.set(len, len, 1);
        });
        r.lineDots.forEach((dot, k) => {
          const v = s.line[k] ?? 0;
          const g = 1 - Math.min(1, v / 1024);
          (dot.material as THREE.MeshBasicMaterial).color.setRGB(0.15 + 0.85 * g, 0.15 + 0.85 * g, 0.15 + 0.85 * g);
        });
      }
    });
  }

  // ---------------------------------------------------------------- mouse: select and move robots

  private groundPoint(ev: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(this.arena?.surfaceZ ?? 0));
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (ev) => {
      const p = this.groundPoint(ev);
      if (!p || !this.last) return;
      let best = -1;
      let bestD = 0.06;
      this.last.robots.forEach((s, i) => {
        const d = Math.hypot(s.pos[0] - p.x, s.pos[1] - p.y);
        if (d < bestD) {
          best = i;
          bestD = d;
        }
      });
      if (best < 0) return;
      this.select(best);
      this.onSelect(best);
      if (ev.shiftKey || ev.altKey) {
        const q = this.last.robots[best].quat;
        this.drag = { slot: best, yaw: 2 * Math.atan2(q[3], q[0]) };
        this.controls.enabled = false;
        el.setPointerCapture(ev.pointerId);
      }
    });
    el.addEventListener("pointermove", (ev) => {
      if (!this.drag) return;
      const p = this.groundPoint(ev);
      if (p) this.onPlace(this.drag.slot, p.x, p.y, this.drag.yaw);
    });
    el.addEventListener("wheel", (ev) => {
      if (!this.drag || !this.last) return;
      ev.preventDefault();
      this.drag.yaw += ev.deltaY > 0 ? -0.2 : 0.2;
      const s = this.last.robots[this.drag.slot];
      this.onPlace(this.drag.slot, s.pos[0], s.pos[1], this.drag.yaw);
    });
    el.addEventListener("pointerup", () => {
      this.drag = null;
      this.controls.enabled = true;
    });
  }

  private followSelected() {
    if (!this.following || !this.last) return;
    const s = this.last.robots[this.selected];
    if (!s) return;
    const target = new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]);
    const delta = target.clone().sub(this.controls.target).multiplyScalar(0.25); // smooth
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  view(kind: "top" | "side" | "follow") {
    this.following = kind === "follow";
    // the whole arena in the picture, also the long line track and the free table
    const e = this.arena?.extent ?? { x0: -0.45, y0: -0.45, x1: 0.45, y1: 0.45 };
    const cx = (e.x0 + e.x1) / 2;
    const cy = (e.y0 + e.y1) / 2;
    const tanV = Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    const fit = (w: number, h: number) => Math.max(h / 2 / tanV, w / 2 / (tanV * this.camera.aspect)) * 1.08;
    if (kind === "top") {
      this.camera.position.set(cx, cy - 0.001, Math.max(0.6, fit(e.x1 - e.x0, e.y1 - e.y0)));
      this.controls.target.set(cx, cy, 0);
    } else if (kind === "side") {
      // angled from the front, just far enough back that the whole arena edge is in the picture
      // (a little room at the bottom for the help line)
      const target = new THREE.Vector3(cx, cy, 0.02);
      const dir = new THREE.Vector3(-0.04, -0.78, 0.58).normalize();
      const shape = this.arena?.shape;
      const rim =
        shape?.kind === "disc"
          ? Array.from({ length: 24 }, (_, i) => new THREE.Vector3(cx + shape.radius * Math.cos((i * Math.PI) / 12), cy + shape.radius * Math.sin((i * Math.PI) / 12), shape.height))
          : [
              [e.x0, e.y0],
              [e.x1, e.y0],
              [e.x0, e.y1],
              [e.x1, e.y1],
            ].map(([x, y]) => new THREE.Vector3(x, y, shape?.height ?? 0));
      const fits = (d: number) => {
        this.camera.position.copy(target).addScaledVector(dir, d);
        this.camera.lookAt(target);
        this.camera.updateMatrixWorld();
        return rim.every((c) => {
          const p = c.clone().project(this.camera);
          return p.z < 1 && Math.abs(p.x) <= 0.95 && p.y <= 0.92 && p.y >= -0.78;
        });
      };
      let lo = 0.2;
      let hi = 8;
      for (let i = 0; i < 24; i++) {
        const d = (lo + hi) / 2;
        if (fits(d)) hi = d;
        else lo = d;
      }
      this.camera.position.copy(target).addScaledVector(dir, hi);
      this.controls.target.copy(target);
    } else if (this.last) {
      const s = this.last.robots[this.selected];
      if (s) {
        this.controls.target.set(s.pos[0], s.pos[1], s.pos[2]);
        this.camera.position.set(s.pos[0] - 0.25, s.pos[1] - 0.25, s.pos[2] + 0.22);
      }
    }
  }
}

/** Free the GPU memory of a removed object: geometries, materials and their textures */
function disposeTree(root: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
    if (o instanceof THREE.InstancedMesh) o.dispose();
  });
  for (const m of mats) {
    for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
    m.dispose();
  }
}

/** Draw an SH1106 buffer: 8 pages of 128 bytes, bit 0 = top row of the page */
export function drawOled(canvas: HTMLCanvasElement, hex: string, inverted: boolean) {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(128, 64);
  const on = [150, 225, 255];
  const off = [6, 10, 18];
  for (let page = 0; page < 8; page++) {
    for (let x = 0; x < 128; x++) {
      const i = page * 128 + x;
      const byte = hex ? parseInt(hex.substr(i * 2, 2), 16) : 0;
      for (let b = 0; b < 8; b++) {
        const y = page * 8 + b;
        let lit = (byte >> b) & 1;
        if (inverted) lit ^= 1;
        if (!hex) lit = 0;
        const k = (y * 128 + x) * 4;
        const c = lit ? on : off;
        img.data[k] = c[0];
        img.data[k + 1] = c[1];
        img.data[k + 2] = c[2];
        img.data[k + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Builds the MuJoCo model (MJCF) from the arena and the robots.
//
// Collision groups (contype/conaffinity): world 1/1, rollers 2/1 (world only), hull 4/5 (world + other hulls).
// Tracks: four rollers per side coupled by equality constraints, one of them driven. The rollers have the
// track's outer radius (correct ground clearance); the motor model converts speed and torque to the sprocket's
// pitch circle (correct driving speed).
// geom group: 0 world, 1 hull/blade (seen by the prox rays), 2 rollers (invisible to rays)

import type { Arena, Pose } from "../shared/arenas.ts";
import { ZUMO } from "../shared/zumo-spec.ts";

export const ROLLERS_X = [0, 1, 2, 3].map((i) => ZUMO.axleRear + ((ZUMO.axleFront - ZUMO.axleRear) * i) / 3);
export const DRIVEN = 3; // front roller = drive sprocket (the motors sit at the front)

export interface RobotModelOptions {
  ballastKg?: number;
  /** multiplies the track friction (surface condition) */
  grip?: number;
  /** mean height of the blade's lower edge above the ground (default ZUMO.bladeGap) */
  bladeGap?: number;
  /** the edge is not level: height of its left end minus its right end */
  bladeTilt?: number;
}

const f = (n: number) => n.toFixed(6);

function robotBody(i: number, pose: Pose, z0: number, opt: RobotModelOptions): string {
  const p = `r${i}_`;
  const Z = ZUMO;
  const rollerMass = 0.004;
  const ballast = opt.ballastKg ?? 0;
  const mBody = Z.mass - 8 * rollerMass + ballast;
  const L = Z.front - Z.rear;
  const W = 2 * Z.halfWidth;
  const Hh = Z.height;
  const ixx = (mBody / 12) * (W * W + 0.035 * 0.035);
  const iyy = (mBody / 12) * (L * L + 0.035 * 0.035);
  const izz = (mBody / 12) * (L * L + W * W);

  // blade: inclined steel plate whose lower edge is a capsule (rounded edge) just above the ground.
  // The capsule matters for blade-on-blade hits: two box corners give MuJoCo the box's end face as contact
  // normal, which tilts 40° and lifts whichever robot owns that face (the pusher, by geom order). Two
  // capsules push along the line between their axes: horizontal at equal heights, so who gets under the
  // other is decided by pitch and height differences, as with real blade edges. Real edges are also not
  // level (bladeTilt): where the blades meet then decides which one is lower there.
  const a = (Z.bladeAngleDeg * Math.PI) / 180;
  const bl = Z.bladeLength;
  const bt = 0.002;
  const rc = bt / 2;
  const half = W / 2; // edge axis from the centre to an end (the caps reach 1 mm past the plate's corners)
  const phi = Math.asin(Math.max(-0.1, Math.min(0.1, (opt.bladeTilt ?? 0) / (2 * half)))); // roll about x
  const ex = Z.front - rc; // edge axis centre: front of the capsule at Z.front, bottom at the gap
  const ez = (opt.bladeGap ?? Z.bladeGap) + rc;
  // plate axes after euler "φ a 0" (roll about x, then pitch about the new y): its lower end face is
  // centred on the edge axis, so the capsule covers the plate's corners
  const ux = Math.cos(a);
  const uy = Math.sin(a) * Math.sin(phi);
  const uz = -Math.sin(a) * Math.cos(phi);
  const bx = ex - (bl / 2) * ux;
  const by = -(bl / 2) * uy;
  const bz = ez - (bl / 2) * uz;
  const cy = half * Math.cos(phi);
  const cz = half * Math.sin(phi);
  const bladeTopX = ex - bl * Math.cos(a);

  // hull: from the rear to the top of the blade, underside 6 mm above the ground
  const hx0 = Z.rear;
  const hx1 = bladeTopX + 0.003;
  const hz0 = 0.006;

  const rollers = (side: "l" | "r", y: number) =>
    ROLLERS_X.map(
      (x, k) => `
      <body name="${p}${side}${k}" pos="${f(x)} ${f(y)} ${f(Z.outerRadius)}">
        <joint name="${p}${side}${k}" type="hinge" axis="0 1 0" armature="${k === DRIVEN ? f(armatureAtRoller()) : "0.000001"}" damping="0"/>
        <geom type="cylinder" size="${f(Z.outerRadius)} ${f(Z.trackWidth / 2)}" euler="90 0 0" mass="${rollerMass}"
              friction="${f(Z.trackMu * (opt.grip ?? 1))} 0.005 0.0001" condim="3" contype="2" conaffinity="1" group="2"/>
      </body>`,
    ).join("");

  const c = Math.cos(pose.yaw / 2);
  const s = Math.sin(pose.yaw / 2);
  return `
    <body name="${p}chassis" pos="${f(pose.x)} ${f(pose.y)} ${f(z0 + 0.0005)}" quat="${f(c)} 0 0 ${f(s)}">
      <freejoint name="${p}free"/>
      <inertial pos="${f(Z.comX)} 0 ${f(Z.comZ)}" mass="${f(mBody)}" diaginertia="${ixx.toExponential(4)} ${iyy.toExponential(4)} ${izz.toExponential(4)}"/>
      <geom name="${p}hull" type="box" size="${f((hx1 - hx0) / 2)} ${f(W / 2)} ${f((Hh - hz0) / 2)}"
            pos="${f((hx0 + hx1) / 2)} 0 ${f((Hh + hz0) / 2)}" mass="0" friction="${Z.hullMu} 0.005 0.0001"
            contype="4" conaffinity="5" group="1"/>
      <geom name="${p}blade" type="box" size="${f(bl / 2)} ${f(W / 2)} ${f(bt / 2)}" pos="${f(bx)} ${f(by)} ${f(bz)}"
            euler="${f((phi * 180) / Math.PI)} ${f(Z.bladeAngleDeg)} 0" mass="0" friction="${Z.hullMu} 0.005 0.0001"
            contype="4" conaffinity="5" group="1"/>
      <geom name="${p}bladetip" type="capsule" size="${f(rc)}" fromto="${f(ex)} ${f(-cy)} ${f(ez - cz)} ${f(ex)} ${f(cy)} ${f(ez + cz)}"
            mass="0" friction="${Z.hullMu} 0.005 0.0001" contype="4" conaffinity="5" group="1"/>
      <site name="${p}imu" pos="0 0 0.02"/>
      ${rollers("l", Z.trackY)}${rollers("r", -Z.trackY)}
    </body>`;
}

/** Rotor inertia of the motor, converted to the roller (outer radius) */
export function armatureAtRoller(): number {
  const m = ZUMO.motor;
  const atSprocket = m.rotorInertia * m.ratio * m.ratio;
  const k = ZUMO.outerRadius / ZUMO.pitchRadius;
  return atSprocket * k * k;
}

export function buildMjcf(arena: Arena, poses: Pose[], opts: RobotModelOptions[] = []): string {
  const z0 = arena.surfaceZ;
  const bodies = poses.map((pose, i) => robotBody(i, pose, z0, opts[i] ?? {})).join("");
  const eq = poses
    .map((_, i) =>
      ["l", "r"]
        .map((side) =>
          [0, 1, 2, 3]
            .filter((k) => k !== DRIVEN)
            .map((k) => `<joint joint1="r${i}_${side}${k}" joint2="r${i}_${side}${DRIVEN}"/>`)
            .join(""),
        )
        .join(""),
    )
    .join("\n    ");
  const act = poses
    .map((_, i) => `<motor name="r${i}_ml" joint="r${i}_l${DRIVEN}"/><motor name="r${i}_mr" joint="r${i}_r${DRIVEN}"/>`)
    .join("\n    ");
  const sens = poses
    .map((_, i) => `<accelerometer name="r${i}_acc" site="r${i}_imu"/><gyro name="r${i}_gyro" site="r${i}_imu"/>`)
    .join("\n    ");
  return `<mujoco model="spark">
  <compiler angle="degree"/>
  <option timestep="0.001" integrator="implicitfast"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1" friction="0.1 0.005 0.0001" contype="1" conaffinity="1" group="0"/>
    ${arena.mjcf()}
    ${bodies}
  </worldbody>
  <equality>
    ${eq}
  </equality>
  <actuator>
    ${act}
  </actuator>
  <sensor>
    ${sens}
  </sensor>
</mujoco>`;
}

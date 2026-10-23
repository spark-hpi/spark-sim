// Numbers of the Pololu Zumo 2040. The source is noted next to every value:
//   DB    datasheet / Pololu product page / Pololu library
//   STEP  zumo-2040-robot.step (Pololu), measured in the old sim (02_triathlon/tracking/sim/kontur_aus_step.py)
//   DER   derived from the above (calculation in the comment)
//   EST   estimate — must be calibrated on a real robot (measurement protocol)
// Robot frame: x forward, y left, z up; origin = STEP origin at ground level.

export const ZUMO = {
  // --- Geometry
  rear: -0.0373, // STEP
  front: 0.0589, // STEP: front edge of the blade
  halfWidth: 0.0495, // STEP
  height: 0.04, // EST: top of the main board with display
  axleRear: -0.0178, // STEP
  axleFront: 0.0302, // STEP: 48 mm axle distance
  trackY: 0.0422, // STEP: track centre line
  trackWidth: 0.0146, // STEP
  pitchRadius: 0.0171, // DER: pitch circle 34.2 mm (22T sprocket, 9.25 mm pitch)
  outerRadius: 0.0195, // STEP: track outside 39 mm
  bladeGap: 0.0004, // STEP: blade lower edge above ground
  bladeGapSpread: 0.0001, // EST: unit-to-unit spread of that height (mounting), 1 sigma
  bladeTiltSpread: 0.0003, // EST: the edge is not level: left end minus right end (bent blade), 1 sigma
  bladeAngleDeg: 40, // EST: blade incline against the ground
  bladeLength: 0.024, // EST: length of the inclined blade face

  // --- Mass
  mass: 0.275, // DB: with 4 AA cells (not weighed)
  comX: 0.007, // EST: centre of mass ahead of the centre
  comZ: 0.016, // EST

  // --- Motor 75:1 HPCB 6 V (#3074), values at the gearbox output at 6 V
  motor: {
    ratio: 75.81, // DB
    noLoadRpm: 430, // DB
    noLoadA: 0.15, // DB
    stallA: 1.5, // DB
    stallNm: 1.1 * 0.0980665, // DB: 1.1 kg·cm
    rotorInertia: 2.5e-8, // EST: kg·m² at the motor, × ratio² at the output
    spread: 0.04, // EST: unit-to-unit spread of motor strength (1 sigma)
  },
  maxSpeed: 6000, // DB: Motors.MAX_SPEED
  encoderCpr: 12 * 75.81, // DB: 909.7 counts per output revolution

  // --- Battery 4 × AA NiMH
  battery: {
    vFull: 5.2, // EST: 1.3 V/cell freshly charged
    vEmpty: 4.6, // EST
    rInternal: 0.15, // EST: ohm, all cells + switch
    capacityAh: 2.0, // EST
    logicA: 0.08, // EST: electronics
  },

  // --- Friction
  trackMu: 1.0, // EST: silicone track on melamine (protocol: PUSH, tilt test)
  hullMu: 0.4, // EST: steel/plastic against an opponent

  // --- Line sensors DN1 (left) … DN5 (right)
  lineSensors: [0.035, 0.0175, 0.0, -0.0175, -0.035].map((y) => [0.047, y] as const), // EST from photo/STEP
  lineSensorZ: 0.003, // EST: underside of the sensor array above ground
  lineTimeout: 1024, // DB: ir_sensors.TIMEOUT
  lineWhite: 110, // EST: raw value on white melamine
  lineGainSpread: 0.08, // EST: per-sensor sensitivity spread
  lineSpotSigma: 0.0012, // EST: each sensor sees a light spot, not a point (≈ 5 mm across at 3 mm height)

  // --- Proximity: three 56 kHz receivers on the front sensor array, four IR LEDs in two groups on the main board
  proxSensorZ: 0.013, // EST: receivers sit low on the front array (sees the opponent's blade)
  proxLedZ: 0.022, // EST: LEDs on the main board
  proxSensors: [
    { name: "left", pos: [0.045, 0.043], dir: 90 },
    { name: "front", pos: [0.052, 0.0], dir: 0 },
    { name: "right", pos: [0.045, -0.043], dir: -90 },
  ], // STEP / guide 6.6
  proxLeds: {
    left: [
      { pos: [0.0435, 0.0284], dir: 0, half: 25 }, // STEP; clear 50° LED (assembled version)
      { pos: [0.006, 0.033], dir: 90, half: 60 }, // guide 6.6
    ],
    right: [
      { pos: [0.0435, -0.0284], dir: 0, half: 25 },
      { pos: [0.006, -0.033], dir: -90, half: 60 },
    ],
  },
  proxLevels: [313, 1000, 2063, 3500, 5375, 7563], // DB: DEFAULT_BRIGHTNESS_LEVELS
  proxRange: 0.35, // guide 6.6 (30–40 cm): a frontal Zumo is seen up to here at the brightest level
  proxFov: 75, // EST: receiver half angle
  proxRayStep: 2.5, // degrees
  proxMaxDist: 0.8,
  proxNoise: 0.15, // EST: flicker (lognormal sigma)
  // Reflectance at 940 nm (EST): steel blade, black track, housing, white walls
  reflect: { blade: 1.0, track: 0.3, hull: 0.4, wall: 1.2 },

  // --- IMU (LSM6DSO + LIS3MDL)
  imuNoise: { acc: 0.02, gyro: 0.3, gyroBias: 0.5, mag: 0.01 }, // EST: g, dps, dps, gauss
  earthField: [0.2, 0.0, -0.44], // EST: gauss, central Europe (north = +x of the world)
} as const;

/** CPU time on the RP2040 (125 MHz) in µs. EST — measure with messung/zumo_messung.py on a real Zumo. */
export const COST_US = {
  pythonBytecode: 1.7, // per executed bytecode (≈ 6 µs per typical line); counted by the VM hook
  motors: 15,
  lineRead: 1060, // DB: PIO charges 32 µs, then always counts the full 1023 µs window (ir_sensors.py)
  proxOverhead: 150, // EST: Python pin handling around the 12 pulses
  imuPerSensor: 250, // EST: 6-byte I2C read at 400 kHz + driver overhead
  enc: 40,
  battery: 120,
  display: 4000,
  leds: 60,
  quantum: 1000, // a program syncs with the world after at most this much CPU time
};

/**
 * MicroPython heap in bytes (hard limit, MemoryError beyond it). EST: the RP2040 port leaves ~192 KB for the
 * heap; the simulator additionally compiles its runtime modules into the heap (~20 KB more than the robot,
 * where the Pololu library is compiled from .py files too). Measure gc.mem_free() at program start on a robot.
 */
export const HEAP_BYTES = 212 * 1024;

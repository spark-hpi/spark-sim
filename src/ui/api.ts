// Reference of the simulated `zumo_2040_robot` API. Drives the Docs reference pages, editor autocompletion and
// hover tooltips. Timings are robot time on the RP2040 as modelled by the simulator (see src/shared/zumo-spec.ts),
// measured with real programs in the simulator; sensor durations follow the hardware, Python overhead is estimated.

export interface ApiMember {
  name: string;
  sig: string;
  doc: string;
  kind?: "method" | "property" | "constant";
  /** what the call returns (shown as "returns …") */
  returns?: string;
  /** robot time one call takes (shown as "takes …") */
  timing?: string;
  /** parameter name -> explanation */
  params?: [name: string, doc: string][];
  /** short MicroPython snippet */
  example?: string;
}

export interface ApiClass {
  name: string;
  ctor: string;
  doc: string;
  members: ApiMember[];
  /** complete, runnable MicroPython example */
  example?: string;
}

const BUTTON_MEMBERS: ApiMember[] = [
  {
    name: "check",
    sig: "check() -> True | False | None",
    doc: "Debounced events (10 ms): returns `True` once when the button goes down, `False` once when it comes up, and `None` the rest of the time. Call it often, e.g. `while not button_a.check():`. Never write `check() == False` to wait for a press: most calls return `None`.",
    returns: "True (pressed), False (released) or None (no change)",
    timing: "≈ 0.08 ms",
  },
  {
    name: "is_pressed",
    sig: "is_pressed() -> bool",
    doc: "The current state, not debounced.",
    returns: "bool",
    timing: "≈ 0.04 ms",
  },
  {
    name: "is_long_pressed",
    sig: "is_long_pressed() -> bool",
    doc: "`True` once the button has been held for more than `long_press_ms` (750 ms), counted from the last call that saw it released. Call it repeatedly; it becomes `False` again after the release.",
    returns: "bool",
  },
  { name: "debounce_ms", sig: "debounce_ms = 10", doc: "Debounce time of `check()` in ms.", kind: "property" },
  { name: "long_press_ms", sig: "long_press_ms = 750", doc: "Hold time for `is_long_pressed()` in ms.", kind: "property" },
];

const BUTTON_EXAMPLE = `from zumo_2040_robot import robot
import time

button_a = robot.ButtonA()
display = robot.Display()

display.fill(0)
display.text("Press A", 0, 0)
display.show()
while not button_a.check():   # True once per press
    time.sleep_ms(10)

display.fill(0)
display.text("Pressed!", 0, 0)
display.show()
`;

/** Members of one IMU sensor (acc, gyro, mag), written with the sensor prefix: `acc.read`, … */
function imuSensor(
  s: "acc" | "gyro" | "mag",
  unit: string,
  what: string,
  rates: string,
  ranges: string,
  dflt: string,
  extra: string,
): ApiMember[] {
  return [
    {
      name: `${s}.read`,
      sig: `${s}.read()`,
      doc: `Read the ${what} only and update \`${s}.last_reading_${unit}\` and \`${s}.last_reading_raw\`.`,
      timing: "≈ 0.27 ms",
    },
    {
      name: `${s}.last_reading_${unit}`,
      sig: `${s}.last_reading_${unit} -> [x, y, z]`,
      doc: `Values of the last read in ${unit === "dps" ? "°/s" : unit}; \`[None, None, None]\` before the first read and \`[0.0, 0.0, 0.0]\` while the sensor is off. ${extra}`,
      kind: "property",
    },
    {
      name: `${s}.last_reading_raw`,
      sig: `${s}.last_reading_raw -> [x, y, z]`,
      doc: "Raw 16-bit values (−32768 … 32767) of the last read. They saturate at the end of the full-scale range.",
      kind: "property",
    },
    {
      name: `${s}.data_ready`,
      sig: `${s}.data_ready() -> bool`,
      doc: `\`True\` when the sensor has measured a new sample since your last read. New samples come at the output data rate (${dflt} after \`enable_default()\`).`,
      returns: "bool",
      timing: "≈ 0.2 ms (one I2C register read)",
    },
    {
      name: `${s}.set_output_data_rate`,
      sig: `${s}.set_output_data_rate(hz)`,
      doc: `How often the sensor measures. Allowed: ${rates} Hz; any other value raises \`ValueError\`.`,
      params: [["hz", rates]],
    },
    {
      name: `${s}.set_full_scale`,
      sig: `${s}.set_full_scale(range)`,
      doc: `Measuring range: ${ranges}; other values raise \`ValueError\`. A larger range saturates later but has coarser steps.`,
      params: [["range", ranges]],
    },
  ];
}

export const ROBOT_API: ApiClass[] = [
  {
    name: "Motors",
    ctor: "robot.Motors()",
    doc: "Two DRV8838 drivers with 75:1 gearmotors. A speed is a PWM duty cycle from −6000 (full reverse) to 6000 (full forward), not a velocity: the real speed depends on the battery and the load. Top speed ≈ 0.65 m/s on fresh batteries; below about ±1000 the robot hardly moves. Creating `Motors()` stops the motors, and all `Motors()` objects drive the same two motors.",
    example: `from zumo_2040_robot import robot
import time

motors = robot.Motors()
motors.set_speeds(3000, 3000)    # forward, half power
time.sleep_ms(1000)              # about 27 cm in the simulator
motors.set_speeds(-3000, 3000)   # left track back, right forward: turn left
time.sleep_ms(420)               # about 90 degrees in the simulator
motors.off()
`,
    members: [
      {
        name: "set_speeds",
        sig: "set_speeds(left, right)",
        doc: "Set both motors at once. Values are rounded and clamped to ±6000, so floats are fine. The motors keep this speed until you set another one, even after your program has ended.",
        params: [
          ["left", "−6000 … 6000, left track (positive = forward)"],
          ["right", "−6000 … 6000, right track"],
        ],
        timing: "≈ 0.17 ms",
      },
      {
        name: "set_left_speed",
        sig: "set_left_speed(speed)",
        doc: "Set the left motor only; the right one keeps its speed.",
        params: [["speed", "−6000 … 6000"]],
      },
      {
        name: "set_right_speed",
        sig: "set_right_speed(speed)",
        doc: "Set the right motor only; the left one keeps its speed.",
        params: [["speed", "−6000 … 6000"]],
      },
      {
        name: "off",
        sig: "off()",
        doc: "Same as `set_speeds(0, 0)`. Speed 0 brakes (the driver shorts the motor): from full speed the robot stops within about 4 cm; reversing at full power instead stops it within about 2 cm.",
      },
      {
        name: "flip_left",
        sig: "flip_left(flip)",
        doc: "`flip_left(True)` inverts the left motor's direction for all later calls. Only needed if a motor is wired the other way round.",
        params: [["flip", "True = invert, False = normal"]],
      },
      {
        name: "flip_right",
        sig: "flip_right(flip)",
        doc: "`flip_right(True)` inverts the right motor's direction for all later calls.",
        params: [["flip", "True = invert, False = normal"]],
      },
      { name: "MAX_SPEED", sig: "MAX_SPEED = 6000", doc: "Largest speed value (`robot.Motors.MAX_SPEED`).", kind: "constant" },
    ],
  },
  {
    name: "LineSensors",
    ctor: "robot.LineSensors()",
    doc: "Five downward IR reflectance sensors DN1 (left) … DN5 (right) in a row 4.7 cm ahead of the robot's centre, 17.5 mm apart (the outer ones 3.5 cm to the side). A raw value is a discharge time: bright surfaces give small values (white ≈ 110, grey ≈ 300), dark ones large values up to 1024 (black, or nothing below: a lifted sensor reads 1024 too). Each sensor sees a light spot of about 5 mm, so a tape edge gives values in between.",
    example: `from zumo_2040_robot import robot
import time

line = robot.LineSensors()
while True:
    v = line.read()
    print("DN1", v[0], "DN2", v[1], "DN3", v[2], "DN4", v[3], "DN5", v[4])
    time.sleep_ms(200)
`,
    members: [
      {
        name: "read",
        sig: "read() -> array('H', 5)",
        doc: "Measure all five sensors with the IR emitters on. Returns the **same array object** on every call (`read_calibrated()` fills it too), so copy it with `list(...)` if you want to keep old values.",
        returns: "array('H') of 5 raw values, 0 … 1024",
        timing: "≈ 1.06 ms on any surface",
      },
      {
        name: "read_calibrated",
        sig: "read_calibrated() -> array('H', 5)",
        doc: "Read and scale every sensor between its calibrated minimum (0) and maximum (1000). A sensor whose maximum is not above its minimum (it never saw a difference while you calibrated) always returns 0.",
        returns: "array('H') of 5 values, 0 (white) … 1000 (black); the same array as read()",
        timing: "≈ 1.06 ms",
      },
      {
        name: "calibrate",
        sig: "calibrate()",
        doc: "Read all sensors 10 times and widen the calibration: each maximum grows to the smallest of these 10 readings, each minimum shrinks to the largest of them, so a single noisy reading cannot spoil it. Call it over and over while the robot turns, so that every sensor sees both the line and the background for the whole call.",
        timing: "≈ 14 ms (10 reads)",
      },
      { name: "reset_calibration", sig: "reset_calibration()", doc: "Forget the calibration (minimum 1025, maximum 0 for every sensor)." },
      {
        name: "cal_min",
        sig: "cal_min -> array('H', 5)",
        doc: "Calibrated minimum per sensor. After a good calibration it is close to the white value (≈ 110).",
        kind: "property",
      },
      {
        name: "cal_max",
        sig: "cal_max -> array('H', 5)",
        doc: "Calibrated maximum per sensor. After a good calibration it is close to 1024 for every sensor; if not, the sweep was too small.",
        kind: "property",
      },
      {
        name: "start_read",
        sig: "start_read(emitters_on=True)",
        doc: "Choose the emitter setting for the next `read()`. With `emitters_on=False` the sensors only see ambient IR; the simulator has no ambient light, so all five then read 1024. In the simulator the measurement itself happens in `read()`.",
        params: [["emitters_on", "True = IR emitters on (normal), False = off"]],
      },
    ],
  },
  {
    name: "ProximitySensors",
    ctor: "robot.ProximitySensors()",
    doc: "Three IR receivers on the front sensor array (left, front, right) and two groups of IR LEDs (left, right). `read()` flashes each LED group at 6 brightness levels and counts at how many levels each receiver saw a reflection: 0 = nothing, 6 = very close or very bright. A Zumo facing you gives 6 up to about 5 cm, 4 at 15–20 cm, 1 at about 30 cm and 0 beyond about 34 cm. Robots' steel blades reflect best, their dark tracks worst.",
    example: `from zumo_2040_robot import robot
import time

prox = robot.ProximitySensors()
while True:
    prox.read()
    print("left", prox.left_counts_with_left_leds(),
          "fl", prox.front_counts_with_left_leds(),
          "fr", prox.front_counts_with_right_leds(),
          "right", prox.right_counts_with_right_leds())
    time.sleep_ms(100)
`,
    members: [
      {
        name: "read",
        sig: "read()",
        doc: "Measure everything: 2 LED groups × 6 levels. The robot keeps moving during the read; the counts describe the scene about halfway through it. Afterwards the `…_counts_…` methods return the new values.",
        timing: "≈ 7.0 ms (6.85 ms of IR pulses)",
      },
      {
        name: "front_counts_with_left_leds",
        sig: "front_counts_with_left_leds() -> 0..6",
        doc: "Front sensor, lit by the left LEDs. Larger than `front_counts_with_right_leds()` → the object is a bit to the left.",
        returns: "int 0 … 6",
      },
      {
        name: "front_counts_with_right_leds",
        sig: "front_counts_with_right_leds() -> 0..6",
        doc: "Front sensor, lit by the right LEDs. Larger than the left-LED count → the object is a bit to the right.",
        returns: "int 0 … 6",
      },
      {
        name: "left_counts_with_left_leds",
        sig: "left_counts_with_left_leds() -> 0..6",
        doc: "Left side sensor with the left LEDs: the pair that sees objects at your left (a Zumo next to you up to about 30 cm).",
        returns: "int 0 … 6",
      },
      {
        name: "left_counts_with_right_leds",
        sig: "left_counts_with_right_leds() -> 0..6",
        doc: "Left side sensor with the right LEDs; usually 0, the right LEDs hardly light the left side.",
        returns: "int 0 … 6",
      },
      {
        name: "right_counts_with_right_leds",
        sig: "right_counts_with_right_leds() -> 0..6",
        doc: "Right side sensor with the right LEDs: the pair that sees objects at your right.",
        returns: "int 0 … 6",
      },
      {
        name: "right_counts_with_left_leds",
        sig: "right_counts_with_left_leds() -> 0..6",
        doc: "Right side sensor with the left LEDs; usually 0.",
        returns: "int 0 … 6",
      },
      {
        name: "counts_with_left_leds",
        sig: "counts_with_left_leds(sensor) -> 0..6",
        doc: "Count of one sensor with the left LEDs.",
        params: [["sensor", "0 = left, 1 = front, 2 = right"]],
        returns: "int 0 … 6",
      },
      {
        name: "counts_with_right_leds",
        sig: "counts_with_right_leds(sensor) -> 0..6",
        doc: "Count of one sensor with the right LEDs.",
        params: [["sensor", "0 = left, 1 = front, 2 = right"]],
        returns: "int 0 … 6",
      },
      { name: "total_counts", sig: "total_counts() -> int", doc: "Sum of all six counts (0 … 36).", returns: "int" },
      {
        name: "angle_estimate",
        sig: "angle_estimate() -> degrees",
        doc: "Rough bearing of the object from all counts: −90 = left … 0 = ahead … +90 = right; 0 also when nothing is seen. Note the sign: the gyro counts left as positive.",
        returns: "int −90 … 90",
      },
      {
        name: "brightness_levels",
        sig: "brightness_levels = [313, 1000, 2063, 3500, 5375, 7563]",
        doc: "LED brightness levels used by `read()`. Assign a shorter list for faster reads: every level adds about 1.14 ms, and the counts then go up to the number of levels (the simulator uses at most 8).",
        kind: "property",
      },
      {
        name: "counts",
        sig: "counts -> [[l_left, l_right], [f_left, f_right], [r_left, r_right]]",
        doc: "All six counts of the last `read()`: per sensor (left, front, right) the counts with the left and the right LEDs.",
        kind: "property",
      },
      {
        name: "set_frequency",
        sig: "set_frequency(hz)",
        doc: "Carrier frequency of the IR pulses (default 56000). It changes the pulse timing and so the read time; the simulator does not model how sensitive the receivers are at other frequencies, so leave it at 56 kHz.",
        params: [["hz", "pulse frequency in Hz"]],
      },
    ],
  },
  {
    name: "IMU",
    ctor: "robot.IMU()",
    doc: "LSM6DSO (accelerometer + gyro) and LIS3MDL (magnetometer). Axes: x forward, y left, z up, so turning left gives a positive gyro z and standing still gives about +1 g on acc z. Everything reads 0 until you call `reset()` and `enable_default()`. Each sensor measures at its output data rate (ODR); `data_ready()` tells you when a new sample exists.",
    example: `from zumo_2040_robot import robot
import time

imu = robot.IMU()
imu.reset()
imu.enable_default()     # acc 52 Hz ±2 g, gyro 208 Hz ±2000 °/s, mag 10 Hz ±4 gauss

while True:
    if imu.gyro.data_ready():
        imu.gyro.read()
        imu.acc.read()
        print("turn: %.1f fwd_g: %.2f" % (imu.gyro.last_reading_dps[2], imu.acc.last_reading_g[0]))
    time.sleep_ms(50)
`,
    members: [
      { name: "reset", sig: "reset()", doc: "Switch all three sensors off (they read 0 until enabled again). Call it before `enable_default()`." },
      {
        name: "enable_default",
        sig: "enable_default()",
        doc: "Accelerometer 52 Hz ±2 g, gyro 208 Hz ±2000 °/s, magnetometer 10 Hz ±4 gauss.",
      },
      {
        name: "read",
        sig: "read()",
        doc: "Read gyro, accelerometer and magnetometer in one go and update all their `last_reading_…` lists. If you only need one sensor, read just that one (`imu.gyro.read()`), it is three times faster.",
        timing: "≈ 0.77 ms (3 sensors)",
      },
      { name: "detect", sig: "detect() -> bool", doc: "`True` if the IMU answers (always in the simulator).", returns: "bool" },
      { name: "acc", sig: "acc", doc: "The accelerometer (g): `acc.read()`, `acc.last_reading_g`, `acc.data_ready()` … see below.", kind: "property" },
      { name: "gyro", sig: "gyro", doc: "The gyro (°/s): `gyro.read()`, `gyro.last_reading_dps`, `gyro.data_ready()` … see below.", kind: "property" },
      { name: "mag", sig: "mag", doc: "The magnetometer (gauss): `mag.read()`, `mag.last_reading_gauss`, `mag.data_ready()` … see below.", kind: "property" },
      ...imuSensor(
        "acc",
        "g",
        "accelerometer",
        "0 (off), 12.5, 26, 52, 104, 208, 416, 833, 1666, 3332, 6664",
        "2, 4, 8 or 16 g",
        "52 Hz",
        "At rest about [0, 0, 1]. Accelerating forward or being hit from behind gives positive x. Readings saturate at the full scale (±2 g by default); use `acc.set_full_scale(16)` to measure hard hits.",
      ),
      ...imuSensor(
        "gyro",
        "dps",
        "gyro",
        "0 (off), 12.5, 26, 52, 104, 208, 416, 833, 1666, 3332, 6664",
        "125, 250, 500, 1000 or 2000 °/s",
        "208 Hz",
        "z > 0 = turning left (counter-clockwise seen from above). Every robot has a small bias (about 0.5 °/s in the simulator): measure it while standing still and subtract it.",
      ),
      ...imuSensor(
        "mag",
        "gauss",
        "magnetometer",
        "0.625, 1.25, 2.5, 5, 10, 20, 40, 80",
        "4, 8, 12 or 16 gauss",
        "10 Hz",
        "The simulator models a constant earth field plus a small per-robot offset.",
      ),
    ],
  },
  {
    name: "Encoders",
    ctor: "robot.Encoders()",
    doc: "Quadrature encoders on both motor shafts: 909.7 counts per sprocket revolution, about 8470 counts per metre of track travel (1 count ≈ 0.12 mm). They measure the sprockets, not the ground: when the tracks slip or skid (pushing, turning on the spot), the counts keep going.",
    example: `from zumo_2040_robot import robot
import time

motors = robot.Motors()
encoders = robot.Encoders()

encoders.get_counts(reset=True)
motors.set_speeds(3000, 3000)
while True:
    left, right = encoders.get_counts()
    if (left + right) // 2 >= 1694:      # 20 cm * 8470 counts per metre
        break
motors.off()
print("counts", encoders.get_counts())
`,
    members: [
      {
        name: "get_counts",
        sig: "get_counts(reset=False) -> (left, right)",
        doc: "Counts since the start or since the last reset; forward = positive. With `reset=True` you still get the counts, and both counters restart at 0.",
        params: [["reset", "True = restart both counters after reading"]],
        returns: "tuple (left, right) of ints",
        timing: "≈ 0.06 ms",
      },
      { name: "flip", sig: "flip(flip)", doc: "`flip(True)` inverts the sign of both counts.", params: [["flip", "True = invert, False = normal"]] },
    ],
  },
  {
    name: "Display",
    ctor: "robot.Display()",
    doc: "128 × 64 pixel OLED (SH1106). `Display` is a MicroPython `framebuf.FrameBuffer`: every drawing call only changes a buffer in memory, and nothing appears until you call `show()`. The built-in font is 8 × 8 pixels: 16 characters per line, 8 lines. Colour 1 = lit, 0 = dark. Creating `Display()` clears the screen.",
    example: `from zumo_2040_robot import robot

display = robot.Display()
display.fill(0)                          # clear the buffer
display.text("SPARK", 0, 0)              # 8x8 font, x and y in pixels
display.rect(0, 12, 128, 10, 1)          # frame of a bar graph
display.fill_rect(2, 14, 80, 6, 1)       # the bar
display.show()                           # now it appears (about 4 ms)
`,
    members: [
      { name: "show", sig: "show()", doc: "Send the buffer to the display. Draw everything first, then call `show()` once.", timing: "≈ 4 ms" },
      { name: "fill", sig: "fill(c)", doc: "Fill the whole buffer: 0 = clear, 1 = all lit.", params: [["c", "0 or 1"]] },
      {
        name: "text",
        sig: "text(s, x, y, c=1)",
        doc: "Write a string with the 8 × 8 font; (x, y) is its top-left corner. Text beyond the right edge is cut off.",
        params: [
          ["s", "string"],
          ["x, y", "top-left corner in pixels (0 … 127, 0 … 63)"],
          ["c", "colour, 1 = lit (default), 0 = dark"],
        ],
      },
      { name: "pixel", sig: "pixel(x, y, c=None)", doc: "Set one pixel, or with no `c` return its colour.", returns: "0 or 1 when c is omitted" },
      { name: "hline", sig: "hline(x, y, w, c)", doc: "Horizontal line of width w." },
      { name: "vline", sig: "vline(x, y, h, c)", doc: "Vertical line of height h." },
      { name: "line", sig: "line(x1, y1, x2, y2, c)", doc: "Line between two points." },
      { name: "rect", sig: "rect(x, y, w, h, c, f=False)", doc: "Rectangle outline; `f=True` fills it." },
      { name: "fill_rect", sig: "fill_rect(x, y, w, h, c)", doc: "Filled rectangle." },
      { name: "ellipse", sig: "ellipse(x, y, xr, yr, c, f=False)", doc: "Ellipse (or circle with xr = yr) around (x, y); `f=True` fills it." },
      { name: "poly", sig: "poly(x, y, coords, c, f=False)", doc: "Polygon from an `array('h', [x0, y0, x1, y1, …])`, offset by (x, y)." },
      { name: "scroll", sig: "scroll(dx, dy)", doc: "Shift the buffer contents by dx, dy pixels." },
      { name: "blit", sig: "blit(fbuf, x, y, key=-1)", doc: "Copy another FrameBuffer into this one; pixels of colour `key` are transparent." },
      { name: "invert", sig: "invert(flag)", doc: "Invert the whole display (takes effect at once, the buffer is unchanged).", params: [["flag", "True = inverted"]] },
      {
        name: "flip",
        sig: "flip(flag=None, update=True)",
        doc: "Turn the picture by 180°. The display is mounted rotated, so `flip(True)` is the normal orientation and `flip(False)` shows the picture upside down; `flip()` without a flag toggles. `update=True` calls `show()`.",
      },
      { name: "poweroff", sig: "poweroff()", doc: "Switch the display off (the buffer is kept)." },
      { name: "poweron", sig: "poweron()", doc: "Switch it on again." },
      { name: "sleep", sig: "sleep(value)", doc: "`sleep(True)` is `poweroff()`, `sleep(False)` is `poweron()`." },
      { name: "contrast", sig: "contrast(value)", doc: "Display contrast; has no visible effect in the simulator." },
      {
        name: "show_exception",
        sig: "Display.show_exception(e)",
        doc: "Clear the display and show an exception's type and message. The simulator does this automatically when your program stops with an error, like the robot's firmware.",
      },
      { name: "width", sig: "width = 128", doc: "Width in pixels.", kind: "constant" },
      { name: "height", sig: "height = 64", doc: "Height in pixels.", kind: "constant" },
    ],
  },
  {
    name: "ButtonA",
    ctor: "robot.ButtonA()",
    doc: "The user buttons A, B and C: `robot.ButtonB()` and `robot.ButtonC()` work the same. In the simulator, click A/B/C in the inspector or hold the keys A, B, C (they act on the selected robot); **⚑ Start** (key S) presses A on every robot at once, like the referee's start signal (**Auto start** does it 0.2 s after Run). Button B can also be read with `rp2.bootsel_button()`.",
    example: BUTTON_EXAMPLE,
    members: BUTTON_MEMBERS,
  },
  {
    name: "ButtonB",
    ctor: "robot.ButtonB()",
    doc: "User button B; works like `ButtonA`. In the simulator: the B button in the inspector or the key B.",
    members: BUTTON_MEMBERS,
  },
  {
    name: "ButtonC",
    ctor: "robot.ButtonC()",
    doc: "User button C; works like `ButtonA`. In the simulator: the C button in the inspector or the key C.",
    members: BUTTON_MEMBERS,
  },
  {
    name: "RGBLEDs",
    ctor: "robot.RGBLEDs()",
    doc: "Six APA102 RGB LEDs, numbered 0 … 5. Set colours, then call `show()`. In the 3D view LEDs 0–2 sit at the rear and 3–5 at the front. Creating `RGBLEDs()` switches them all off.",
    example: `from zumo_2040_robot import robot

leds = robot.RGBLEDs()
leds.set_brightness(8)            # 0 … 31 for all LEDs
for i in range(6):
    leds.set_hsv(i, [i * 60, 255, 255])   # a rainbow
leds.show()
`,
    members: [
      {
        name: "set",
        sig: "set(led, [r, g, b])",
        doc: "Set one LED's colour; it appears at the next `show()`.",
        params: [
          ["led", "0 … 5"],
          ["[r, g, b]", "0 … 255 each"],
        ],
        timing: "≈ 0.1 ms",
      },
      { name: "get", sig: "get(led) -> [r, g, b]", doc: "The colour set for one LED.", returns: "list [r, g, b]" },
      {
        name: "set_hsv",
        sig: "set_hsv(led, [h, s, v], h_scale=360)",
        doc: "Set a colour as hue, saturation, value.",
        params: [
          ["h", "hue 0 … 359 (0 red, 120 green, 240 blue), or 0 … h_scale − 1"],
          ["s, v", "saturation and value 0 … 255"],
        ],
      },
      { name: "hsv2rgb", sig: "hsv2rgb(h, s, v, h_scale=360) -> [r, g, b]", doc: "Convert HSV to an [r, g, b] list.", returns: "list [r, g, b]" },
      {
        name: "set_brightness",
        sig: "set_brightness(value, led=None)",
        doc: "Global brightness 0 … 31 for all LEDs, or for one LED. Default 31.",
        params: [
          ["value", "0 … 31"],
          ["led", "None = all, or 0 … 5"],
        ],
      },
      { name: "get_brightness", sig: "get_brightness(led=0) -> int", doc: "Brightness of one LED (0 … 31).", returns: "int" },
      { name: "show", sig: "show()", doc: "Send the colours to the LEDs.", timing: "≈ 0.08 ms" },
      { name: "off", sig: "off()", doc: "Set all LEDs to black and show it." },
    ],
  },
  {
    name: "Buzzer",
    ctor: "robot.Buzzer()",
    doc: "Piezo buzzer with Pololu's music language: notes `c d e f g a b`, rests `r`, and commands for tempo (`T`), note length (`L`), octave (`O`, `>`, `<`), volume (`V`) and staccato (`MS`/`ML`). Example: `play('T240 L8 cdefg')`. The simulator plays it through your speakers (Sound toggle, volume in ⚙).",
    example: `from zumo_2040_robot import robot
import time

buzzer = robot.Buzzer()
buzzer.play_in_background("T180 L8 V12 cegc>c")   # returns at once
while buzzer.is_playing():
    time.sleep_ms(10)
buzzer.play("!L16 a r a")   # blocks until finished
`,
    members: [
      {
        name: "play",
        sig: "play(notes)",
        doc: "Play a melody and **block** until it has finished. Your robot cannot react meanwhile; in a match use `play_in_background()`.",
        params: [["notes", "string in the music language, see the Buzzer page"]],
      },
      {
        name: "play_in_background",
        sig: "play_in_background(notes)",
        doc: "Start a melody and return at once. A new melody replaces the one that is playing.",
        params: [["notes", "string in the music language"]],
        timing: "≈ 1.5 ms for a short melody like \"!L16 V15 >a\", ≈ 2.5 ms for five notes (the parser is Python code)",
      },
      { name: "is_playing", sig: "is_playing() -> bool", doc: "`True` while a melody plays.", returns: "bool" },
      { name: "beep", sig: "beep()", doc: "440 Hz for 100 ms; blocks for these 100 ms." },
      { name: "on", sig: "on()", doc: "A continuous tone until `off()` (200 Hz in the simulator)." },
      { name: "off", sig: "off()", doc: "Stop any sound." },
      { name: "set_callback", sig: "set_callback(f)", doc: "Accepted for compatibility; the simulator never calls `f`." },
    ],
  },
  {
    name: "Battery",
    ctor: "robot.Battery()",
    doc: "Voltage of the four AA cells in millivolts, measured through an ADC that sees 1/11 of it. Fresh NiMH cells give about 5200 mV at rest; the voltage sags while the motors draw current (≈ 5130 mV at full speed) and falls as the cells empty (4600 mV = empty in the simulator). Lower voltage = slower motors.",
    example: `from zumo_2040_robot import robot

battery = robot.Battery()
display = robot.Display()
mv = battery.get_level_millivolts()
display.fill(0)
display.text("%d mV" % mv, 0, 0)
display.show()
print("battery", mv)
`,
    members: [{ name: "get_level_millivolts", sig: "get_level_millivolts() -> int", doc: "Battery voltage in mV.", returns: "int, mV", timing: "≈ 0.14 ms" }],
  },
  {
    name: "YellowLED",
    ctor: "robot.YellowLED()",
    doc: "The yellow user LED. Creating `YellowLED()` switches it off. You can also call the object: `led(1)`, `led(0)`.",
    example: `from zumo_2040_robot import robot
import time

led = robot.YellowLED()
for i in range(5):
    led.on()
    time.sleep_ms(200)
    led.off()
    time.sleep_ms(200)
`,
    members: [
      { name: "on", sig: "on()", doc: "Switch the LED on." },
      { name: "off", sig: "off()", doc: "Switch the LED off." },
      { name: "value", sig: "value(v)", doc: "On if `v` is true, off otherwise.", params: [["v", "True/1 = on, False/0 = off"]] },
    ],
  },
];

export const TIME_API: ApiMember[] = [
  {
    name: "sleep_ms",
    sig: "sleep_ms(ms)",
    doc: "Pause your program for `ms` milliseconds of robot time. The world keeps going: the motors keep their speed and the opponent keeps moving.",
    params: [["ms", "milliseconds (int)"]],
    example: "time.sleep_ms(250)",
  },
  { name: "sleep_us", sig: "sleep_us(us)", doc: "Pause for `us` microseconds.", params: [["us", "microseconds (int)"]] },
  { name: "sleep", sig: "sleep(seconds)", doc: "Pause for `seconds` (a float like 0.5 is fine).", params: [["seconds", "int or float"]] },
  {
    name: "ticks_ms",
    sig: "ticks_ms() -> int",
    doc: "Milliseconds since the run started (on the robot: since power-on). Wraps around at 2³⁰ ms (≈ 12.4 days): compare times only with `ticks_diff()`.",
    returns: "int, ms",
  },
  {
    name: "ticks_us",
    sig: "ticks_us() -> int",
    doc: "Microseconds; wraps around at 2³⁰ µs, that is every 17.9 minutes. Always subtract with `ticks_diff()`.",
    returns: "int, µs",
  },
  { name: "ticks_cpu", sig: "ticks_cpu() -> int", doc: "Highest-resolution counter; in the simulator the same as `ticks_us()`.", returns: "int" },
  {
    name: "ticks_diff",
    sig: "ticks_diff(a, b) -> int",
    doc: "`a - b`, correct across the wrap-around. Put the later time first: `time.ticks_diff(time.ticks_ms(), start)`.",
    returns: "int (negative if a is before b)",
    example: `start = time.ticks_ms()
# ... later ...
elapsed = time.ticks_diff(time.ticks_ms(), start)`,
  },
  {
    name: "ticks_add",
    sig: "ticks_add(t, delta) -> int",
    doc: "`t + delta` with wrap-around, for deadlines: `deadline = time.ticks_add(time.ticks_ms(), 500)`.",
    returns: "int",
  },
  { name: "time", sig: "time() -> int", doc: "Whole seconds since the run started (on the robot: seconds of its clock).", returns: "int, s" },
  { name: "time_ns", sig: "time_ns() -> int", doc: "Nanoseconds since the run started.", returns: "int, ns" },
];

/** Things that are simulated, approximated or missing — shown in the Docs panel so nobody is surprised. */
export const SIM_NOTES: [string, string][] = [
  ["Same code", "Your main.py runs unchanged in real MicroPython (WebAssembly). Download it and copy it to the robot."],
  ["Timing", "Every executed Python line costs ~6 µs robot time; sensor reads cost their real duration (line 1.06 ms, proximity 6.85 ms, display 4 ms). Loop rates match the real robot."],
  ["Physics", "MuJoCo 3D: tracks, blade wedge, tipping, battery sag. Values marked EST in zumo-spec.ts are estimates until calibrated with real robots."],
  ["Blades", "Blade edges differ between robots by tenths of a millimetre in height and tilt, like real ones (new per run). Head-on, the blade that is lower where they meet gets under the other — the angle and spot of the hit matter, pushing harder does not."],
  ["Sensors", "Line: each sensor sees a ~5 mm light spot, so tape edges give in-between values; a lifted sensor reads like black. Proximity: ray fan with LED cones and material reflectivity. IMU from the rigid body, with noise and a per-robot gyro bias. Encoders from the sprocket angle."],
  ["Not yet", "Shop parts on I2C (ToF, BNO085, servos — machine.I2C answers ENODEV), IR interference between robots, ambient light, IMU output-data-rate filtering, @micropython.native/viper speed-ups, asyncio, files besides main.py. Floats are double precision (the robot uses single precision)."],
];

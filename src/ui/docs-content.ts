// Player documentation of SPARK Sim: tutorials, guides, reference pages, arena rules and help.
// Plain data, rendered by the docs viewer. Every complete program in a code block has been run in the simulator;
// blocks titled "Fragment …" need the surrounding program (objects such as `motors` or `line`).

export type DocBlock =
  | { p: string } // paragraph. Inline markup: `code`, **bold**, *italic*, [text](doc:page-id), [text](doc:page-id#anchor), [text](https://...)
  | { h: string; id?: string } // sub-heading inside a page (id = anchor for links)
  | { list: string[]; ordered?: boolean } // items use the same inline markup
  | { code: string; title?: string; insert?: boolean } // MicroPython code block; insert: true shows "Use as my program" (complete programs) or "Insert at cursor" (fragments)
  | { note: string; kind?: "tip" | "warn" | "info" } // callout box, inline markup allowed
  | { table: { head: string[]; rows: string[][] } } // cells use inline markup
  | { api: string } // renders the API reference of one class from src/ui/api.ts ROBOT_API (by its `name`, e.g. "Motors"), or "time" for TIME_API
  | { shortcuts: true }; // renders the app's keyboard shortcut table (provided by the UI, do not write it yourself)

export interface DocPage {
  id: string; // kebab-case, unique
  group: string; // sidebar group, see the structure below
  title: string;
  summary: string; // one sentence, shown in search results and page lists
  blocks: DocBlock[];
}

// ---------------------------------------------------------------- programs used on several pages

const SUMO_BOT = `from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
prox = robot.ProximitySensors()
display = robot.Display()
button_a = robot.ButtonA()

EDGE = 500      # raw line value below this = white border
FULL = 6000     # attack speed
SEARCH = 2500   # turning speed while searching
STEER = 800     # speed difference per count of left/right difference


def show(text):
    display.fill(0)
    display.text(text, 0, 0)
    display.show()


# --- wait for button A, then the 5 seconds the rules require
show("Press A")
while not button_a.check():
    time.sleep_ms(10)
start = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), start) < 5000:
    left = 5 - time.ticks_diff(time.ticks_ms(), start) // 1000
    show("Start in %d" % left)
    time.sleep_ms(100)
show("Fight!")

turn = 1  # search direction: 1 = clockwise (right), -1 = counter-clockwise (left)
try:
    while True:
        # 1. Never drive out: the white border is bright (small raw values)
        v = line.read()
        if v[0] < EDGE or v[1] < EDGE:          # border on the left: back up, turn right
            motors.set_speeds(-FULL, -FULL)
            time.sleep_ms(150)
            motors.set_speeds(FULL, -FULL)
            time.sleep_ms(180)
            turn = 1
            continue
        if v[3] < EDGE or v[4] < EDGE or v[2] < EDGE:  # border on the right or ahead
            motors.set_speeds(-FULL, -FULL)
            time.sleep_ms(150)
            motors.set_speeds(-FULL, FULL)
            time.sleep_ms(180)
            turn = -1
            continue

        # 2. Look for the opponent
        prox.read()
        fl = prox.front_counts_with_left_leds()
        fr = prox.front_counts_with_right_leds()
        side_l = prox.left_counts_with_left_leds()
        side_r = prox.right_counts_with_right_leds()

        if fl + fr >= 4:
            # 3. Attack: full power, steer towards the side that sees more
            diff = fl - fr                       # > 0: opponent a bit to the left
            motors.set_speeds(FULL - STEER * max(0, diff), FULL - STEER * max(0, -diff))
        elif side_l > side_r:
            turn = -1
            motors.set_speeds(-FULL, FULL)       # opponent on the left: turn left fast
        elif side_r > side_l:
            turn = 1
            motors.set_speeds(FULL, -FULL)
        else:
            # 4. Nothing seen: turn on the spot and look around
            motors.set_speeds(SEARCH * turn, -SEARCH * turn)
finally:
    motors.off()
`;

const LINE_FOLLOWER = `from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
display = robot.Display()
button_a = robot.ButtonA()

BASE = 3000   # speed when the line is centred
KP = 1.2      # how hard to steer per unit of error
KD = 8        # damping: reacts to how fast the error changes


def show(*rows):
    display.fill(0)
    for i, row in enumerate(rows):
        display.text(row, 0, i * 12)
    display.show()


def sweep(left, right, ms):
    # turn on the spot and calibrate the whole time
    motors.set_speeds(left, right)
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < ms:
        line.calibrate()


show("Line follower", "", "A = start")
while not button_a.check():
    time.sleep_ms(10)

# Calibration: turn about 55 degrees left, 110 right and back, so that
# every sensor (the outer ones sit 3.5 cm to the side) crosses the tape.
show("Calibrating...")
sweep(-2000, 2000, 550)
sweep(2000, -2000, 1100)
sweep(-2000, 2000, 550)
motors.off()
print("min", list(line.cal_min), "max", list(line.cal_max))

show("Go!")
last_error = 0
try:
    while True:
        v = line.read_calibrated()          # 0 = white ... 1000 = black
        total = v[0] + v[1] + v[2] + v[3] + v[4]
        if total < 300:
            # line lost: spin towards the side where we saw it last
            if last_error > 0:
                motors.set_speeds(2500, -2500)
            else:
                motors.set_speeds(-2500, 2500)
            continue
        # weighted average: 0 = under DN1 (left) ... 4000 = under DN5 (right)
        position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
        error = position - 2000             # > 0: the line is right of the centre
        correction = KP * error + KD * (error - last_error)
        last_error = error
        motors.set_speeds(BASE + correction, BASE - correction)
finally:
    motors.off()
`;

const CALIBRATION_SWEEP = `def sweep(left, right, ms):
    # turn on the spot and calibrate the whole time
    motors.set_speeds(left, right)
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < ms:
        line.calibrate()


sweep(-2000, 2000, 550)      # about 55 degrees left
sweep(2000, -2000, 1100)     # about 110 degrees right
sweep(-2000, 2000, 550)      # back to the middle
motors.off()
print("min", list(line.cal_min), "max", list(line.cal_max))
`;

const SENSOR_CHECK = `# Sensor check: shows the raw sensor values on the display. The motors stay off.
from zumo_2040_robot import robot
import time

line = robot.LineSensors()
prox = robot.ProximitySensors()
battery = robot.Battery()
display = robot.Display()

while True:
    v = line.read()
    prox.read()
    l = prox.left_counts_with_left_leds()
    fl = prox.front_counts_with_left_leds()
    fr = prox.front_counts_with_right_leds()
    r = prox.right_counts_with_right_leds()
    mv = battery.get_level_millivolts()

    display.fill(0)
    display.text("LINE (raw)", 0, 0)
    display.text("%4d %4d %4d" % (v[0], v[1], v[2]), 0, 10)
    display.text("  %4d %4d" % (v[3], v[4]), 0, 20)
    display.text("PROX L FL FR R", 0, 32)
    display.text("     %d  %d  %d %d" % (l, fl, fr, r), 0, 42)
    display.text("BAT %d mV" % mv, 0, 54)
    display.show()
    print("line", list(v), "prox", l, fl, fr, r, "battery", mv)
    time.sleep_ms(200)
`;

// ---------------------------------------------------------------- the pages

export const DOC_PAGES: DocPage[] = [
  // ================================================================ Start here
  {
    id: "welcome",
    group: "Start here",
    title: "Welcome to SPARK Sim",
    summary: "What the simulator is for, and a five-minute tour of the screen.",
    blocks: [
      {
        p: "SPARK Sim is a training ground for the Pololu **Zumo 2040**. You write the same `main.py` that you will later copy onto the real robot, and the simulator runs it in real MicroPython against a 3D physics model of the Zumo: tracks, blade, battery, sensors and their timing. Your team gets its real robot only a few hours before the event, so this is where you learn, test and tune.",
      },
      { p: "Everything runs in your browser. Your code is saved in this browser automatically; nothing is uploaded." },
      { h: "The screen in five minutes", id: "screen" },
      {
        ordered: true,
        list: [
          "**Top bar.** Pick the **Arena**, then **▶ Run** (starts all programs from their start positions), **■ Stop** (programs and motors off) and **↺ Reset** (robots back to the start without running). The speed buttons pause the simulation or run it at ¼×, ½×, 1×, 4× or as fast as your computer can; next to them you see the robot time and how fast it runs compared to real time. On the right: **Docs**, **▦ Layout**, **⚙** settings and **?** help.",
          "**Code** (left). One tab per robot, up to four. Each robot has a name and a **Program**: *✎ My code* (your editable program), an example, or a house bot to train against. Below the editor: **⇩ main.py** downloads the program for the real robot, **⇧ Open** loads a `.py` file, **⇪ Link** copies a link that contains the whole program.",
          "**3D view** (middle). Drag to orbit, right-drag to pan, scroll to zoom, click a robot to select it, Shift + drag to move a robot (scroll while dragging turns it). The bar above it has the view style (Pixel, Spark, Clear), **World** settings, **Auto start**, **Sensors**, **Sound** and three camera buttons. The scoreboard shows the match clock and the scores; the timeline below lets you scrub back through everything that happened.",
          "**Bottom panel.** **Console** (everything your programs print, errors, referee messages), **Telemetry** (charts), **Test bench** (many matches at once) and **Docs** (what you are reading).",
          "**Inspector** (right). What the selected robot shows and sees: its display, the buttons A/B/C, the LEDs, the last line sensor and proximity readings, motors, motion, battery and IMU.",
        ],
      },
      { h: "Try it now", id: "try" },
      {
        ordered: true,
        list: [
          "Choose the arena **Dohyo 77 cm (mini sumo)**. On your first visit robot 1 runs *✎ My code* with a sumo starter program, and robot 2 is a ready-made opponent (a house bot), if your deployment provides any.",
          "Press **⚑ Start** (or the key S). It runs the programs and gives the start signal: button A is pressed on both robots, they count down 5 seconds, then fight. (▶ Run alone starts the programs without the signal — the robots then wait for A until you press ⚑ Start.)",
          "Watch the console and the scoreboard: the match ends when a robot leaves the ring.",
          "Drag the timeline back to see the decisive moment again; press **Live** (or L) to return.",
        ],
      },
      {
        note: "New to robot programming? Go on with [Your first program](doc:first-program). Already know Python? Jump to the [sumo tutorial](doc:tutorial-sumo) or [Program structure](doc:program-structure).",
        kind: "tip",
      },
      { note: "A guided tour starts on your first visit. Restart it any time from the help dialog (?) or with **⚙ → Take the guided tour**." },
      { h: "What you can do here", id: "what" },
      {
        list: [
          "Write and debug your program with autocompletion, hover help, error markers and a plotter for printed values.",
          "Train against [house bots](doc:house-bots) of different strategies and difficulty.",
          "Measure your progress with the [test bench](doc:test-bench): dozens of matches in parallel, a win rate with a 95 % interval, and every match can be watched again.",
          "Test robustness with weak batteries, a dusty floor and noisy sensors ([robustness checklist](doc:robustness)).",
          "Learn the rules of every arena, starting with the [dohyo](doc:arena-dohyo).",
          "Take your program to the real robot: [From simulator to the real robot](doc:to-the-robot).",
        ],
      },
    ],
  },
  {
    id: "first-program",
    group: "Start here",
    title: "Your first program",
    summary: "Step by step: text on the display, driving and turning, waiting for button A, and printing values.",
    blocks: [
      { p: "In this tutorial you write four small programs. Each one is complete: replace everything in the editor with it and press ▶ Run." },
      { h: "Prepare", id: "prepare" },
      {
        ordered: true,
        list: [
          "Choose the arena **Free practice**: a big white table with nothing to bump into.",
          "Click the tab of robot 2 and remove it with **✕** (next to the robot's name), so your robot has the table to itself.",
          "Click the tab of robot 1 and set its **Program** to *✎ My code*.",
          "Select all code in the editor (Ctrl/⌘ + A) and delete it. Want to keep it? Download it first with **⇩ main.py** (Ctrl/⌘ + Z also brings it back).",
        ],
      },
      { note: "Code boxes have **Copy** and, for complete programs, **Use as my program**: it replaces the code of the robot that is open in the editor (Ctrl/⌘ + Z in the editor brings your old code back). Short snippets have **Insert at cursor** instead." },
      { h: "Step 1: Hello on the display", id: "step1" },
      {
        title: "Step 1 · hello",
        insert: true,
        code: `from zumo_2040_robot import robot

display = robot.Display()
display.fill(0)                       # clear the picture
display.text("Hello, Zumo!", 0, 0)    # text at x = 0, y = 0
display.show()                        # send it to the display
`,
      },
      { p: "Press ▶ Run. The display in the inspector (and on the robot in the 3D view) shows *Hello, Zumo!*." },
      {
        list: [
          "`from zumo_2040_robot import robot` loads Pololu's library for the Zumo. Every part of the robot is a class in `robot`.",
          "`robot.Display()` creates the display object. Drawing (`fill`, `text`) only changes a picture in memory; **`show()` sends it to the screen.** Forgetting `show()` is the most common reason for an empty display.",
          "The display has 128 × 64 pixels. `text(s, x, y)` writes 8 × 8 pixel letters: 16 characters per line, 8 lines.",
        ],
      },
      { note: "The console says *program finished* when your program reaches its end. That is fine here; real robot programs usually run in an endless loop." },
      { h: "Step 2: drive and turn", id: "step2" },
      {
        title: "Step 2 · drive",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

display = robot.Display()
motors = robot.Motors()

display.fill(0)
display.text("Driving", 0, 0)
display.show()

motors.set_speeds(3000, 3000)     # both tracks forward, half power
time.sleep_ms(1000)               # keep going for 1 second
motors.set_speeds(-3000, 3000)    # left track back, right track forward
time.sleep_ms(420)                # = turn left, about 90 degrees
motors.off()                      # stop

display.fill(0)
display.text("Done", 0, 0)
display.show()
`,
      },
      {
        p: "`set_speeds(left, right)` sets both tracks: −6000 is full reverse, 6000 full forward. 3000 drives about 27 cm in the first second. When the left track runs backwards and the right one forwards, the robot turns left on the spot.",
      },
      {
        p: "`time.sleep_ms(1000)` pauses your program for 1 s. **The motors keep running while the program sleeps**: they keep the speed you set last until you set a new one. That is why `motors.off()` at the end matters. Without it the robot would drive on forever, even after the program has finished.",
      },
      { note: "Change the numbers and run again. Which speed is needed for a visible movement? (Below about 1000 the robot hardly moves.)", kind: "tip" },
      { h: "Step 3: wait for button A, then drive a square", id: "step3" },
      {
        title: "Step 3 · square",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

display = robot.Display()
motors = robot.Motors()
button_a = robot.ButtonA()


def show(text):
    display.fill(0)
    display.text(text, 0, 0)
    display.show()


show("Press A")
while not button_a.check():       # wait until button A is pressed
    time.sleep_ms(10)

for side in range(4):             # drive a square
    show("Side %d" % (side + 1))
    motors.set_speeds(3000, 3000)
    time.sleep_ms(1000)
    motors.set_speeds(-3000, 3000)
    time.sleep_ms(420)
motors.off()
show("Square done")
`,
      },
      {
        p: "Real robots wait for a button press, so they do not drive off the table while you are still holding them. `button_a.check()` returns `True` once when the button is pressed. The loop `while not button_a.check():` waits for that, and `time.sleep_ms(10)` keeps it from spinning needlessly.",
      },
      {
        p: "In the simulator **⚑ Start** (key S) is the referee's start signal: it presses A on every robot at once. **Auto start** (above the 3D view) gives the signal automatically 0.2 s after ▶ Run. To press A on one robot only, click **A** in the inspector or hold the key A.",
      },
      { p: "`def show(text):` defines a function, so you do not repeat the display code. `for side in range(4):` repeats the indented block four times." },
      {
        note: "Timed turns are not exact: the angle depends on speed, battery and floor. On the real robot your square will look different. For exact angles, see [turning with the gyro](doc:imu#turn).",
        kind: "warn",
      },
      { h: "Step 4: print values", id: "step4" },
      {
        title: "Step 4 · print",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

display = robot.Display()
motors = robot.Motors()
encoders = robot.Encoders()
button_a = robot.ButtonA()

display.fill(0)
display.text("Press A", 0, 0)
display.show()
while not button_a.check():
    time.sleep_ms(10)

motors.set_speeds(2000, 4000)          # right track faster: a left curve
start = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), start) < 3000:
    left, right = encoders.get_counts()
    print("left:", left, "right:", right)
    time.sleep_ms(100)
motors.off()
`,
      },
      {
        p: "`print()` writes to the **Console**. Each line starts with the robot time and the robot's name. Now open **Telemetry** in the bottom panel: numbers you print with a label in front (`left: 123`) are drawn as a chart, *Your print() values*, above the built-in charts. The exact format is on [Debugging tools](doc:debugging#plotter).",
      },
      {
        p: "The encoders count how far each track has turned (about 8470 counts per metre). Here the right track runs twice as fast as the left one, so the robot drives a left curve and the right count grows faster.",
      },
      { h: "What next?", id: "next" },
      {
        list: [
          "[Tutorial: your first sumo bot](doc:tutorial-sumo)",
          "[Tutorial: a line follower](doc:tutorial-line)",
          "[Program structure](doc:program-structure): how a robot program is organised",
          "[Common mistakes](doc:common-mistakes)",
        ],
      },
    ],
  },
  {
    id: "tutorial-sumo",
    group: "Start here",
    title: "Tutorial: your first sumo bot",
    summary: "Build a complete mini-sumo program — start rule, edge avoidance, search and attack — and test it against house bots.",
    blocks: [
      {
        p: "In mini sumo two robots start face to face in a black ring with a white border. Whoever pushes the other out wins ([rules](doc:arena-dohyo)). A simple, solid strategy has four parts, checked in this order in every loop:",
      },
      {
        ordered: true,
        list: [
          "**Never drive out.** If a line sensor sees the white border, back up and turn away.",
          "**Attack** when the front sensor sees the opponent: full power, steer towards it.",
          "**Turn towards** the opponent when a side sensor sees it.",
          "**Search**: turn on the spot until something shows up.",
        ],
      },
      { h: "Prepare", id: "prepare" },
      {
        p: "Choose the arena **Dohyo 77 cm (mini sumo)**. Robot 1 runs *✎ My code*. For robot 2 use an opponent that never moves — your own one-liner `while True: pass`, or a stationary house bot if your deployment has one — so you can test pushing without a fight.",
      },
      { h: "Part 1: the start", id: "start" },
      {
        p: "Robots may start moving **5 seconds** after the start. If a motor runs earlier, the simulator flags a **false start**. So: wait for button A, then count down 5 s.",
      },
      {
        title: "Fragment · the start",
        code: `show("Press A")
while not button_a.check():
    time.sleep_ms(10)
start = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), start) < 5000:
    left = 5 - time.ticks_diff(time.ticks_ms(), start) // 1000
    show("Start in %d" % left)
    time.sleep_ms(100)
show("Fight!")
`,
      },
      {
        p: "`time.ticks_ms()` is a millisecond clock; `time.ticks_diff(now, start)` is the time since `start`. Always use `ticks_diff` for time differences ([why](doc:timing#ticks)).",
      },
      { h: "Part 2: stay in the ring", id: "edge" },
      {
        p: "The line sensors look down. On the black ring they read 1024 (dark), on the white border about 110 (bright). Anything below `EDGE = 500` is the border. If the left sensors see white, the border is on the left: back up and turn right. And the other way round.",
      },
      {
        title: "Fragment · edge check",
        code: `v = line.read()
if v[0] < EDGE or v[1] < EDGE:      # border on the left
    motors.set_speeds(-FULL, -FULL)  # back up ...
    time.sleep_ms(150)
    motors.set_speeds(FULL, -FULL)   # ... and turn right
    time.sleep_ms(180)
`,
      },
      {
        note: "Check the edge often. At full speed the robot crosses the 2.5 cm white border in less than 40 ms; a loop that sleeps 100 ms between checks drives straight out of the ring.",
        kind: "warn",
      },
      { h: "Part 3: find and attack", id: "attack" },
      {
        p: "`prox.read()` (about 7 ms) measures the three proximity sensors. Each count goes from 0 (nothing) to 6 (very close). The front sensor is measured twice, lit by the left and by the right LEDs: if the left-LED count is higher, the opponent is a bit to the left.",
      },
      {
        title: "Fragment · attack, turn or search",
        code: `prox.read()
fl = prox.front_counts_with_left_leds()
fr = prox.front_counts_with_right_leds()
side_l = prox.left_counts_with_left_leds()
side_r = prox.right_counts_with_right_leds()

if fl + fr >= 4:                     # opponent ahead, closer than about 25 cm
    diff = fl - fr                   # > 0: a bit to the left
    motors.set_speeds(FULL - STEER * max(0, diff), FULL - STEER * max(0, -diff))
elif side_l > side_r:                # opponent on the left
    motors.set_speeds(-FULL, FULL)
elif side_r > side_l:                # opponent on the right
    motors.set_speeds(FULL, -FULL)
else:                                # nothing seen: search
    motors.set_speeds(SEARCH * turn, -SEARCH * turn)
`,
      },
      { h: "The complete program", id: "full" },
      { title: "sumo_bot.py", insert: true, code: SUMO_BOT },
      { h: "Test it", id: "test" },
      {
        ordered: true,
        list: [
          "Press ▶ Run. Your robot counts down, finds the stationary opponent and pushes it out. The console shows it is out and the result.",
          "Now give robot 2 a more active opponent (a house bot, if your deployment has one) and run a few times. Sometimes you win, sometimes it does: start positions differ, and head-on hits are decided by small differences between the blades.",
          "Open the **Test bench**, choose your robot as A and an opponent as B, 40 matches, **▶ Run bench**. Now you have a number to beat ([reading the results](doc:test-bench#result)).",
        ],
      },
      {
        note: "Ideas to make it stronger: search towards the side where you last saw the opponent; attack at an angle instead of head-on; replace the sleeps of the escape with a [state machine](doc:state-machines); react to hits with the [IMU](doc:imu#hits). Compare every change on the bench.",
        kind: "tip",
      },
    ],
  },
  {
    id: "tutorial-line",
    group: "Start here",
    title: "Tutorial: a line follower",
    summary: "Calibrate the line sensors, compute the line position and follow the track with a PD controller.",
    blocks: [
      {
        p: "The **Line track** is a white board with a 19 mm black tape loop. Your robot starts on the tape; laps are counted at the start/finish line ([rules](doc:arena-line)). A good line follower has three parts: calibration, position and a controller.",
      },
      { h: "Prepare", id: "prepare" },
      { p: "Choose the arena **Line track (race)**. Keep only robot 1 (✕ removes the others) and set its Program to *✎ My code*." },
      { h: "Part 1: calibration", id: "calibrate" },
      {
        p: "Raw values differ from sensor to sensor and from surface to surface. `line.calibrate()` records, per sensor, the darkest and the brightest value it sees; afterwards `line.read_calibrated()` gives 0 for white and 1000 for black on every sensor.",
      },
      {
        p: "For that, **every sensor must see both the tape and the white board** while you calibrate. The sensors sit 4.7 cm ahead of the centre, the outer ones 3.5 cm to the side. When the robot sits on the tape, the outer sensors reach the tape only after turning about 37°, and must go further to be fully over it. So turn about **55° to each side**.",
      },
      { title: "Fragment · calibration sweep", code: CALIBRATION_SWEEP },
      {
        p: "Check the printed values: every **max** should be close to 1024 and every **min** close to 110. A sensor whose max stays near the white value never saw the tape: `read_calibrated()` then returns 0 (or noise) for it, and your robot is half blind.",
      },
      { h: "Part 2: where is the line?", id: "position" },
      {
        p: "A weighted average of the five calibrated values gives the line position: 0 = under DN1 (far left), 2000 = under the middle sensor, 4000 = under DN5 (far right).",
      },
      {
        title: "Fragment · line position",
        code: `v = line.read_calibrated()                 # 0 = white ... 1000 = black
total = v[0] + v[1] + v[2] + v[3] + v[4]
position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
error = position - 2000                    # > 0: line is right of the centre
`,
      },
      { p: "If `total` is small (below about 300), no sensor sees the line: the robot has lost it. Handle that case first, otherwise you divide by zero." },
      { h: "Part 3: steering with a PD controller", id: "pd" },
      {
        p: "The error says how far the line is off-centre. Steer in proportion to it: `correction = KP * error`, left track `BASE + correction`, right track `BASE - correction`. A line to the right (error > 0) makes the left track faster, so the robot turns right. That is a **P controller**. At speed it overshoots and wobbles, so add a **D term** that reacts to how fast the error changes: `KD * (error - last_error)`. It eases off the steering before the robot swings across the line.",
      },
      { h: "The complete program", id: "full" },
      { title: "line_follower.py", insert: true, code: LINE_FOLLOWER },
      { h: "Test and tune", id: "tune" },
      {
        ordered: true,
        list: [
          "Press ▶ Run. The robot calibrates, then follows the tape (line programs do not wait for a start signal). The console reports every lap and its time; the race ends when every robot has driven 3 timed laps.",
          "Open **Telemetry**: the *Line sensors* chart shows the raw values the program read.",
          "Tune one value at a time: raise `BASE` until the robot starts to lose the line in the S-bend, then raise `KD` (less wobble) or `KP` (sharper steering).",
          "Compare versions on the test bench with *B = none (solo run)*: it reports the average score (laps) and the best lap.",
        ],
      },
      { p: "In the simulator this program drives a lap in about 14 s. The fastest house bots are much quicker: see how close you get." },
      {
        note: "The S-bend on the top straight starts and ends with a kink of about 50° and has curves down to about 5 cm radius. When the line is lost there, the robot spins towards the side where it saw the line last.",
      },
      { note: "On the real track, calibrate on the real surface right before the run: tape, board and light differ from the simulator.", kind: "warn" },
    ],
  },
  {
    id: "to-the-robot",
    group: "Start here",
    title: "From simulator to the real robot",
    summary: "Download main.py, copy it onto the Zumo with Thonny or mpremote, and what to check first on real hardware.",
    blocks: [
      {
        p: "The simulator runs the same MicroPython and the same `zumo_2040_robot` library as the robot, so your program needs no changes. What changes is the world: real sensors, real batteries, a real floor. Plan time for re-tuning.",
      },
      { h: "1. Download", id: "download" },
      {
        p: "Open your robot's tab and click **⇩ main.py**. The browser saves the program as `main.py`. MicroPython runs a file with this name automatically every time the robot starts.",
      },
      { h: "2a. Copy with Thonny", id: "thonny" },
      {
        ordered: true,
        list: [
          "Install [Thonny](https://thonny.org) and connect the Zumo with a USB cable.",
          "In Thonny choose **Tools → Options → Interpreter → MicroPython (Raspberry Pi Pico)** and the robot's port (or let Thonny detect it). The shell shows the MicroPython prompt `>>>`.",
          "Open your downloaded `main.py`, then **File → Save as… → Raspberry Pi Pico** and save it as `main.py` on the robot.",
          "Restart the robot (power off and on, or Ctrl+D in the Thonny shell). While Thonny is connected you see everything your program prints.",
        ],
      },
      { h: "2b. Copy with mpremote", id: "mpremote" },
      {
        title: "Terminal (not Python)",
        code: `pip install mpremote
mpremote cp main.py :main.py     # copy onto the robot
mpremote reset                   # restart: main.py runs
mpremote run main.py             # or: run it without saving, output in the terminal
`,
      },
      {
        note: "Keep a copy of what is on the robot. If it already has a `main.py`, download that one first (Thonny: **View → Files**, right-click the file on the robot → *Download*), so you can restore it.",
        kind: "warn",
      },
      { h: "3. The first run", id: "safety" },
      {
        list: [
          "Hold the robot in the air or put it on a box for the first run, so the tracks can spin freely.",
          "Make sure your program waits for button A. A program that drives off at once races off the table while you unplug the cable.",
          "The motors run on the batteries: put in charged cells and switch the robot on.",
          "To stop a runaway program, switch the robot off, or press Ctrl+C in the Thonny shell.",
        ],
      },
      { h: "4. What to check first", id: "check" },
      { p: "Run this sensor check on the robot. It shows the raw line values, the proximity counts and the battery voltage on the display, and drives nowhere." },
      { title: "sensor_check.py", insert: true, code: SENSOR_CHECK },
      {
        ordered: true,
        list: [
          "**Battery.** Fresh NiMH cells show about 5200 mV. With nearly empty cells the robot is 10–15 % slower and pushes less: charge before you tune speeds.",
          "**Line thresholds.** Hold the robot over the white border and over the black ring and read the values. The simulator's ≈ 110 for white and 1024 for black are estimates; put your threshold (`EDGE`) safely between what *your* sensors show.",
          "**Calibration.** For a line follower, run your calibration sweep on the real track and print `line.cal_min` and `line.cal_max`.",
          "**Proximity range.** Put another robot (or your hand) in front at 5, 15 and 30 cm and compare the counts with the [simulator's table](doc:proximity#range).",
          "**Directions.** Positive speeds must drive forward, and turning left must give a positive gyro z (`imu.gyro.last_reading_dps[2]`). Check both once.",
          "**Timings.** Anything timed (`sleep_ms` turns, back-up times) needs new values on the real floor. Sensor-based moves (gyro turns, encoder distances) transfer better.",
        ],
      },
      { note: "More differences and how to plan for them: [Sim vs. reality](doc:sim-vs-reality)." },
    ],
  },

  // ================================================================ Programming the Zumo
  {
    id: "program-structure",
    group: "Programming the Zumo",
    title: "Program structure",
    summary: "How a robot program is organised: imports, setup, start signal, main loop and stopping the motors safely.",
    blocks: [
      { p: "Almost every robot program has the same five parts. Here is a template; the robot in it simply bounces around inside the ring." },
      {
        title: "template.py",
        insert: true,
        code: `# main.py: template for a Zumo 2040 program
from zumo_2040_robot import robot
import time

# 1. Hardware objects: create each one once, at the top
motors = robot.Motors()
line = robot.LineSensors()
prox = robot.ProximitySensors()
display = robot.Display()
button_a = robot.ButtonA()

# 2. Settings you will tune (CAPITALS = constants)
EDGE = 500
SPEED = 3000


# 3. Helper functions
def show(*rows):
    display.fill(0)
    for i, row in enumerate(rows):
        display.text(row, 0, i * 10)
    display.show()


# 4. Wait for the start signal
show("Ready", "A = start")
while not button_a.check():
    time.sleep_ms(10)
time.sleep_ms(5000)      # sumo: robots may move 5 s after the start

# 5. Main loop: runs until the robot is switched off
try:
    while True:
        v = line.read()
        if min(v) < EDGE:            # any sensor on the white border
            motors.set_speeds(-SPEED, -SPEED)
            time.sleep_ms(200)
            motors.set_speeds(SPEED, -SPEED)
            time.sleep_ms(250)
        else:
            motors.set_speeds(SPEED, SPEED)
finally:
    motors.off()         # also runs when the program stops with an error
`,
      },
      { h: "1. Imports", id: "imports" },
      {
        p: "`from zumo_2040_robot import robot` gives you the hardware classes (`robot.Motors`, `robot.LineSensors`, …), `import time` the clock and the sleeps. Other useful modules: `math`, `random`, `gc` ([what is available](doc:ref-other-modules)).",
      },
      { h: "2. Setup", id: "setup" },
      {
        list: [
          "Create every hardware object **once**, at the top. Creating `robot.Motors()` stops the motors, and creating objects inside a loop wastes time and memory.",
          "Put the numbers you will tune (thresholds, speeds, gains) into CAPITALISED constants at the top. On the real robot you will change them a lot.",
          "IMU: call `imu.reset()` and `imu.enable_default()` once, otherwise it reads 0.",
        ],
      },
      { h: "3. Start signal and the 5 s rule", id: "start" },
      {
        p: "Wait for button A. In sumo the robot must not move for **5 seconds** after the start ([rule](doc:arena-dohyo#false-start)). In the simulator the 5 s count from the start signal (⚑ Start, which presses A on every robot), so waiting 5 s after the press is exactly right; moving earlier is reported as a false start. Reading sensors, lighting LEDs and computing are fine during the wait; only the motors must stay at 0. That also means: **no calibration spins before the 5 s are over.**",
      },
      { h: "4. The main loop", id: "loop" },
      {
        p: "`while True:` runs forever. Inside: read the sensors, decide, set the motors — as often as possible, without long sleeps. A program that reaches its end leaves the motors running at their last speed: the robot drives on without a brain.",
      },
      { h: "5. Stopping safely: try / finally", id: "finally" },
      {
        p: "Wrap the main loop in `try: … finally: motors.off()`. When your program stops with an error, the `finally` block still runs and stops the motors. Without it, a crash at full speed means the robot keeps going. (In the simulator, ■ Stop always switches the motors off.)",
      },
      {
        title: "Fragment · the safety net",
        code: `try:
    while True:
        pass          # your main loop
finally:
    motors.off()
`,
      },
      {
        p: "When an error stops the program, the console shows the traceback, the line is marked in the editor, and the robot's display shows the error type and message, like the real firmware does.",
      },
      { h: "Helper functions", id: "functions" },
      {
        p: "Use functions for things you do often (`show()`, `turn(degrees)`, `drive_cm(cm)`). A function that changes a variable you also use outside it needs `global name` at its start.",
      },
      { note: "Bigger programs: organise the main loop as a [state machine](doc:state-machines).", kind: "tip" },
    ],
  },
  {
    id: "timing",
    group: "Programming the Zumo",
    title: "Timing and loop rates",
    summary: "Robot time, what each call costs, how fast your loop runs, and how to measure time correctly.",
    blocks: [
      {
        p: "Your program runs on a simulated clock that matches the RP2040 on the Zumo: every Python instruction costs time (about 1.7 µs per bytecode, so a simple line takes 3–10 µs), and every sensor read takes as long as on the real hardware. The world moves on while your code computes. The speed of your computer does not matter: a loop runs as often per second as it would on the robot.",
      },
      {
        note: "The sensor durations follow from how the hardware measures. The Python costs are the simulator's estimate of the RP2040 and will be checked on real robots. All values below were measured in the simulator.",
      },
      { h: "What a call costs", id: "costs" },
      {
        table: {
          head: ["Call", "Robot time", "Notes"],
          rows: [
            ["`motors.set_speeds(l, r)`", "≈ 0.17 ms", "mostly the library's Python code"],
            ["`line.read()` / `line.read_calibrated()`", "≈ 1.06 ms", "always, on any surface"],
            ["`line.calibrate()`", "≈ 14 ms", "10 reads"],
            ["`prox.read()`", "≈ 7.0 ms", "12 IR pulse trains; fewer `brightness_levels` = faster"],
            ["`imu.read()`", "≈ 0.77 ms", "all three sensors"],
            ["`imu.gyro.read()` (or `acc`, `mag`)", "≈ 0.27 ms", "one sensor"],
            ["`imu.gyro.data_ready()`", "≈ 0.2 ms", "one register read"],
            ["`encoders.get_counts()`", "≈ 0.06 ms", ""],
            ["`battery.get_level_millivolts()`", "≈ 0.14 ms", ""],
            ["`display.show()`", "≈ 4 ms", "drawing (`fill`, `text`) itself is fast"],
            ["`leds.set(…)` · `leds.show()`", "≈ 0.1 ms · 0.08 ms", ""],
            ["`button_a.check()`", "≈ 0.08 ms", ""],
            ["`buzzer.play_in_background(…)`", "≈ 0.4 ms", "short melody; the parser is Python code"],
            ["`x = i * 3 + 7`", "≈ 0.01 ms", "a simple line of Python"],
          ],
        },
      },
      { h: "Loop rates", id: "rates" },
      {
        table: {
          head: ["Loop body", "Loops per second", "Travel per loop at full speed"],
          rows: [
            ["`line.read()` only", "≈ 860", "0.75 mm"],
            ["line follower: `read_calibrated()`, position, PD, `set_speeds()`", "≈ 700", "0.9 mm"],
            ["`prox.read()` only", "≈ 140", "4.6 mm"],
            ["sumo: `line.read()` + `prox.read()` + `set_speeds()`", "≈ 120", "5.4 mm"],
            ["the same + `display.show()`", "≈ 80", "8 mm"],
          ],
        },
      },
      {
        p: "The proximity read dominates a sumo loop. If you need faster edge checks, read the line sensors more often than the proximity sensors (for example twice per proximity read), or skip the proximity read while escaping from the border, as the [state machine example](doc:state-machines#sumo) does.",
      },
      { h: "Measuring time: ticks_ms and ticks_diff", id: "ticks" },
      {
        p: "`time.ticks_ms()` and `time.ticks_us()` count milliseconds and microseconds. They **wrap around** at 2³⁰: `ticks_us()` every 17.9 minutes, `ticks_ms()` every 12.4 days. On the robot they count from power-on, so a wrap can happen in the middle of a match. `time.ticks_diff(a, b)` computes `a - b` correctly across the wrap; plain subtraction does not.",
      },
      {
        title: "Fragment · timing something",
        code: `start = time.ticks_us()
v = line.read()
print("line read took", time.ticks_diff(time.ticks_us(), start), "us")
`,
      },
      {
        p: "For a deadline, add with `time.ticks_add()`: `deadline = time.ticks_add(time.ticks_ms(), 500)`, then loop `while time.ticks_diff(deadline, time.ticks_ms()) > 0:`.",
      },
      { note: "Measuring costs a little time too: one `ticks_us()` call takes about 0.02 ms of robot time in the simulator." },
      { h: "A loop at a fixed rate", id: "fixed-rate" },
      {
        p: "A controller (like the PD line follower) behaves the same, whatever else your code does, if it runs at a fixed rate. Schedule the next run with `ticks_add` and sleep for the rest of the period:",
      },
      {
        title: "fixed_rate.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

line = robot.LineSensors()

PERIOD_MS = 5                     # run the loop body every 5 ms (200 times per second)
next_time = time.ticks_ms()
loops = 0
report = time.ticks_add(time.ticks_ms(), 1000)

while True:
    v = line.read()               # ... the real work of your loop ...
    loops += 1
    if time.ticks_diff(time.ticks_ms(), report) >= 0:
        print("loops per second:", loops)
        loops = 0
        report = time.ticks_add(report, 1000)
    next_time = time.ticks_add(next_time, PERIOD_MS)
    wait = time.ticks_diff(next_time, time.ticks_ms())
    if wait > 0:
        time.sleep_ms(wait)
`,
      },
      { p: "It prints 200 loops per second. If the work takes longer than the period, `wait` becomes negative and the loop simply runs as fast as it can." },
      { h: "Measure your own loop", id: "measure" },
      {
        title: "loop_rate.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

line = robot.LineSensors()
prox = robot.ProximitySensors()

count = 0
start = time.ticks_ms()
while True:
    v = line.read()
    prox.read()
    count += 1
    elapsed = time.ticks_diff(time.ticks_ms(), start)
    if elapsed >= 1000:
        print("loop rate:", count * 1000 // elapsed, "Hz")
        count = 0
        start = time.ticks_ms()
`,
      },
      { p: "This prints about 122 Hz. Put your own loop body in and compare." },
      { h: "Sleeps", id: "sleeps" },
      {
        p: "`time.sleep_ms(n)` pauses your program, not the robot: the motors keep their speed, the opponent keeps moving, and nobody watches the edge. Sleeps of a few ms are harmless; long sleeps belong only where nothing can go wrong, such as waiting for the start. For actions that take time (back up 150 ms, then turn), a [state machine](doc:state-machines) keeps checking the sensors meanwhile.",
      },
      { h: "Timers", id: "timers" },
      {
        p: "`machine.Timer` calls a function periodically, like an interrupt between two statements of your program: [Other modules](doc:ref-other-modules#timer).",
      },
    ],
  },
  {
    id: "driving",
    group: "Programming the Zumo",
    title: "Driving",
    summary: "Speed values and what they mean, turning on the spot and in arcs, braking, drift, battery and pushing.",
    blocks: [
      {
        p: "`motors.set_speeds(left, right)` takes values from −6000 to 6000. They set the PWM duty cycle of each motor, not a speed in m/s: the same value drives slower with weak batteries or while pushing.",
      },
      { h: "Speed", id: "speed" },
      {
        table: {
          head: ["Value", "Straight (full battery)", "Spin on the spot: set_speeds(−v, v)"],
          rows: [
            ["1000", "≈ 0.04 m/s", "≈ 10 °/s"],
            ["2000", "≈ 0.16 m/s", "≈ 110 °/s"],
            ["3000", "≈ 0.28 m/s", "≈ 215 °/s"],
            ["4000", "≈ 0.40 m/s", "≈ 325 °/s"],
            ["5000", "≈ 0.53 m/s", "≈ 430 °/s"],
            ["6000", "≈ 0.65 m/s", "≈ 550 °/s"],
          ],
        },
      },
      {
        p: "Below about ±1000 the robot hardly moves: gearbox friction eats the power. From standstill, full power reaches 0.40 m/s after 0.1 s and 0.56 m/s after 0.2 s.",
      },
      { h: "Turning", id: "turning" },
      {
        list: [
          "**On the spot:** `set_speeds(-s, s)` turns left, `set_speeds(s, -s)` turns right.",
          "**Pivot:** `set_speeds(0, 6000)` turns left around a point near the left track (the robot's centre moves on a circle of about 6 cm).",
          "**Arcs:** both tracks forward at different speeds. `(3000, 6000)` drives a left curve of about 20 cm radius at 0.47 m/s, `(4500, 6000)` one of about 85 cm.",
          "Turning left gives a positive gyro z; for exact angles see [IMU](doc:imu#turn).",
        ],
      },
      { h: "Braking", id: "braking" },
      {
        p: "Speed 0 brakes: the driver shorts the motor. From full speed the robot stops within about **4 cm** (0.2 s); from 3000 within 1.5 cm. Reversing at full power instead stops it within about **2 cm**. Keep that in mind at the dohyo border: the line sensors sit only 1.2 cm behind the front edge of the blade.",
      },
      { h: "Straight is not perfectly straight", id: "straight" },
      {
        p: "No two motors are exactly alike. In the simulator each motor's strength differs by a few percent (new for every run), and `set_speeds(4000, 4000)` drifts up to about 2 cm sideways per metre. Real robots may drift more. If you need a straight line, correct with the encoders ([example](doc:encoders#straight)) or the gyro.",
      },
      { h: "Battery", id: "battery" },
      {
        table: {
          head: ["World → Battery", "Voltage at rest", "Top speed"],
          rows: [
            ["full", "5.2 V", "0.65 m/s"],
            ["60 %", "≈ 4.96 V", "0.61 m/s"],
            ["25 %", "≈ 4.75 V", "0.58 m/s"],
            ["empty", "4.6 V", "0.56 m/s"],
          ],
        },
      },
      {
        p: "The voltage also sags while the motors draw current (≈ 5.13 V at full speed with fresh cells). Lower voltage means less speed **and** less pushing force, so test timings with a weak battery too ([robustness](doc:robustness)).",
      },
      { h: "Pushing", id: "pushing" },
      {
        p: "Pushing force comes from the motors and the grip of the tracks (*World → Floor grip* changes the grip). Head-on, power decides little: the blade that is lower where the two blades meet gets under the other, and its robot pushes the other out. Blade edges differ between robots by tenths of a millimetre in height and tilt (in the simulator: new for every run), so the angle and the spot of a hit matter. Hits at an angle or into the side are much harder to resist than blade against blade.",
      },
      { h: "flip_left / flip_right", id: "flip" },
      { p: "If a motor is wired the other way round, `motors.flip_left(True)` (or `flip_right(True)`) inverts its direction for all later calls." },
    ],
  },
  {
    id: "line-sensors",
    group: "Programming the Zumo",
    title: "Line sensors",
    summary: "Raw values on white, grey and black, a calibration that covers all five sensors, line position and edge detection.",
    blocks: [
      {
        p: "Five IR reflectance sensors look at the floor: **DN1** (left) to **DN5** (right), in a row 4.7 cm ahead of the robot's centre, 17.5 mm apart. Each one shines IR light down and measures how long the reflected light takes to discharge a capacitor: a bright surface reflects a lot (small value), a dark one little (large value). `line.read()` returns the five raw values, always after about 1.06 ms.",
      },
      { h: "Raw values", id: "raw" },
      {
        table: {
          head: ["Surface", "Raw value (simulator)", "Where"],
          rows: [
            ["white", "≈ 100 – 135", "dohyo border, line track board, table tops"],
            ["grey", "≈ 250 – 340", "King of the Hill zone, shuttle bases"],
            ["black", "1024", "dohyo ring, tape, edge bands, and the brown start lines in the dohyo"],
            ["nothing below", "1024", "past the edge of a table or ring, or the robot is lifted"],
          ],
        },
      },
      {
        p: "Each sensor sees a light spot of about 5 mm, so while a sensor moves over a tape edge its value ramps up over about 3 mm (for example 107 → 150 → 327 → 1024). The sensors also differ a little from each other — one reason to calibrate.",
      },
      {
        note: "`read()` returns **the same array object** every time, and `read_calibrated()` writes into it too. After `a = line.read()` and `b = line.read()`, `a` and `b` are the same array with the newest values. Use `list(line.read())` to keep a copy.",
        kind: "warn",
      },
      { h: "Calibration", id: "calibration" },
      {
        p: "`line.calibrate()` reads all sensors 10 times (≈ 14 ms) and widens each sensor's range: `cal_max` grows to the *smallest* of the 10 readings, `cal_min` shrinks to the *largest*. That makes it robust against single noisy readings, but it also means **a sensor must stay over the dark line for a whole `calibrate()` call** to record it. Turn at a moderate speed: 2000 works well.",
      },
      {
        p: "Afterwards `read_calibrated()` maps every sensor from its min (0) to its max (1000). A sensor whose `cal_max` is not above its `cal_min` returns 0 forever.",
      },
      { h: "How far to turn", id: "sweep" },
      {
        p: "With the robot centred on a line, a sensor 4.7 cm ahead and *d* to the side reaches the line after turning by atan(*d* / 4.7 cm): about 20° for the inner sensors (1.75 cm) and **37° for the outer ones** (3.5 cm). To get the outer sensors fully over a 19 mm tape, sweep about **±55°**. A sweep of ±30° leaves DN1 and DN5 uncalibrated.",
      },
      { title: "Fragment · calibration sweep and check", code: CALIBRATION_SWEEP },
      {
        note: "The sweep is measured from where the robot points at the start. Put it on the tape and pointing along it: a robot that starts 15° off leaves one outer sensor uncalibrated. Print `cal_max` after calibrating — every value should be close to 1024 — and sweep further if one is not.",
        kind: "warn",
      },
      { h: "Line position", id: "position" },
      {
        title: "Fragment · position with a lost-line check",
        code: `v = line.read_calibrated()
total = v[0] + v[1] + v[2] + v[3] + v[4]
if total > 300:
    position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
else:
    position = None          # no line under the sensors
`,
      },
      {
        p: "0 = under DN1, 2000 = centred, 4000 = under DN5. With a 19 mm tape and 17.5 mm sensor spacing, at least one sensor is over the tape whenever the tape is under the sensor row.",
      },
      { h: "Edge detection on the dohyo", id: "edge" },
      {
        p: "On the official dohyo the ring is black (1024) and the 2.5 cm border white (≈ 110). Raw values are good enough: `v[i] < 500` means *border under sensor i*. The left sensors (DN1, DN2) and the right ones (DN4, DN5) tell you which way to turn away.",
      },
      {
        title: "Fragment · where is the border?",
        code: `EDGE = 500
v = line.read()
left_edge = v[0] < EDGE or v[1] < EDGE
right_edge = v[3] < EDGE or v[4] < EDGE
ahead = v[2] < EDGE
`,
      },
      {
        list: [
          "The sensors sit 1.2 cm behind the front of the blade, and the robot needs 2–4 cm to stop from full speed. At full speed you see the border for less than 40 ms: check it in every loop, without long sleeps.",
          "A sensor past the outer edge of the ring has nothing below it and reads 1024, like black. A border you miss is not seen again.",
          "Lifted by the opponent's blade, the sensors read 1024 too: on the official dohyo that looks like the safe black ring.",
          "The two brown start lines (shikiri) in the middle read 1024, like black.",
        ],
      },
      {
        p: "On the **inverse dohyo** (white ring, black border) it is the other way round: `v[i] > 600` is the edge. There the brown start lines and a lifted sensor look like the edge too, so make sure your robot does not flee from the start lines.",
      },
      { h: "Grey", id: "grey" },
      {
        p: "Grey areas (King of the Hill zone, shuttle bases) read about 300 raw. To tell white, grey and black apart use two thresholds, for example below 200 = white, 200–600 = grey, above 600 = black.",
      },
      { h: "Emitters off", id: "emitters" },
      {
        p: "`line.start_read(emitters_on=False)` makes the next `read()` measure without the IR emitters, which shows ambient light only. The simulator has no ambient light, so all five values are 1024 then.",
      },
    ],
  },
  {
    id: "proximity",
    group: "Programming the Zumo",
    title: "Proximity sensors",
    summary: "How the counts work, what they see at which distance and angle, steering towards an opponent, and faster reads.",
    blocks: [
      {
        p: "The Zumo has three IR receivers on its front sensor array — looking left, forward and right — and two groups of IR LEDs, a left and a right one. `prox.read()` flashes the left LEDs at six increasing brightness levels, then the right LEDs, and counts for each receiver at how many levels it saw a reflection. A close or bright object reflects even the weakest flash (count 6); a far one only the strongest (count 1).",
      },
      { h: "Six counts", id: "counts" },
      {
        table: {
          head: ["Receiver", "Lit by the left LEDs", "Lit by the right LEDs"],
          rows: [
            ["left", "`left_counts_with_left_leds()`", "`left_counts_with_right_leds()` (usually 0)"],
            ["front", "`front_counts_with_left_leds()`", "`front_counts_with_right_leds()`"],
            ["right", "`right_counts_with_left_leds()` (usually 0)", "`right_counts_with_right_leds()`"],
          ],
        },
      },
      {
        p: "The side receivers only see what their own side's LEDs light, so use `left_counts_with_left_leds()` and `right_counts_with_right_leds()` for the sides. The front receiver gets two useful counts, and their difference tells you where the object is.",
      },
      { h: "Range", id: "range" },
      { p: "Front counts (left LEDs / right LEDs) for another Zumo straight ahead, simulator with sensor noise off:" },
      {
        table: {
          head: ["Gap between the robots", "Facing you (blade first)", "Side towards you", "Back towards you"],
          rows: [
            ["5 cm", "6 / 6", "5 / 5", "5 / 5"],
            ["10 cm", "5 / 5", "4 / 4", "4 / 4"],
            ["15 cm", "4 / 4", "3 / 2", "3 / 3"],
            ["20 cm", "4 / 4", "1 / 1", "2 / 2"],
            ["25 cm", "3 / 3", "0", "0"],
            ["30 cm", "1 / 1", "0", "0"],
            ["35 cm and more", "0", "0", "0"],
          ],
        },
      },
      {
        p: "The steel blade reflects best and the dark tracks worst, so a robot facing you is seen from furthest away. With normal sensor noise the counts flicker by about one (at 25 cm: 2 or 3). Side receivers: a Zumo beside you, facing you, gives 6 up to about 16 cm centre to centre, 5 at 20 cm and 3 at 30 cm.",
      },
      {
        p: "Not seen in the simulator: the floor and table edges (the receivers look horizontally, 13 mm above the floor — unless your robot is tilted), ambient light, and the IR flashes of other robots.",
      },
      { h: "Where is the opponent?", id: "bearing" },
      { p: "Counts for a Zumo 20 cm away (centre to centre), facing you, at different angles (positive = to your left):" },
      {
        table: {
          head: ["Angle", "left (left LEDs)", "front, left LEDs", "front, right LEDs", "right (right LEDs)"],
          rows: [
            ["60° right", "0", "0", "2", "5"],
            ["40° right", "0", "0", "5", "5"],
            ["25° right", "0", "4", "5", "4"],
            ["15° right", "0", "5", "6", "2"],
            ["ahead", "0", "5", "5", "0"],
            ["15° left", "2", "6", "5", "0"],
            ["25° left", "4", "5", "4", "0"],
            ["40° left", "5", "5", "0", "0"],
            ["60° left", "5", "2", "0", "0"],
          ],
        },
      },
      {
        p: "So: front left-LED count higher → turn a little left, right-LED count higher → a little right; a side count → turn hard towards that side. `prox.angle_estimate()` combines all counts into one rough angle (−90 = left … +90 = right; this sign is the opposite of the gyro's).",
      },
      {
        title: "Fragment · steering towards the opponent",
        code: `prox.read()
fl = prox.front_counts_with_left_leds()
fr = prox.front_counts_with_right_leds()
if fl + fr >= 4:                    # in front
    turn = 800 * (fr - fl)          # > 0: opponent right of centre
    motors.set_speeds(5000 + turn, 5000 - turn)
elif prox.left_counts_with_left_leds() > 0:
    motors.set_speeds(-4000, 4000)  # turn left towards it
elif prox.right_counts_with_right_leds() > 0:
    motors.set_speeds(4000, -4000)  # turn right towards it
`,
      },
      { h: "Faster reads", id: "faster" },
      {
        p: "A read takes about 7 ms: 2 LED groups × 6 levels × 0.57 ms, plus overhead. With fewer levels it is faster, at the price of a coarser distance:",
      },
      {
        title: "Fragment · three levels",
        code: `prox.brightness_levels = [1000, 3500, 7563]   # 3 levels: counts 0 ... 3
prox.read()                                    # about 3.6 ms instead of 7 ms
`,
      },
      {
        p: "`prox.set_frequency()` changes the pulse timing too; leave it at the default 56 kHz (the simulator does not model how sensitive the receivers are at other frequencies).",
      },
      { h: "Timing", id: "timing" },
      {
        p: "Your robot keeps moving during the 7 ms read; the counts describe the scene about halfway through it. At full speed that is about 2 mm of travel — fine for sumo, but one more reason to check the line sensors right before and after.",
      },
    ],
  },
  {
    id: "imu",
    group: "Programming the Zumo",
    title: "IMU: gyro, accelerometer, compass",
    summary: "Switch the IMU on, turn by exact angles with the gyro, detect hits with the accelerometer, and use data_ready().",
    blocks: [
      {
        p: "The IMU has three sensors: a **gyro** (turn rate in °/s), an **accelerometer** (acceleration in g, including gravity) and a **magnetometer** (magnetic field in gauss). Their axes are fixed to the robot: **x forward, y left, z up**.",
      },
      { h: "Switch it on", id: "enable" },
      {
        title: "Fragment · setup",
        code: `imu = robot.IMU()
imu.reset()
imu.enable_default()   # acc 52 Hz +-2 g, gyro 208 Hz +-2000 deg/s, mag 10 Hz +-4 gauss
`,
      },
      {
        p: "Without `enable_default()` every reading is 0. `imu.read()` reads all three sensors (≈ 0.77 ms); reading only the one you need is faster: `imu.gyro.read()` (≈ 0.27 ms). The results are lists `[x, y, z]` in `imu.gyro.last_reading_dps`, `imu.acc.last_reading_g` and `imu.mag.last_reading_gauss`.",
      },
      { h: "Output data rate and data_ready()", id: "odr" },
      {
        p: "Each sensor measures at its output data rate (ODR): after `enable_default()` the gyro 208 times per second, the accelerometer 52 and the magnetometer 10. `imu.gyro.data_ready()` is `True` when a new sample has arrived since your last read. The real IMU returns the same sample again if you read faster than its ODR — so loops that add up samples (gyro integration) should read only when `data_ready()` says so. (The simulator returns fresh values on every read; code that ignores `data_ready()` can therefore behave differently on the robot.) Change the rate with `set_output_data_rate(hz)`, see the [IMU reference](doc:ref-imu).",
      },
      { h: "Turning by an exact angle", id: "turn" },
      {
        p: "The gyro's z value is the turn rate (positive = left). Adding up rate × time gives the angle turned. Every gyro has a small offset (bias): it reports a few tenths of °/s while standing still, which adds up to degrees within a minute. Measure the bias at the start while the robot stands still, and subtract it.",
      },
      {
        title: "gyro_turn.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

motors = robot.Motors()
imu = robot.IMU()
imu.reset()
imu.enable_default()


def gyro_bias(samples=100):
    # average turn rate while standing still (the robot must not move)
    total = 0.0
    n = 0
    while n < samples:
        if imu.gyro.data_ready():
            imu.gyro.read()
            total += imu.gyro.last_reading_dps[2]
            n += 1
    return total / n


def turn(degrees, speed=3000):
    # turn on the spot by \`degrees\` (positive = left), measured with the gyro
    direction = 1 if degrees > 0 else -1
    target = abs(degrees) - 6        # the robot coasts a few degrees after braking
    angle = 0.0
    last = time.ticks_us()
    motors.set_speeds(-speed * direction, speed * direction)
    while abs(angle) < target:
        if imu.gyro.data_ready():
            imu.gyro.read()
            now = time.ticks_us()
            dt = time.ticks_diff(now, last) / 1000000
            last = now
            angle += (imu.gyro.last_reading_dps[2] - bias) * dt
    motors.off()


bias = gyro_bias()
print("gyro bias %.2f deg/s" % bias)
turn(90)
time.sleep_ms(500)
turn(-180)
time.sleep_ms(500)
`,
      },
      {
        p: "In the simulator `turn(90)` ends within a degree or two of 90°. The robot keeps turning a few degrees after `motors.off()` — that is the `- 6` in the code; tune it for your speed and your robot.",
      },
      { h: "Detecting hits", id: "hits" },
      {
        p: "A push accelerates your robot in the direction of the push: hit from behind → positive x, from the front → negative x, from the right → positive y (you are shoved to the left). The accelerometer also feels your own acceleration (up to about 0.6 g when you start at full power) and gravity on z.",
      },
      {
        title: "hit_detector.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

imu = robot.IMU()
leds = robot.RGBLEDs()
imu.reset()
imu.enable_default()
imu.acc.set_output_data_rate(416)   # more samples: short knocks are not missed
imu.acc.set_full_scale(16)          # hard knocks exceed 2 g

HIT_G = 0.6     # sideways/forward kick in g that counts as a hit

while True:
    if not imu.acc.data_ready():
        continue
    imu.acc.read()
    ax, ay, az = imu.acc.last_reading_g
    if ax * ax + ay * ay > HIT_G * HIT_G:
        # a push moves us in the direction of the force
        if abs(ax) > abs(ay):
            where = "from behind" if ax > 0 else "from the front"
        else:
            where = "from the right" if ay > 0 else "from the left"
        print("hit", where, "x %.2f y %.2f" % (ax, ay))
        leds.set(0, [255, 0, 0])
        leds.show()
        time.sleep_ms(200)          # ignore the rest of this impact
        leds.off()
`,
      },
      {
        p: "Hard knocks exceed ±2 g, so this example sets the range to ±16 g, and 416 Hz so that short knocks are not missed between samples. Run it on the dohyo against an aggressive opponent: the console reports where the hits come from. In your own program, ignore the accelerometer while you accelerate yourself.",
      },
      { h: "Compass", id: "compass" },
      {
        p: "The magnetometer measures the earth's magnetic field plus offsets from the robot itself. In the simulator it is a constant field with a small per-robot offset, so its x and y values change smoothly with your heading. On a real robot, motors, steel and the room disturb it a lot; for turning, the gyro is far more reliable.",
      },
      { h: "Check the signs on the real robot", id: "signs" },
      {
        p: "The axis directions above are how the simulator models the IMU. Verify them once on your robot: turn it left by hand and check that `gyro.last_reading_dps[2]` is positive; lay it flat and check that `acc.last_reading_g[2]` is about +1.",
      },
    ],
  },
  {
    id: "encoders",
    group: "Programming the Zumo",
    title: "Encoders",
    summary: "Counts per revolution and per metre, driving a distance straight, measuring speed, and why encoder turns are inaccurate.",
    blocks: [
      {
        p: "Each motor has an encoder. `encoders.get_counts()` returns how far the left and right sprockets have turned since the start, as a tuple `(left, right)`; forward is positive.",
      },
      {
        table: {
          head: ["Quantity", "Value"],
          rows: [
            ["counts per sprocket revolution", "909.7 (12 per motor turn × 75.81 gear ratio)"],
            ["track travel per revolution", "≈ 10.7 cm"],
            ["counts per metre", "≈ 8470"],
            ["one count", "≈ 0.12 mm"],
          ],
        },
      },
      { p: "`get_counts(reset=True)` returns the counts and restarts both counters at 0. A read takes about 0.06 ms, so you can read them in every loop." },
      { h: "Drive a distance, straight", id: "straight" },
      {
        title: "drive_cm.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

motors = robot.Motors()
encoders = robot.Encoders()

COUNTS_PER_CM = 84.7     # 8470 counts per metre; check on your robot
KP = 2                   # speed correction per count of left/right difference


def drive_cm(cm, speed=3000):
    # drive straight ahead; the encoders keep both tracks in step
    encoders.get_counts(reset=True)
    goal = cm * COUNTS_PER_CM
    while True:
        left, right = encoders.get_counts()
        if (left + right) / 2 >= goal:
            break
        diff = left - right               # > 0: left track is ahead, slow it down
        motors.set_speeds(speed - KP * diff, speed + KP * diff)
        time.sleep_ms(5)
    motors.off()


start = time.ticks_ms()
drive_cm(30)
print("30 cm took", time.ticks_diff(time.ticks_ms(), start), "ms")
time.sleep_ms(300)
print("counts after stopping", encoders.get_counts())
`,
      },
      {
        p: "The robot stops about 1.5 cm past the goal at speed 3000 (braking takes a moment) — subtract that or slow down near the goal. The `KP` correction keeps both tracks at the same count, which keeps the robot straight.",
      },
      { h: "Speed", id: "speed" },
      {
        title: "Fragment · speed in m/s",
        code: `left0, right0 = encoders.get_counts()
time.sleep_ms(50)
left1, right1 = encoders.get_counts()
speed = ((left1 - left0) + (right1 - right0)) / 2 / 8470 / 0.05   # m/s
`,
      },
      { h: "Slip and skid", id: "slip" },
      {
        p: "Encoders measure the sprockets, not the ground. When the tracks slip (pushing a robot that does not give way, spinning on a dusty floor), the counts keep growing although the robot does not move. Comparing the encoder speed with the proximity counts or the accelerometer tells you that you are stuck.",
      },
      {
        p: "Turning on the spot, the tracks skid sideways: in the simulator a turn needs about 30 % more counts than the track geometry suggests (about 8 counts per degree on each track at speed 3000), and the factor changes with floor and speed. For turns, the [gyro](doc:imu#turn) is more reliable.",
      },
    ],
  },
  {
    id: "display-leds-buzzer",
    group: "Programming the Zumo",
    title: "Display, LEDs and buzzer",
    summary: "Show what your robot is thinking: OLED text and graphics, RGB LED colours, and the buzzer's music language.",
    blocks: [
      { p: "During a match you cannot read the console of the real robot. The display, the LEDs and the buzzer are how it tells you what it is doing." },
      { h: "Display", id: "display" },
      {
        p: "128 × 64 pixels, 8 × 8 font (16 characters × 8 lines). Draw into the buffer, then call `show()` (≈ 4 ms). In a fast loop update the display only when something changed, or every 100 ms: at full speed, 4 ms is 2.6 mm of travel.",
      },
      {
        title: "Fragment · a status screen, at most 10 times per second",
        code: `last_draw = time.ticks_ms()

# ... inside the main loop:
if time.ticks_diff(time.ticks_ms(), last_draw) > 100:
    last_draw = time.ticks_ms()
    display.fill(0)
    display.text("state %d" % state, 0, 0)
    display.text("front %d %d" % (fl, fr), 0, 10)
    display.fill_rect(0, 24, v[2] // 8, 6, 1)     # bar: middle line sensor
    display.show()
`,
      },
      {
        p: "Graphics: `pixel`, `hline`, `vline`, `line`, `rect`, `fill_rect`, `ellipse`, `poly`, `scroll`, `blit` ([Display reference](doc:ref-display)). `display.invert(True)` inverts the screen at once, `display.flip()` turns the picture upside down.",
      },
      { h: "RGB LEDs", id: "leds" },
      {
        p: "Six RGB LEDs, numbered 0–5 (in the 3D view 0–2 at the rear, 3–5 at the front). `leds.set(i, [r, g, b])` with 0–255 per colour, then `leds.show()` (≈ 0.08 ms). That is far cheaper than the display, which makes the LEDs ideal to show the state of a state machine.",
      },
      {
        title: "led_colours.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

leds = robot.RGBLEDs()
leds.set_brightness(10)        # 0 ... 31


def all_leds(rgb):
    for i in range(6):
        leds.set(i, rgb)
    leds.show()


for colour in ([255, 0, 0], [0, 255, 0], [0, 0, 255]):
    all_leds(colour)
    time.sleep_ms(500)
for hue in range(0, 360, 10):          # colour wheel on LED 4
    leds.set_hsv(4, [hue, 255, 255])
    leds.show()
    time.sleep_ms(30)
leds.off()
`,
      },
      { p: "There is also a yellow LED: `robot.YellowLED()` with `on()` and `off()`." },
      { h: "Buzzer", id: "buzzer" },
      {
        p: "`buzzer.play(notes)` plays a melody and blocks until it ends; `buzzer.play_in_background(notes)` returns at once — use that one while driving. `buzzer.beep()` beeps for 100 ms (and blocks that long). The simulator plays the sound through your speakers while **Sound** is on.",
      },
      { h: "The music language", id: "music" },
      {
        table: {
          head: ["Write", "Meaning", "Default"],
          rows: [
            ["`c d e f g a b`", "a note; `#` or `+` after it = sharp, `-` = flat: `c#`, `b-`", ""],
            ["number after a note", "length: 1 = whole, 2 = half, 4 = quarter, 8 = eighth, 16 …, e.g. `c8`", "the `L` value"],
            ["`.` after a note", "dotted: 1.5 × as long, `c4.`", ""],
            ["`r`", "rest (silence), with a length like a note: `r8`", ""],
            ["`T` + number", "tempo in quarter notes per minute: `T180`", "120"],
            ["`L` + number", "length of notes without a number: `L16`", "4"],
            ["`O` + number", "octave: in `O4` the note a is 440 Hz; `O5` is one octave higher", "4"],
            ["`>` · `<`", "the **next note only** one octave higher · lower: `>c`", ""],
            ["`V` + number", "volume 0 … 15", "15"],
            ["`MS` · `ML`", "staccato (each note half sound, half silence) · legato (normal)", "legato"],
            ["`!`", "reset octave, tempo, length, volume and staccato to the defaults", ""],
          ],
        },
      },
      { p: "Upper and lower case are the same; spaces are ignored." },
      {
        title: "buzzer_demo.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

buzzer = robot.Buzzer()
buzzer.play("T240 L8 V12 c e g >c")          # rising chord, blocks
time.sleep_ms(300)
buzzer.play("!T120 L4 MS c c g g a a g2")    # staccato melody
buzzer.play_in_background("!L16 V10 a")      # short beep, does not block
time.sleep_ms(200)
`,
      },
    ],
  },
  {
    id: "state-machines",
    group: "Programming the Zumo",
    title: "State machines",
    summary: "Organise behaviour as states and transitions: a SEARCH / ATTACK / ESCAPE sumo bot and a FOLLOW / LOST line follower.",
    blocks: [
      {
        p: "A robot does different things at different times: search, attack, escape from the edge. Written with `sleep_ms`, your robot is blind while it sleeps. A **state machine** stores what the robot is doing in a variable (`state`) and checks the sensors in every loop. Each loop: read the sensors → maybe switch state → act according to the state.",
      },
      { h: "Sumo: SEARCH, ATTACK, ESCAPE", id: "sumo" },
      {
        table: {
          head: ["State", "Does", "Leaves when"],
          rows: [
            ["SEARCH", "turns on the spot, towards a side that sees something", "front counts ≥ 4 → ATTACK · border → ESCAPE"],
            ["ATTACK", "full power, steering by the front counts", "front counts < 2 → SEARCH · border → ESCAPE"],
            ["ESCAPE", "reverses for 150 ms, then turns away for 200 ms — timed with `ticks_diff`, not `sleep`", "time is up → SEARCH"],
          ],
        },
      },
      {
        title: "sumo_state_machine.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
prox = robot.ProximitySensors()
leds = robot.RGBLEDs()
display = robot.Display()
button_a = robot.ButtonA()

EDGE = 500          # raw line value below this = white border
FULL = 6000
SEARCH_SPEED = 2500
STEER = 800
BACK_MS = 150       # ESCAPE: reverse this long ...
TURN_MS = 200       # ... then turn away this long

SEARCH, ATTACK, ESCAPE = 0, 1, 2
COLOURS = ([0, 40, 0], [255, 0, 0], [0, 0, 255])   # green, red, blue

state = SEARCH
state_start = 0
search_dir = 1      # 1 = turn right, -1 = turn left


def set_state(new):
    global state, state_start
    state = new
    state_start = time.ticks_ms()
    for i in range(6):
        leds.set(i, COLOURS[new])
    leds.show()     # LEDs take 0.1 ms; the display would take 4 ms


def time_in_state():
    return time.ticks_diff(time.ticks_ms(), state_start)


display.fill(0)
display.text("Press A", 0, 0)
display.show()
while not button_a.check():
    time.sleep_ms(10)
time.sleep_ms(5000)             # sumo rule: no movement for 5 s
set_state(SEARCH)

try:
    while True:
        # Edge check in every state, as often as possible
        v = line.read()
        edge_left = v[0] < EDGE or v[1] < EDGE
        edge_right = v[2] < EDGE or v[3] < EDGE or v[4] < EDGE
        if state != ESCAPE and (edge_left or edge_right):
            search_dir = 1 if edge_left else -1   # turn away from the border
            set_state(ESCAPE)

        if state == ESCAPE:
            t = time_in_state()
            if t < BACK_MS:
                motors.set_speeds(-FULL, -FULL)
            elif t < BACK_MS + TURN_MS:
                motors.set_speeds(FULL * search_dir, -FULL * search_dir)
            else:
                set_state(SEARCH)
            continue        # no proximity read while escaping: faster edge checks

        prox.read()
        fl = prox.front_counts_with_left_leds()
        fr = prox.front_counts_with_right_leds()

        if state == SEARCH:
            if fl + fr >= 4:
                set_state(ATTACK)
            else:
                l = prox.left_counts_with_left_leds()
                r = prox.right_counts_with_right_leds()
                if l > r:
                    search_dir = -1
                elif r > l:
                    search_dir = 1
                motors.set_speeds(SEARCH_SPEED * search_dir, -SEARCH_SPEED * search_dir)

        elif state == ATTACK:
            if fl + fr < 2:             # lost it (hysteresis: enter at 4, leave below 2)
                set_state(SEARCH)
            else:
                d = fl - fr
                motors.set_speeds(FULL - STEER * max(0, d), FULL - STEER * max(0, -d))
finally:
    motors.off()
`,
      },
      {
        list: [
          "`set_state()` remembers when the state started, `time_in_state()` says how long ago. Timed actions (reverse 150 ms) need no `sleep`, so the loop keeps running and keeps checking the edge.",
          "Hysteresis: ATTACK starts at 4 counts and ends below 2. With a single threshold the robot would flip between the states whenever a count flickers.",
          "The LEDs show the state (green search, red attack, blue escape) — in the 3D view, on the real robot and when you scrub the timeline.",
          "During ESCAPE the loop skips the 7 ms proximity read, so it checks the edge several hundred times per second instead of about 120.",
        ],
      },
      { h: "Line following: FOLLOW and LOST", id: "line" },
      {
        title: "line_state_machine.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
button_a = robot.ButtonA()

BASE = 3000
KP = 1.2
KD = 8
LOST_LIMIT = 300      # sum of calibrated values below this = no line
GIVE_UP_MS = 2000     # stop after searching this long

FOLLOW, LOST, STOPPED = 0, 1, 2
state = FOLLOW
lost_since = 0
last_error = 0


def sweep(left, right, ms):
    motors.set_speeds(left, right)
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < ms:
        line.calibrate()


while not button_a.check():
    time.sleep_ms(10)
sweep(-2000, 2000, 550)
sweep(2000, -2000, 1100)
sweep(-2000, 2000, 550)
motors.off()

try:
    while state != STOPPED:
        v = line.read_calibrated()
        total = v[0] + v[1] + v[2] + v[3] + v[4]

        if state == FOLLOW:
            if total < LOST_LIMIT:
                state = LOST
                lost_since = time.ticks_ms()
            else:
                position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
                error = position - 2000
                correction = KP * error + KD * (error - last_error)
                last_error = error
                motors.set_speeds(BASE + correction, BASE - correction)

        elif state == LOST:
            if total >= LOST_LIMIT:
                state = FOLLOW
            elif time.ticks_diff(time.ticks_ms(), lost_since) > GIVE_UP_MS:
                state = STOPPED
            elif last_error > 0:
                motors.set_speeds(2500, -2500)   # line was right: turn right
            else:
                motors.set_speeds(-2500, 2500)
    print("line lost for good, stopping")
finally:
    motors.off()
`,
      },
      { p: "LOST spins towards the side where the line was seen last and gives up after 2 s instead of wandering off the board." },
      { h: "Tips", id: "tips" },
      {
        list: [
          "Draw the states and the arrows between them on paper first.",
          "Name the states with constants (`SEARCH, ATTACK, ESCAPE = 0, 1, 2`) and print the state when it changes: the console then tells the story of every match.",
          "Keep the edge check outside the state logic, so it works in every state.",
        ],
      },
    ],
  },
  {
    id: "memory",
    group: "Programming the Zumo",
    title: "Memory and performance",
    summary: "How much memory your program has, what MemoryError means, and how to keep loops fast and free of allocations.",
    blocks: [
      {
        p: "The RP2040 has little RAM for Python objects. The simulator uses the same kind of fixed heap: about 212 KB, of which roughly **160 KB are free** when your program starts (the rest holds the library and the simulator's runtime; the heap is sized so that the free amount is close to the robot's — check `gc.mem_free()` there). When the heap is full, MicroPython raises `MemoryError`.",
      },
      {
        title: "memory.py",
        insert: true,
        code: `import gc
from zumo_2040_robot import robot

gc.collect()
print("free:", gc.mem_free(), "bytes  used:", gc.mem_alloc(), "bytes")
`,
      },
      { h: "Garbage collection", id: "gc" },
      {
        p: "Every new object — a string, a list, a tuple, a float result — takes heap memory. When the heap fills up, MicroPython pauses and frees the objects nobody uses any more. That is automatic, but on the robot a collection can pause your program for a moment (in the simulator it costs almost no robot time). Loops that allocate little run smoother.",
      },
      { h: "Allocation-free loops", id: "tips" },
      {
        list: [
          "Create objects (hardware, lists, buffers) once before the loop and reuse them.",
          "`line.read()` reuses one array instead of creating a new one. Avoid `list(line.read())` in the loop unless you really need a copy.",
          "Build strings (`'%d' % x`, formatted prints) only when needed, e.g. every 100 ms, not in every loop.",
          "Integer arithmetic on small numbers allocates nothing; every float result is a new object. Positions and errors as integers (like the 0–4000 line position) are cheap.",
          "Lists that only grow (logging every reading) end in a `MemoryError`. Use a fixed-size buffer and overwrite it.",
        ],
      },
      {
        title: "Fragment · a fixed-size log",
        code: `from array import array

LOG = array("h", [0] * 500)   # 500 values, allocated once
n = 0

# ... inside the main loop:
LOG[n % 500] = error          # overwrite the oldest value
n += 1
`,
      },
      { h: "MemoryError", id: "memoryerror" },
      {
        p: "The traceback shows the line where memory ran out, which is often not the line that wasted it. Look for lists or strings that grow in the loop. Printing `gc.mem_free()` once per second shows whether free memory goes down steadily (a leak) or in a saw-tooth (normal: allocation and collection).",
      },
      { h: "Speed", id: "speed" },
      {
        list: [
          "The big costs are the sensor reads ([table](doc:timing#costs)): read each sensor once per loop and keep the values in variables.",
          "`display.show()` costs 4 ms: update the display a few times per second at most.",
          "`@micropython.native` and `@micropython.viper` make functions faster on the robot. The simulator accepts them but runs such functions as normal bytecode, so they are slower in the simulator than on the robot.",
          "Floats: the simulator computes with double precision, the robot with single precision (about 7 significant digits). Do not count up something exact in a float for a long time (like microseconds); use integers.",
        ],
      },
    ],
  },
  {
    id: "common-mistakes",
    group: "Programming the Zumo",
    title: "Common mistakes",
    summary: "Problems almost every team runs into once, and how to avoid them.",
    blocks: [
      { h: "The display stays empty", id: "show" },
      { p: "Drawing only changes a buffer in memory. Call `display.show()` after drawing." },
      { h: "The robot drives on after the program ended", id: "drives-on" },
      {
        p: "Motors keep the speed you set last — after the end of the program and after an error too. Give your program an endless main loop and wrap it in `try: … finally: motors.off()` ([program structure](doc:program-structure#finally)).",
      },
      { h: "False start", id: "false-start" },
      {
        p: "In sumo, any motor speed other than 0 before the start signal or within 5 s after it is a false start — also a calibration spin or a tiny `set_speeds(100, 0)`. Wait for button A, then 5 s, then move.",
      },
      { h: "check() == False does not wait", id: "check" },
      {
        p: "`button_a.check()` returns `None` most of the time, `True` once on press and `False` once on release. `while button_a.check() == False:` therefore ends immediately (`None == False` is false). Write `while not button_a.check():`.",
      },
      { h: "Waiting for A forever after the start signal", id: "auto-a" },
      {
        p: "The start signal presses A once, for 0.1 s. A program that first does something long (a calibration sweep, a long sleep) and only then waits for A misses the press. Wait for A first, then calibrate — or press A again yourself (inspector or key A).",
      },
      { h: "Time calculations go wrong after a while", id: "ticks" },
      {
        p: "`time.ticks_us()` wraps around every 17.9 minutes (and on the robot it counts from power-on). `now - start` then gives nonsense; `time.ticks_diff(now, start)` does not ([timing](doc:timing#ticks)).",
      },
      { h: "The line follower is half blind", id: "calibration" },
      {
        p: "The calibration sweep was too small, so the outer sensors never saw the line and `read_calibrated()` returns 0 for them. Sweep about ±55° and print `line.cal_min` / `line.cal_max` ([how far to turn](doc:line-sensors#sweep)).",
      },
      { h: "The robot drives out of the ring at full speed", id: "out" },
      {
        p: "The edge is checked too rarely. At full speed the robot crosses the 2.5 cm border in under 40 ms. In the simulator a loop that sleeps 100 ms between line reads drives straight out; 30 ms is already borderline. Read the line sensors in every loop and avoid long sleeps while driving.",
      },
      { h: "Two readings are always equal", id: "same-array" },
      { p: "`line.read()` returns the same array every time. Keep a copy with `list(line.read())` if you want to compare old and new values." },
      { h: "The robot does not react while backing off", id: "blocking" },
      {
        p: "`time.sleep_ms()` and `buzzer.play()` block your program. During a 300 ms sleep nobody watches the edge or the opponent. Use a [state machine](doc:state-machines) for timed moves and `play_in_background()` for sounds.",
      },
      { h: "The IMU reads only zeros", id: "imu" },
      { p: "Call `imu.reset()` and `imu.enable_default()` before reading." },
      { h: "The motors stop for no reason", id: "motors-object" },
      { p: "Creating `robot.Motors()` stops the motors. Create it once at the top, never inside a loop or a function that runs often." },
      { h: "ZeroDivisionError in the line position", id: "zero" },
      { p: "When no sensor sees the line, the sum of the calibrated values is 0. Check `total` before dividing." },
      { h: "The robot flees from the start lines", id: "shikiri" },
      {
        p: "On the inverse dohyo (black edge) the brown start lines in the middle read black too. A robot that treats every dark reading as the edge backs away from them.",
      },
      { h: "Tuned in the simulator, fails on the robot", id: "real" },
      { p: "Thresholds, timings and gains need re-tuning on real hardware: [Sim vs. reality](doc:sim-vs-reality)." },
    ],
  },

  // ================================================================ Reference
  {
    id: "ref-motors",
    group: "Reference",
    title: "Motors",
    summary: "robot.Motors: set the speed of both tracks, brake, invert a motor.",
    blocks: [
      { p: "Speeds, turning, braking and battery effects with measured numbers: [Driving](doc:driving)." },
      { api: "Motors" },
    ],
  },
  {
    id: "ref-line-sensors",
    group: "Reference",
    title: "LineSensors",
    summary: "robot.LineSensors: five downward reflectance sensors, raw and calibrated reads.",
    blocks: [
      { p: "Values on the different surfaces, calibration and edge detection: [Line sensors](doc:line-sensors)." },
      { api: "LineSensors" },
    ],
  },
  {
    id: "ref-proximity",
    group: "Reference",
    title: "ProximitySensors",
    summary: "robot.ProximitySensors: three IR receivers and two LED groups that detect objects up to about 34 cm.",
    blocks: [
      { p: "Counts by distance and angle, steering and faster reads: [Proximity sensors](doc:proximity)." },
      { api: "ProximitySensors" },
    ],
  },
  {
    id: "ref-imu",
    group: "Reference",
    title: "IMU",
    summary: "robot.IMU: accelerometer, gyro and magnetometer with their rates, ranges and readings.",
    blocks: [
      {
        p: "`imu.acc`, `imu.gyro` and `imu.mag` are the three sensors; their methods are listed below with the sensor's name in front (`acc.read()` means `imu.acc.read()`). Turning with the gyro and detecting hits: [IMU guide](doc:imu).",
      },
      { api: "IMU" },
    ],
  },
  {
    id: "ref-encoders",
    group: "Reference",
    title: "Encoders",
    summary: "robot.Encoders: counts of both sprockets, about 8470 per metre.",
    blocks: [{ p: "Driving distances, speed and slip: [Encoders guide](doc:encoders)." }, { api: "Encoders" }],
  },
  {
    id: "ref-display",
    group: "Reference",
    title: "Display",
    summary: "robot.Display: the 128 × 64 OLED, a MicroPython FrameBuffer with text and graphics.",
    blocks: [
      { p: "Status screens and when to update them: [Display, LEDs and buzzer](doc:display-leds-buzzer#display)." },
      { api: "Display" },
    ],
  },
  {
    id: "ref-buttons",
    group: "Reference",
    title: "Buttons A, B, C",
    summary: "robot.ButtonA, ButtonB, ButtonC: debounced press and release events, long presses.",
    blocks: [
      {
        p: "All three buttons have the same methods. In the simulator they are the A/B/C buttons in the inspector and the keys A, B and C (held down as long as you hold the key); both act on the selected robot.",
      },
      { api: "ButtonA" },
      { h: "Long press", id: "long" },
      {
        title: "Fragment · A short = start, A long = calibrate",
        code: `while True:
    if button_a.is_long_pressed():
        mode = "calibrate"
        break
    if button_a.check() is False:      # released before the long press
        mode = "start"
        break
    time.sleep_ms(10)
`,
      },
    ],
  },
  {
    id: "ref-rgb-leds",
    group: "Reference",
    title: "RGBLEDs",
    summary: "robot.RGBLEDs: six colour LEDs with brightness, RGB and HSV colours.",
    blocks: [{ p: "Using the LEDs to show a state: [Display, LEDs and buzzer](doc:display-leds-buzzer#leds)." }, { api: "RGBLEDs" }],
  },
  {
    id: "ref-yellow-led",
    group: "Reference",
    title: "YellowLED",
    summary: "robot.YellowLED: the yellow user LED.",
    blocks: [{ p: "A single LED that costs almost no time to switch: handy as a heartbeat or to signal one condition." }, { api: "YellowLED" }],
  },
  {
    id: "ref-buzzer",
    group: "Reference",
    title: "Buzzer",
    summary: "robot.Buzzer: melodies in Pololu's music language, blocking or in the background.",
    blocks: [{ p: "The complete music language with all commands: [Display, LEDs and buzzer](doc:display-leds-buzzer#music)." }, { api: "Buzzer" }],
  },
  {
    id: "ref-battery",
    group: "Reference",
    title: "Battery",
    summary: "robot.Battery: the battery voltage in millivolts.",
    blocks: [
      { api: "Battery" },
      {
        table: {
          head: ["World → Battery", "At rest", "Top speed"],
          rows: [
            ["full", "≈ 5200 mV", "0.65 m/s"],
            ["60 %", "≈ 4960 mV", "0.61 m/s"],
            ["25 %", "≈ 4750 mV", "0.58 m/s"],
            ["empty", "≈ 4600 mV", "0.56 m/s"],
          ],
        },
      },
      { p: "`machine.ADC(26).read_u16()` reads the same voltage divided by 11, scaled to 0–65535 for 0–3.3 V." },
    ],
  },
  {
    id: "ref-time",
    group: "Reference",
    title: "time",
    summary: "The time module: sleeps and the millisecond and microsecond clocks with wrap-around-safe arithmetic.",
    blocks: [
      {
        p: "`import time` gives you MicroPython's time functions on the robot's clock. In the simulator the clock starts at 0 when you press ▶ Run; on the robot it counts from power-on.",
      },
      { api: "time" },
      {
        note: "`ticks_ms()`, `ticks_us()` and `ticks_cpu()` wrap around at 2³⁰. Subtract them only with `ticks_diff()` and add with `ticks_add()`.",
        kind: "warn",
      },
    ],
  },
  {
    id: "ref-other-modules",
    group: "Reference",
    title: "Other modules",
    summary: "What machine, rp2, micropython, random, math, gc, framebuf and the other standard modules offer in the simulator.",
    blocks: [
      { p: "Your program runs in MicroPython 1.29. Besides `zumo_2040_robot` and `time`, these modules are available in the simulator:" },
      {
        table: {
          head: ["Module", "In the simulator"],
          rows: [
            ["`math`, `cmath`", "complete: `sqrt`, `sin`, `atan2`, `degrees`, `radians`, `pi` …"],
            ["`random`", "`random()`, `randint(a, b)`, `randrange()`, `choice()`, `uniform()`, `getrandbits()`, `seed()`. Seeded from the run's seed, so a run can be replayed exactly."],
            ["`gc`", "`collect()`, `mem_free()`, `mem_alloc()`, `enable()`, `disable()`"],
            ["`array`, `struct`, `collections`, `heapq`, `json`, `re`, `binascii`, `hashlib`, `errno`, `io`, `sys`, `os`", "as in MicroPython"],
            ["`framebuf`", "complete; `robot.Display` is a FrameBuffer"],
            ["`micropython`", "`const()`, `schedule()`, `mem_info()`, `alloc_emergency_exception_buf()`. `@native`, `@viper` and `@asm_thumb` are accepted, but such functions run as normal (slower) bytecode."],
            ["`machine`", "see below"],
            ["`rp2`", "`bootsel_button()` (= button B). PIO and state machines are not available."],
            ["`asyncio`", "**not usable** in the simulator (the browser build of MicroPython has a different version); use a plain loop or a [state machine](doc:state-machines)"],
            ["`_thread`", "not available"],
          ],
        },
      },
      { h: "machine", id: "machine" },
      {
        table: {
          head: ["Part", "In the simulator"],
          rows: [
            ["`machine.Timer`", "works: periodic and one-shot callbacks on the robot's clock, run between two statements of your program, like an interrupt"],
            ["`machine.ADC(26)`", "battery voltage / 11 (`read_u16()`); other pins read 0"],
            ["`machine.Pin`", "exists so that code runs; values are stored but drive nothing"],
            ["`machine.PWM`, `SPI`, `UART`", "exist but do nothing"],
            ["`machine.I2C`", "`scan()` lists the IMU's addresses (0x1E, 0x6B); reading or writing any device raises `OSError: [Errno 19] ENODEV`. Extra sensors and shop parts on I2C are not simulated yet."],
            ["`machine.freq()`", "125000000 (125 MHz, like the RP2040)"],
            ["`machine.reset()`", "ends the program"],
          ],
        },
      },
      { h: "Timers", id: "timer" },
      {
        title: "timer_blink.py",
        insert: true,
        code: `from zumo_2040_robot import robot
from machine import Timer
import time

led = robot.YellowLED()
state = [0]


def blink(t):
    state[0] ^= 1
    led.value(state[0])


timer = Timer(period=250, mode=Timer.PERIODIC, callback=blink)   # every 250 ms
time.sleep_ms(3000)       # the main program can do anything meanwhile
timer.deinit()
led.off()
`,
      },
      {
        p: "Keep callbacks short: they interrupt your main program between two statements. `Timer(freq=100, callback=f)` works too, and `mode=Timer.ONE_SHOT` calls the function once. Stop a timer with `deinit()`.",
      },
      { h: "One file only", id: "files" },
      { p: "Each robot has exactly one program file, `main.py`. Split your code into functions, not into modules." },
    ],
  },

  // ================================================================ Arenas and rules
  {
    id: "arena-dohyo",
    group: "Arenas and rules",
    title: "Dohyo (mini sumo)",
    summary: "The 77 cm sumo ring: dimensions, colours and sensor readings, start positions, false start, out and the time limit.",
    blocks: [
      {
        p: "The arena **Dohyo 77 cm (mini sumo)** follows the mini class of the Unified Sumo Robot Rules. Two robots (up to four for practice) try to push each other out of the ring.",
      },
      { h: "The ring", id: "ring" },
      {
        table: {
          head: ["", ""],
          rows: [
            ["diameter", "77 cm"],
            ["height", "2.5 cm above the floor"],
            ["surface", "black (line sensors: 1024)"],
            ["border", "2.5 cm wide white ring at the edge (line sensors: ≈ 110); it belongs to the playing surface"],
            ["start lines (shikiri)", "two brown lines in the middle, 1 cm × 10 cm, outer edges 10 cm apart; they read 1024, like black"],
          ],
        },
      },
      { h: "Start positions", id: "starts" },
      {
        table: {
          head: ["Robot", "Position", "Facing"],
          rows: [
            ["1", "11.5 cm from the centre, behind one start line", "the centre and robot 2"],
            ["2", "11.5 cm from the centre, behind the other start line", "the centre and robot 1"],
            ["3", "20 cm from the centre, at a right angle to robots 1 and 2", "the centre"],
            ["4", "opposite robot 3, 20 cm from the centre", "the centre"],
          ],
        },
      },
      {
        p: "Robots 1 and 2 stand face to face with about 11 cm between their blades. Robots 3 and 4 are for practice with more robots. The test bench moves the starts randomly by a few centimetres and degrees ([spread starts](doc:test-bench#ab)).",
      },
      { h: "The match", id: "match" },
      {
        list: [
          "▶ Run starts the programs; the match starts with the start signal: **⚑ Start** (key S) presses button A on every robot, like the referee's signal (with **Auto start** on, 0.2 s after Run). The match clock and the time limit start 5 s after the signal. ⚑ Start alone runs the programs and gives the signal.",
          "**First robot out loses.** The last robot left in the ring wins; if the last robots leave at the same moment, it is a draw.",
          "**Time limit 3 minutes.** If nobody is out by then: draw (no decision).",
          "The scoreboard shows the clock, the winner and robots that are OUT or made a FALSE START.",
        ],
      },
      { h: "False start", id: "false-start" },
      {
        p: "Robots may start operating **5 seconds** after the start signal (rules art. 8). In the simulator the 5 s count from the start signal (⚑ Start / Auto start); a robot whose motors get any speed other than 0 before the signal or within those 5 s is marked **FALSE START** on the scoreboard and in the console. The simulator only flags it and the match goes on — at a real tournament the referee decides, so never do it.",
      },
      { h: "Out", id: "out" },
      {
        p: "A robot loses when its body touches the space outside the ring (rules art. 14). The simulator judges this by the robot's reference point between its axles: the robot is out when that point has dropped more than 6 mm below the ring's surface, or is more than 2 cm beyond the ring's edge. In practice: as soon as a robot tips over the edge.",
      },
      { h: "Inverse dohyo", id: "inverse" },
      {
        p: "**Dohyo inverse (white, black edge)** is the same ring in the colours of the club's test table: a white surface with a 2.5 cm black edge band. Edge detection is reversed: a raw value **above 600** means edge. The brown start lines read black, and so does a sensor that is lifted off the surface.",
      },
      {
        note: "A program written for the official dohyo (white = edge) drives straight out of the inverse dohyo, and the other way round. Make the colour logic a constant at the top of your program.",
        kind: "tip",
      },
    ],
  },
  {
    id: "arena-line",
    group: "Arenas and rules",
    title: "Line track (race)",
    summary: "The line-following track: tape and dimensions, start positions, laps with checkpoints, and the time limit.",
    blocks: [
      {
        p: "**Line track (race)** is a practice track for the line-following race (Spormula E): a white board with a black tape loop. Robots follow the tape counter-clockwise (seen from above); the first to finish three laps wins.",
      },
      { note: "The track and rules at the event may differ from this practice track." },
      { h: "The track", id: "track" },
      {
        table: {
          head: ["", ""],
          rows: [
            ["board", "160 × 110 cm, white (≈ 110), 4 mm high"],
            ["tape", "19 mm wide, black (1024)"],
            ["loop", "two 90 cm straights joined by half circles of 30 cm radius (to the tape's centre line), about 3.8 m per lap"],
            ["S-bend", "in the top straight: 40 cm long, 8 cm to each side. It starts and ends with a kink of about 50° and has curves down to about 5 cm radius."],
            ["start/finish", "in the middle of the bottom straight, shown light blue in the 3D view (the line sensors do not see it)"],
          ],
        },
      },
      { h: "Start positions", id: "starts" },
      {
        p: "All robots start on the bottom straight, facing the race direction (to the right in the top view): robot 1 6 cm before the start/finish line, robot 2 26 cm before it, robot 3 46 cm before it at the start of the curve (slightly off the tape and turned), robot 4 20 cm after the line.",
      },
      { h: "Laps", id: "laps" },
      {
        list: [
          "**Flying start:** your clock starts when your robot first crosses the start/finish line in the race direction (console: *crossed the start line*).",
          "Every later crossing counts a lap **only if** the robot has driven through all three checkpoint areas since its last crossing: the right curve, the S-bend and the left curve. Shortcuts and circling near the line count nothing (console: *crossed the line without driving the whole loop — no lap*).",
          "The console shows every lap time; the scoreboard shows LAP n/3 and the best lap.",
          "Every robot drives **3 timed laps**, each timed from its own first crossing — so the start position does not matter. The race ends when every robot still on the track has finished; the **shortest total time** of the 3 laps wins.",
          "**Time limit 2 minutes** (from ▶ Run): then most laps wins, equal laps → shorter total time; still equal = draw.",
          "A robot that leaves the board (its reference point is past the edge) is out and stops counting. If all robots are out, the leader by laps and time wins.",
        ],
      },
      { note: "Start with the [line follower tutorial](doc:tutorial-line). The test bench with *B = none* reports the average laps and the best lap time.", kind: "tip" },
    ],
  },
  {
    id: "arena-free",
    group: "Arenas and rules",
    title: "Free practice",
    summary: "A big table without rules or time limit, for first programs, measurements and experiments.",
    blocks: [
      {
        table: {
          head: ["", ""],
          rows: [
            ["table", "150 × 100 cm, white (≈ 110), 2 cm high"],
            ["edge", "3 cm black band along all edges (1024)"],
            ["rules", "none: no time limit, no scores; robots that fall off are reported as out"],
          ],
        },
      },
      {
        p: "Starts: robot 1 30 cm left of the centre facing right, robot 2 30 cm right of it facing left, robots 3 and 4 25 cm below and above the centre, facing it.",
      },
      {
        p: "Good for first programs, measuring speeds and turns, calibrating, and testing sensors with robots you place by hand (Shift + drag, also while a program runs). The test bench stops a match here after 60 s.",
      },
    ],
  },
  {
    id: "judging",
    group: "Arenas and rules",
    title: "How matches are judged",
    summary: "The referee in the simulator: when a match ends, what the scoreboard and the console show, and why every match can be replayed.",
    blocks: [
      {
        p: "The same rules code judges every match: in the 3D view, on the test bench and in replays. It checks the robots' positions every 5 ms of robot time, and at once when a robot leaves the arena, so decisions are exact and reproducible.",
      },
      {
        table: {
          head: ["Arena", "Ends when", "Winner", "Time limit"],
          rows: [
            ["Dohyo", "only one robot is left in the ring", "the last one in; all out at once = draw", "3 min from go, then draw"],
            ["Line track", "every robot on the track has driven 3 timed laps", "the shortest total time of the 3 laps", "2 min, then most laps, then time"],
            ["Free practice", "never", "—", "none"],
          ],
        },
      },
      { h: "What you see", id: "see" },
      {
        list: [
          "The **console** lists every event with its time: *… is out (12.34 s)*, laps with their times, points, warnings (false start, a lap without the whole loop) and *Match over: …*.",
          "The **scoreboard** in the 3D view shows the mode, the clock and the time limit, each robot's score and status (OUT, FALSE START, LAP 2/3 · BEST …) and the result.",
          "**Sounds** mark a robot out, a lap or point, and the end of the match.",
          "When a match is decided, the simulator stops the programs about 1.5 s later, like a referee. Press ▶ Run for the next match.",
          "Before ▶ Run (programs not running), the clock does not run and nothing is judged.",
          "A program that ends or crashes leaves its robot on the field, with its motors at their last speed.",
        ],
      },
      { h: "Seeds and replays", id: "seed" },
      {
        p: "Every run has a **seed**, shown in the console when you press ▶ Run. It decides the small random differences: motor strength, sensor noise, blade edges and your program's `random` numbers. The same seed, programs, start positions and World settings give exactly the same match, on any computer — as long as nobody presses buttons or moves robots by hand. That is how the test bench can replay any of its matches.",
      },
    ],
  },

  // ================================================================ Testing your robot
  {
    id: "test-bench",
    group: "Testing your robot",
    title: "The test bench",
    summary: "Run many matches in parallel, read the win rate and its 95 % interval, watch single matches again, and run round robins.",
    blocks: [
      {
        p: "One match tells you little: start positions, sensor noise and blade differences change from match to match. The **Test bench** (in the bottom panel) runs many matches without graphics, several at a time, and tells you how often A beats B.",
      },
      { h: "A vs B", id: "ab" },
      {
        ordered: true,
        list: [
          "**A**: one of your robots (its current code) or any house bot. **B**: another one, or *none (solo run)* for races and timing runs.",
          "**Matches**: 2 to 500 (default 20).",
          "**Spread starts** (on by default): every match starts from slightly different, random but reproducible positions — up to 4 cm further back, up to 3 cm to the side and turned up to ±17°. On the line track the spread is a quarter of that.",
          "Press **▶ Run bench**. Results appear as matches finish; **■ Cancel** stops.",
        ],
      },
      {
        list: [
          "**Sides alternate**: in every second match A and B swap their start positions, so neither profits from a better side.",
          "The bench uses the current arena and the current **World** settings (battery, grip, noise). Button A is always pressed automatically.",
          "Matches without a decision end at the arena's time limit (60 s on Free practice).",
          "It runs as fast as your computer allows; that does not change the results, because robot time is simulated exactly.",
        ],
      },
      { h: "Reading the result", id: "result" },
      {
        p: "The headline is A's **win rate**: wins plus half the draws, divided by the number of matches. Below it: the **95 % interval**, the wins of A and B, the draws and the average match length. With B = none it shows A's average score (laps, seconds or points) and, on the line track, the best lap.",
      },
      {
        p: "The interval (a Wilson score interval) is the range in which A's true win rate lies with 95 % certainty, given the matches played. With few matches it is wide:",
      },
      {
        table: {
          head: ["Matches", "measured 50 %", "measured 70 %", "measured 90 %"],
          rows: [
            ["10", "24 – 76 %", "40 – 89 %", "60 – 98 %"],
            ["20", "30 – 70 %", "48 – 85 %", "70 – 97 %"],
            ["50", "37 – 63 %", "56 – 81 %", "79 – 96 %"],
            ["100", "40 – 60 %", "60 – 78 %", "83 – 94 %"],
            ["200", "43 – 57 %", "63 – 76 %", "85 – 93 %"],
          ],
        },
      },
      {
        p: "From 6 matches on, the bench gives a verdict: if the whole interval is above 50 % it says *A is significantly stronger*, if it is below 50 % *B is significantly stronger*, otherwise *No significant difference yet — run more matches*.",
      },
      { h: "How many matches?", id: "how-many" },
      {
        list: [
          "A clear difference (80 : 20) shows after about 15 matches.",
          "70 : 30 needs about 30 matches.",
          "60 : 40 needs about 100 matches.",
          "Two versions of your robot that stay undecided after hundreds of matches are practically equal — the change does not matter much.",
        ],
      },
      { p: "Compare versions fairly: same opponent, same arena, same World settings, enough matches." },
      { h: "Watch a match", id: "watch" },
      {
        p: "Every row of the table (number, seed, sides, winner, time, score, reason) has **watch**. It loads exactly that match — same seed, start positions, programs and World settings — into the 3D view and runs it. Every match is deterministic, so you see exactly what happened on the bench, with timeline, telemetry and console. **↺ Reset** returns to your own robots.",
      },
      { note: "Watch the matches your robot lost. They show you what to fix far faster than the matches it won.", kind: "tip" },
      { h: "Round robin", id: "round-robin" },
      {
        p: "**Round robin** plays every program against every other on the current arena. Choose a category of house bots, switch on **+ my robots** to include your robot tabs, and set **Per pair** (2–40 matches, default 4; spread starts, sides alternate). The result is a matrix: each cell is the win rate of the row's program against the column's (draw = ½); the rows are sorted by the overall rate.",
      },
      { note: "Per pair 4 gives a quick overview. For decisions use 10 or more per pair, or a focused A vs B bench." },
      { h: "Robustness runs", id: "robust" },
      {
        p: "Set **World** to a 25 % battery or a dusty floor and run the same bench again. A robot that only wins with fresh batteries will disappoint at the event: [robustness checklist](doc:robustness).",
      },
    ],
  },
  {
    id: "debugging",
    group: "Testing your robot",
    title: "Debugging tools",
    summary: "Console, print plotter, telemetry, timeline, sensor view and inspector — and how to find out what your robot did and why.",
    blocks: [
      { h: "Console", id: "console" },
      {
        list: [
          "Every line your program prints, with the robot time in seconds and the robot's name in its colour (timestamps can be switched off in ⚙ Settings).",
          "Referee messages (out, laps, points, match over) and warnings (false start, a lap without the whole loop).",
          "Errors: a traceback ends with the error type and message. Click a line like `File \"main.py\", line 12` to jump to that line in the editor; the editor marks it too.",
          "The menu filters the lines: all, *Errors & warnings*, or one robot. **Search** keeps only lines containing a text, **copy** copies the visible lines, **clear** empties the console. The newest 3000 lines are kept.",
          "When you have scrolled up to read, new lines do not move the view; **↓ new lines** jumps back to the end.",
        ],
      },
      { h: "The print plotter", id: "plotter" },
      {
        p: "**Telemetry** draws the numbers your program prints as a chart, *Your print() values*, above the built-in charts — like Thonny's plotter. The rules:",
      },
      {
        list: [
          "Every number in a printed line becomes a value; the text before it (up to two words) is its label: `print('error:', e, 'speed:', s)` → *error* and *speed*.",
          "`=`, `:`, `,`, `;` and brackets are dropped from labels: `print('t=%d e=%d' % (t, e))` → *t* and *e*.",
          "Numbers without text before them are numbered by position: `print(a, b)` → *#1* and *#2*; `print(list(line.read()))` → *#1* … *#5*.",
          "Digits inside a word belong to the label: `print('DN1', v[0])` → label *DN1*.",
          "Integers, decimals and exponents (`-3.5`, `1e-3`) are understood. A thousands separator (`1,000`) splits a number in two.",
          "Lines with more than 8 numbers, lines without numbers and error messages are not plotted. The chart shows the first 5 labels, scaled automatically, over the last 10 seconds.",
        ],
      },
      {
        title: "plot_demo.py",
        insert: true,
        code: `from zumo_2040_robot import robot
import time

line = robot.LineSensors()
encoders = robot.Encoders()
motors = robot.Motors()

motors.set_speeds(2000, 3000)
for i in range(40):
    v = line.read()
    left, right = encoders.get_counts()
    print("middle:", v[2], "left:", left, "right:", right)
    time.sleep_ms(50)
motors.off()
`,
      },
      { note: "Print every 20–100 ms rather than in every loop: that is plenty for a chart, and thousands of lines per second only flood the console.", kind: "tip" },
      { h: "Telemetry", id: "telemetry" },
      {
        p: "Strip charts of the selected robot over the last 10 seconds: **Motors** (L, R), **Line sensors (raw)** DN1–DN5, **Proximity** (left, front, right; the higher of the two LED counts), **Speed** (m/s), **Heading** (yaw and tilt in degrees) and **Battery** (mV). The sensor charts show the values your program last read: if it never reads a sensor, that chart stays flat.",
      },
      { h: "Timeline", id: "timeline" },
      {
        p: "Everything is recorded: positions, displays, LEDs, sensor readings and prints, up to 15 minutes. Drag the timeline slider to any moment: the 3D view, inspector, display and telemetry show that moment. **▶** replays from there at the chosen speed, ← and → step frame by frame, **Live** (or L) returns to the running simulation.",
      },
      { h: "Sensor view", id: "sensor-view" },
      {
        p: "**Sensors** (key V) draws what the sensors see in the 3D view: a fan in front of each proximity receiver that currently counts something (longer and brighter = higher count), and dots under the line sensors.",
      },
      { h: "Inspector", id: "inspector" },
      {
        p: "The inspector shows the selected robot (click it in the 3D view, click its tab, or press 1–4): its display, the buttons A/B/C (click, or hold the keys A/B/C), the six LEDs, the line sensors as bars with raw values (a full bar = bright surface), the proximity counts per receiver (left-LED · right-LED count), the motor commands, and the motion: speed, heading, tilt, encoders, battery and status. **IMU** shows the last values your program read (*not read* until it reads the IMU).",
      },
      { h: "A debugging routine", id: "routine" },
      {
        ordered: true,
        list: [
          "Something odd happens: pause (❚❚) or let the match end.",
          "Scrub the timeline to the moment, select the robot and look at the inspector: what did it read just before?",
          "Print the values and the decision your code made, and run again against the same opponent.",
          "If it only happens sometimes, run the bench and **watch** the matches that went wrong.",
        ],
      },
    ],
  },
  {
    id: "robustness",
    group: "Testing your robot",
    title: "Robustness checklist",
    summary: "Make sure your robot still works with weak batteries, a dusty floor, noisy sensors and other start positions.",
    blocks: [
      {
        p: "The real robot will not meet the conditions of your last simulator run. **World** (above the 3D view) changes the world for the next run and for the test bench:",
      },
      {
        table: {
          head: ["Setting", "Choices", "What changes"],
          rows: [
            ["Battery", "full · 60 % · 25 % · empty", "voltage 5.2 → 4.6 V: up to 13 % less speed and less pushing force"],
            ["Floor grip", "dusty · normal · sticky", "grip of the tracks × 0.7 / 1 / 1.25: traction when pushing, accelerating and turning"],
            ["Sensor noise", "none · normal · high", "noise of the line, proximity and IMU readings × 0 / 1 / 2.5, including the gyro bias"],
          ],
        },
      },
      { p: "The button shows what is active (for example *World: bat 25 % · dusty*). The settings are stored in this browser." },
      { h: "Checklist", id: "checklist" },
      {
        ordered: true,
        list: [
          "**Fresh and weak battery.** Run your bench at *full* and at *25 %*. Timed moves (back up 150 ms, turn 400 ms) cover less distance and angle: does your robot still escape the border?",
          "**Dusty floor.** Does your robot still win pushing duels, and still stop in time at the edge?",
          "**High noise.** Do flickering proximity counts make your robot switch between attack and search? Does a single noisy line reading trigger an escape? Use hysteresis, or require two readings in a row.",
          "**No noise.** With *none* the gyro has no bias: useful to check your logic, but never tune with it.",
          "**Other starts.** Keep *Spread starts* on in the bench. Move robots by hand (Shift + drag) to awkward places before ▶ Run: next to the border, facing away from the opponent. The next runs start there until ↺ Reset.",
          "**Other opponents.** Test against a mix — at least one attacker, one evader and one trickster (house bots, if your deployment provides them).",
          "**Long matches.** Let a match run to the time limit: no `MemoryError`, no stuck state?",
          "**Errors.** Is the main loop inside `try/finally` with `motors.off()`?",
        ],
      },
      { note: "A robot that wins 70 % in every setting is worth more than one that wins 90 % with fresh batteries only.", kind: "tip" },
    ],
  },

  // ================================================================ The simulator
  {
    id: "fidelity",
    group: "The simulator",
    title: "What is simulated",
    summary: "What the simulator models, how accurately, and what it does not model (yet).",
    blocks: [
      {
        p: "The simulator aims for *the same code* and *the same behaviour*: what works here should work on the robot, and the other way round. Numbers come from Pololu's datasheets and CAD model where possible; the rest are estimates that will be calibrated with real robots.",
      },
      {
        table: {
          head: ["Part", "Modelled", "Good to know"],
          rows: [
            ["Program", "real MicroPython 1.29 with Pololu's `zumo_2040_robot` library: same API, same quirks", "only `main.py`; see [Other modules](doc:ref-other-modules)"],
            ["Timing", "every bytecode ≈ 1.7 µs, sensor reads with their real duration, display 4 ms, timers like interrupts", "[Timing](doc:timing)"],
            ["Memory", "fixed heap (≈ 160 KB free at the start), real garbage collector, `MemoryError`", "[Memory](doc:memory)"],
            ["Motors", "DRV8838 driver, back-EMF, gearbox friction, rotor inertia; motors differ by a few % between robots", "top speed ≈ 0.65 m/s"],
            ["Battery", "4 × NiMH with internal resistance and state of charge; sags under load", "World → Battery"],
            ["Tracks", "3D physics: grip, slip, skid and tipping", "World → Floor grip"],
            ["Blade", "inclined steel blade with a rounded lower edge; its height (≈ 0.4 ± 0.1 mm) and tilt across the width (± 0.3 mm) differ per robot, new for every run", "head-on, the blade that is lower where they meet gets under the other"],
            ["Line sensors", "a light spot of ≈ 5 mm on the printed surface, reflectance, distance to the surface (lifted = black), per-sensor spread, noise", "white ≈ 110, grey ≈ 300, black 1024; a read takes 1.06 ms"],
            ["Proximity", "a fan of rays from each receiver, both LED groups' beams, material reflectance (blade bright, tracks dark), 6 levels, flicker", "a Zumo is seen up to ≈ 34 cm"],
            ["IMU", "acceleration and turn rate from the 3D motion with noise and a per-robot gyro bias; magnetometer from a constant earth field", "output data rates and `data_ready()`"],
            ["Encoders", "from the sprocket rotation, 909.7 counts per revolution", "they also count when the tracks slip"],
            ["Display, LEDs, buzzer", "shown in the 3D view and the inspector; the buzzer plays through your speakers", ""],
          ],
        },
      },
      { h: "Not modelled (yet)", id: "missing" },
      {
        list: [
          "**Extra parts** on I2C (distance sensors, other IMUs, servos): `machine.I2C` answers `ENODEV`.",
          "**IR between robots**: other robots' proximity flashes do not disturb your sensors, and there is no ambient light.",
          "**IMU filtering**: reading faster than the output data rate gives fresh values in the simulator but the same sample again on the robot.",
          "**Speed-up decorators**: `@micropython.native` and `@viper` run as normal bytecode, slower than on the robot.",
          "**asyncio**, `_thread`, and files besides `main.py`.",
          "**Single-precision floats**: the simulator computes with double precision.",
          "**Garbage collection pauses** cost no robot time in the simulator.",
          "**Calibration**: most physical values are estimates until they have been measured on real Zumos. Exact numbers (top speed, proximity range, sensor values) may still change somewhat.",
        ],
      },
      { h: "Exact and reproducible", id: "determinism" },
      {
        p: "Small random differences (motor strength, sensor noise, blade edges, your program's `random`) come from the run's seed, so the same seed, programs and starts give the same match on any computer. If your computer cannot keep up (four robots on a slow laptop), the simulation runs slower than real time — the top bar shows the factor — but the robot time stays exact and the results do not change.",
      },
    ],
  },
  {
    id: "sim-vs-reality",
    group: "The simulator",
    title: "Sim vs. reality",
    summary: "How to transfer a program to the real Zumo: what carries over, what needs re-tuning, and how to prepare for the few hours with the robot.",
    blocks: [
      { p: "Your program will run on the robot unchanged. Whether it *works* depends on how much it relies on exact numbers." },
      { h: "Carries over well", id: "good" },
      {
        list: [
          "Program logic, state machines, the start rule, button handling.",
          "Relative sensor use: *left count > right count*, *any sensor brighter than the threshold*, gyro-measured turns, encoder distances.",
          "Timing structure: loop rates and sensor durations are modelled, so a loop that is fast enough here is fast enough there.",
          "Memory: a program that runs for minutes here without `MemoryError` is a good sign.",
        ],
      },
      { h: "Needs re-tuning", id: "retune" },
      {
        list: [
          "**Thresholds**: line values on the real surface, proximity counts at real distances (use the [sensor check](doc:to-the-robot#check)).",
          "**Anything timed**: `sleep_ms` turns and back-up times.",
          "**Controller gains** (KP, KD) and base speeds: real motors, tracks and tape differ.",
          "**Calibration**: always calibrate on the real track, in the real light.",
          "**Pushing**: the blade edge and the grip of your robot decide head-on fights; reality can differ from the simulator's estimates.",
        ],
      },
      { h: "Prepare for the robot", id: "prepare" },
      {
        ordered: true,
        list: [
          "Put every tunable number into a constant at the top of `main.py`.",
          "Prefer measured quantities (gyro angle, encoder distance, calibrated values) over times.",
          "Test with all World settings ([checklist](doc:robustness)): a program that only works in one setting is fragile.",
          "Prepare a sensor check and a short motor test you can run in the first minutes with the real robot.",
          "Bring a laptop with Thonny or mpremote and all your programs downloaded: with only a few hours of robot time, every minute counts.",
          "Let the display and the LEDs show what your robot is doing, so you can see it on the real robot too.",
        ],
      },
      {
        note: "One technical difference: the robot computes floats with single precision (about 7 significant digits), the simulator with double precision. Integer arithmetic is identical.",
      },
    ],
  },
  {
    id: "workspace",
    group: "The simulator",
    title: "Workspace and layout",
    summary: "Arrange the panels with dividers, presets and the Layout menu; robots and controls; theme, sizes, editor font and sound in Settings.",
    blocks: [
      { h: "Panels", id: "panels" },
      { p: "The workspace has four panels: **code**, **3D view**, the **bottom panel** (console · telemetry · test bench · docs) and the **inspector**." },
      {
        list: [
          "Drag the divider lines between panels to resize them. Double-click a divider to reset it. A focused divider moves with the arrow keys (Shift = bigger steps).",
          "Every panel header has **⤢** (maximize; **Esc** or ⤡ returns) and **–** (hide). The 3D view can only be maximized (key F).",
          "A hidden panel leaves a slim tab at the window edge (*Code ›*, *‹ Inspector*, *▴ Console · Telemetry · …*): click it to bring the panel back. Keys: **D** bottom panel, **I** inspector, **F** 3D view full size.",
          "On smaller screens the top bar wraps into two rows and the panels get narrower; hide what you do not need (– in a panel header, or the keys D and I). Very narrow windows stack the panels. A maximized panel is not stored: a reload starts with your layout.",
        ],
      },
      { h: "Layout menu", id: "layout" },
      { p: "**▦ Layout** in the top bar:" },
      {
        list: [
          "Presets: **Default** (code · 3D view with the console below · inspector), **Code** (wide editor with the console under it, 3D view beside it), **Watch** (big 3D view and inspector, code hidden), **Analyse** (console, telemetry and test bench across the full width).",
          "Where the bottom panel sits: under the 3D view, under the code, or across the full width.",
          "The code column on the left or on the right.",
          "Show or hide code, inspector and bottom panel; reset the layout.",
        ],
      },
      { p: "The layout is stored in this browser." },
      { h: "Robots", id: "robots" },
      {
        list: [
          "Up to four robots (as many as the arena has start positions). **+ Robot** adds one, **✕** removes the selected one; edit its name above the Program list.",
          "**Program**: *✎ My code*, an example or a house bot. Your own code for a tab is kept while a house bot is selected for it.",
          "The tabs show a mark while a program runs (blinking green), after it finished (grey) and when it stopped with an error (red — the console says why).",
          "Changing the arena replaces house bots made for another arena with a fitting opponent (Free practice keeps them).",
        ],
      },
      { h: "Controls", id: "controls" },
      {
        list: [
          "Speed: ❚❚ pause, ¼×, ½×, 1×, 4× and **Max** (as fast as possible). Robot time stays exact at every speed; the buzzers are silent at Max and while paused.",
          "Above the 3D view: view style **Pixel** (dithered, colours kept), **Spark** (the SPARK blue) or **Clear**; **World** settings; **Auto start** (gives the start signal 0.2 s after ▶ Run; off by default; stored in this browser); **Sensors** (key V); **Sound**; cameras ◩ angled, ◻ top and ◎ follow the selected robot.",
          "In the 3D view: drag to orbit, right-drag to pan, scroll to zoom, click a robot to select it. Shift + drag moves a robot (scroll while dragging turns it) — also during a run, for example to put the opponent right in front of your robot. Positions set before ▶ Run are kept for the following runs; ↺ Reset (R) puts the robots back on their start marks.",
        ],
      },
      { h: "Settings", id: "settings" },
      {
        table: {
          head: ["⚙ Setting", "Choices"],
          rows: [
            ["Theme", "System, Light, Dark"],
            ["Text size", "S, M, L — buttons, labels, inspector and panels"],
            ["Editor font", "Code (easy to read for long sessions) or Pixel (the SPARK look)"],
            ["Editor & console size", "10 – 26 px (also Ctrl/⌘ + = and − in the editor); the console uses one step smaller"],
            ["Line wrapping", "Off, On"],
            ["Console timestamps", "robot time before every line: Off, On"],
            ["Volume", "buzzers and referee sounds; the **Sound** button mutes"],
          ],
        },
      },
      { p: "**Reset settings** restores the defaults; **Take the guided tour** starts the tour again. Settings are stored in this browser." },
    ],
  },
  {
    id: "editor-console",
    group: "The simulator",
    title: "Editor, saving and shortcuts",
    summary: "Autocompletion, hover help, error markers, how your code is saved and shared, and all keyboard shortcuts.",
    blocks: [
      { h: "Editor", id: "editor" },
      {
        list: [
          "**Autocompletion**: after `motors = robot.Motors()`, typing `motors.` lists all its methods with a short description. It also works after `robot.`, `time.` and `imu.gyro.` (or `acc`, `mag`). Ctrl/⌘ + Space opens the list again.",
          "**Hover help**: rest the mouse on an API call to see its signature, what it returns and how long it takes; *Open in the docs →* jumps to the reference.",
          "**Errors**: when your program stops with an error, the line is marked in the editor; hover the mark to read the message.",
          "Ctrl/⌘ + F search and replace, Ctrl/⌘ + / comment lines, Ctrl/⌘ + = and − font size, Tab and Shift + Tab indent.",
          "House bots and examples are read-only; **Edit a copy →** copies one into your own code.",
        ],
      },
      { p: "Autocompletion and hover help recognise variables you create as `name = robot.Class()` on a line of their own." },
      { h: "Saving and sharing", id: "saving" },
      {
        list: [
          "Your code is saved in this browser automatically, per robot tab. It is not stored on a server: another browser or computer does not have it, and clearing the browser's site data deletes it.",
          "**⇩ main.py** downloads the program. Do it regularly: it is your backup and what goes onto the robot.",
          "**⇧ Open** loads a `.py` file into the selected robot (it replaces that robot's code).",
          "**⇪ Link** copies a link that contains the whole program (compressed into the link, no server involved). Opening the link puts the program into the first robot that runs *✎ My code* (it asks before replacing code).",
        ],
      },
      { h: "Console", id: "console" },
      { p: "Filters, search, copy and jumping to error lines: [Debugging tools](doc:debugging#console)." },
      { h: "Keyboard shortcuts", id: "shortcuts" },
      { shortcuts: true },
    ],
  },

  // ================================================================ Help
  {
    id: "faq",
    group: "Help",
    title: "FAQ and troubleshooting",
    summary: "The most common problems: the robot does not move, the program ends, MemoryError, the watchdog message, no sound, lost code and more.",
    blocks: [
      { h: "My robot does not move", id: "no-move" },
      {
        p: "Most programs wait for button A: give the start signal with **⚑ Start** (key S), which presses A on every robot — or press A on one robot in the inspector / with the key A. In sumo, robots then wait 5 more seconds. Also look at the console for an error.",
      },
      { h: "It waits for A forever after the start signal", id: "missed-a" },
      {
        p: "The start signal presses A once, for 0.1 s. If your program does something long first (a calibration sweep, a long `sleep`), the press is over before it starts waiting. Wait for A first, then calibrate — or press A again yourself.",
      },
      { h: "The program ends immediately", id: "ends" },
      {
        p: "The console says *program finished*: your code has no endless loop (`while True:`). Or it says *program stopped:* with an error — read the traceback above it and click the `main.py` line to jump there.",
      },
      { h: "The robot keeps driving after the program ended", id: "drives-on" },
      { p: "Motors keep their last speed. Wrap your main loop in `try/finally` ([program structure](doc:program-structure#finally)); **■ Stop** switches the motors off." },
      { h: "MemoryError", id: "memory" },
      {
        p: "Your program has used up the heap. Look for lists or strings that grow in the main loop, and objects created in every loop. [Memory and performance](doc:memory) shows how to find and avoid it.",
      },
      { h: "“stopped responding … program detached”", id: "hang" },
      {
        p: "One single statement of your program ran for 5 s of real time without returning — for example a huge computation inside one call like `sum(range(10**9))`. The simulator detaches that program so that the other robots can go on. Normal loops, even `while True: pass`, never trigger this.",
      },
      { h: "No sound", id: "sound" },
      {
        p: "Browsers allow sound only after you have clicked or pressed a key in the page: click once anywhere. Check the **Sound** button above the 3D view, the volume in **⚙ Settings** and your computer's volume. At speed **Max** and while paused the buzzers are silent.",
      },
      { h: "The simulation runs slower than real time", id: "slow" },
      {
        p: "With four robots, or on a slow computer, the simulator may not keep up; the top bar shows the factor (for example *0.6× real time*). Robot time stays exact, so the results do not change — only watching takes longer. Close other tabs or use fewer robots.",
      },
      { h: "My code is gone", id: "lost-code" },
      {
        p: "Code is stored per browser and per robot tab. Another browser, a private window or cleared site data start empty. If you chose a house bot for a tab, switch its Program back to *✎ My code*: your code is still there. Download **⇩ main.py** regularly as a backup.",
      },
      { h: "The editor does not let me type", id: "readonly" },
      { p: "The tab runs a house bot or an example, which are read-only. Choose *✎ My code*, or use **Edit a copy →** to start from that program." },
      { h: "FALSE START appears on the scoreboard", id: "false-start" },
      {
        p: "A motor got a speed other than 0 within 5 s of the start. Wait for button A, then 5 s; do not calibrate by spinning before that. See [the rule](doc:arena-dohyo#false-start).",
      },
      { h: "The line follower loses the line in curves", id: "line-lost" },
      {
        p: "Check the calibration first (all `cal_max` near 1024). Then lower `BASE` or raise `KD`; make sure nothing slow (display updates, long prints) sits in the loop. See the [line follower tutorial](doc:tutorial-line#tune).",
      },
      { h: "It works in the simulator but not on the robot", id: "real" },
      {
        p: "Calibration, battery, thresholds and timings. Run the [sensor check](doc:to-the-robot#check) on the robot and read [Sim vs. reality](doc:sim-vs-reality).",
      },
    ],
  },
  {
    id: "glossary",
    group: "Help",
    title: "Glossary",
    summary: "Short explanations of the terms used in these docs, from ADC to Wilson interval.",
    blocks: [
      {
        table: {
          head: ["Term", "Meaning"],
          rows: [
            ["ADC", "analog-to-digital converter: turns a voltage into a number. The battery voltage is measured with one."],
            ["Auto start", "simulator option that gives the start signal (button A on every robot) 0.2 s after ▶ Run"],
            ["Bias", "the small value a sensor reports when it should report 0, e.g. a gyro reading a few tenths of °/s while standing still"],
            ["Blade", "the inclined steel plate at the front of the Zumo; the lower blade gets under the other one in a head-on hit"],
            ["Calibration", "measuring each sensor's range (min and max) on the real surface, so readings can be scaled to 0 … 1000"],
            ["Challenge 1", "the first discipline of the Triathlon; its format is not decided yet (King of the Hill and the A↔B shuttle are practice candidates)"],
            ["Checkpoint", "an area of the line track a robot must pass for a lap to count"],
            ["Confidence interval (95 %)", "the range in which the true value (e.g. a win rate) lies with 95 % certainty, given the measurements"],
            ["Debounce", "ignoring the fast on/off flicker of a mechanical button for a few ms after it changes"],
            ["Dohyo", "the sumo ring: 77 cm, black with a white border in mini sumo"],
            ["Encoder", "sensor that counts how far a motor shaft has turned (909.7 counts per sprocket revolution)"],
            ["False start", "moving before 5 s have passed since the start of a sumo match"],
            ["Flying start", "the race clock starts when a robot first crosses the start line, not when the program starts"],
            ["Heap", "the memory for Python objects (≈ 160 KB free at program start)"],
            ["House bot", "a built-in opponent program"],
            ["Hysteresis", "different thresholds for switching on and off (attack at 4 counts, stop below 2), so noise does not cause flicker"],
            ["IMU", "inertial measurement unit: accelerometer, gyro and magnetometer"],
            ["ODR", "output data rate: how often an IMU sensor measures (e.g. gyro 208 Hz)"],
            ["P / PD / PID controller", "steering in proportion to the error (P), plus its change (D), plus its sum over time (I)"],
            ["Proximity count", "0 … 6: at how many of the six LED brightness levels a receiver saw a reflection"],
            ["PWM", "pulse-width modulation: switching the motor voltage on and off fast; the speed value sets the on-share (duty cycle)"],
            ["Raw value", "a line sensor reading before calibration, 0 … 1024 (small = bright)"],
            ["Round robin", "a tournament in which every program plays every other"],
            ["Seed", "the number that fixes all random differences of a run; the same seed gives the same match"],
            ["Shikiri", "the two brown start lines in the middle of the dohyo"],
            ["Spormula E", "the line-following race of the Triathlon"],
            ["Spread starts", "test bench option: random but reproducible small changes of the start positions"],
            ["State machine", "a program structure that stores what the robot is doing in a variable and switches between states"],
            ["Telemetry", "charts of what the robot commanded and measured over time"],
            ["Ticks", "the counters of `time.ticks_ms()` / `ticks_us()`; they wrap around, so use `ticks_diff()`"],
            ["Triathlon", "the SPARK robot event: Challenge 1, the Spormula E line race and mini sumo"],
            ["Wilson interval", "the formula the test bench uses for the 95 % interval of a win rate"],
          ],
        },
      },
    ],
  },
];


/** The private competition overlay adds its doc pages (challenge arenas, house bots) via this. */
export function addDocPages(pages: DocPage[]): void {
  for (const p of pages) DOC_PAGES.push(p);
}
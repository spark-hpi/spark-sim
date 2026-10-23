# Line follower for a first test on a real track: the simulator's example (src/examples/line_follower.py)
# with a start on button A, a stop on B (then A starts the next run, calibrating again), the top speed on C, and
# braking to CURVE speed when the line wanders off the centre.
# Put the robot on the line, aligned with it.
from zumo_2040_robot import robot
from array import array
import time

motors = robot.Motors()
line = robot.LineSensors()
display = robot.Display()
buzzer = robot.Buzzer()
button_a = robot.ButtonA()
button_b = robot.ButtonB()
button_c = robot.ButtonC()

SPEEDS = (1200, 1800, 2400, 3200, 4000)  # top speed on straights; C on the start screen picks one
speed = 1  # index into SPEEDS (start with 1800)
CURVE = 1200  # speed in sharp curves: the track's sharp curve was only made at 1200 (first real test, 22 Oct)
SHARP = 1400  # line this far off the centre (outer sensor): turn on the spot
KP = 1.6
KD = 10

# flight recorder: the last LOG_N samples (every 2nd loop, about 3 s) are written to spark_line_log.csv on B
LOG_N = 600
LOG_F = 8  # t_ms, state (0 follow, 1 sharp turn, 2 searching), v0..v4 (calibrated 0..1000), error
log = array("h", [0] * (LOG_N * LOG_F))


def show(*rows):
    display.fill(0)
    for i, r in enumerate(rows):
        display.text(r, 0, i * 12)
    display.show()


def calibrate_turn(left, right, ms):
    # every sensor has to pass over the line once: the outer ones sit 3.5 cm to the side, so the sweep
    # must reach about ±55° (a ±30° sweep leaves DN1 and DN5 uncalibrated)
    motors.set_speeds(left, right)
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < ms:
        line.calibrate()


def save_log(count, t0):
    """Write the recorder to spark_line_log.csv, oldest sample first."""
    n = min(count, LOG_N)
    try:
        with open("spark_line_log.csv", "w") as f:
            f.write("t_ms,state,v0,v1,v2,v3,v4,error\n")
            for k in range(count - n, count):
                i = (k % LOG_N) * LOG_F
                f.write(",".join(str(log[i + j]) for j in range(LOG_F)) + "\n")
        return n
    except OSError:
        return 0


def follow(base):
    """Follow the line until B; returns how often the line was lost and how many samples were recorded."""
    last = 0
    lost = 0
    searching = False
    turn = CURVE
    loops = 0
    count = 0
    t0 = time.ticks_ms()
    state = 0
    error = 0
    while not button_b.check():
        v = line.read_calibrated()
        loops += 1
        if loops & 1:
            i = (count % LOG_N) * LOG_F
            log[i] = time.ticks_diff(time.ticks_ms(), t0) & 0x7FFF
            log[i + 1] = state
            for j in range(5):
                log[i + 2 + j] = v[j]
            log[i + 7] = error
            count += 1
        total = v[0] + v[1] + v[2] + v[3] + v[4]
        if total < 300:
            state = 2
            # line lost: turn towards where it was last
            if not searching:
                lost += 1
                searching = True
            motors.set_speeds(turn if last > 0 else -turn, -turn if last > 0 else turn)
            continue
        searching = False
        position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
        error = position - 2000
        state = 0
        if abs(error) > SHARP:
            state = 1
            # sharp curve: the line has reached an outer sensor. Stop going forward and turn on the spot
            # towards it, before it is lost (driving on would overshoot the corner and find the wrong piece)
            motors.set_speeds(CURVE if error > 0 else -CURVE, -CURVE if error > 0 else CURVE)
            last = error
            continue
        correction = KP * error + KD * (error - last)
        last = error
        # brake when the line wanders off the centre (a curve), full speed when it is centred
        # (small wobble around the line does not count: braking starts at 400 and is full at 1500)
        b = base - (base - CURVE) * min(max(abs(error) - 400, 0), 1100) // 1100 if base > CURVE else base
        motors.set_speeds(b + correction, b - correction)
    motors.off()
    return lost, count, t0


run = 0
lost = 0
while True:
    while not button_a.check():
        if button_c.check():
            speed = (speed + 1) % len(SPEEDS)
        show("On the line?", "A start  B stop", "C max: %d" % SPEEDS[speed], "runs %d lost %d" % (run, lost))
        time.sleep_ms(30)
    time.sleep_ms(500)  # hands off
    show("Calibrating ...")
    line.reset_calibration()
    calibrate_turn(-2000, 2000, 550)
    calibrate_turn(2000, -2000, 1100)
    calibrate_turn(-2000, 2000, 550)
    motors.off()
    buzzer.play_in_background("!T240 L16 V12 ceg")  # calibration done
    show("Go! %d" % SPEEDS[speed], "B: stop")
    lost, count, t0 = follow(SPEEDS[speed])
    run += 1
    show("Saving log ...")
    saved = save_log(count, t0)
    print("run %d: lost the line %d times, log %d samples" % (run, lost, saved))
    show("Log: %d samples" % saved, "A: next run")
    time.sleep_ms(1200)

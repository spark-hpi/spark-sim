# Challenge 1 race: line follower that speeds up on straights and brakes in curves.
# One source for both programs: ROLE = "front" -> challenge1_front.py, ROLE = "back" -> challenge1_back.py.
from zumo_2040_robot import robot
import time

ROLE = "front"

# ---- speed (motor units, max 6000)
MIN_SPEED = 4000     # curve speed (sim: 4500+ starts losing the line)
TOP_SPEED = 6000     # straight speed (motor max)
STRAIGHT_ERR = 250   # smoothed |error| below this = straight (sensors are 1000 apart)
BRAKE_ERR = 600      # a single |error| above this brakes at once
ACCEL = 4            # speed units per ms going up
KP = 3
KD = 25

# ---- opponent ahead (back program only): front proximity levels 0..6, 4 = about 15-20 cm
# Off by default: in the sim, slowing down behind the opponent cost ~2 s per race and bumping did no harm.
FOLLOW_OPPONENT = False
PROX_MS = 30         # a proximity read takes ~7 ms, so only every PROX_MS
CLOSE_LEVEL = 4      # this close: no speeding up
CLOSE_SPEED = 2400   # this close and level 6 (touching): crawl behind it

# ---- line sensor calibration, measured on the real floor (raw read() values; see README)
# White floor reads low, black tape high. These are the simulator's values.
CAL_WHITE = 110
CAL_BLACK = 1024

motors = robot.Motors()
line = robot.LineSensors()
display = robot.Display()
prox = robot.ProximitySensors() if ROLE == "back" and FOLLOW_OPPONENT else None


def show(*rows):
    display.fill(0)
    for i, r in enumerate(rows):
        display.text(r, 0, i * 12)
    display.show()


def wait_for_start():
    # !!! REPLACE this with the IR start code from the official Challenge 1 example !!!
    # Until then it waits for button A, so the robot never drives off early.
    button_a = robot.ButtonA()
    show("IR START", "NOT DONE", "A = go")
    while not button_a.check():
        pass


def set_motors(left, right):
    # keep the left/right difference when one side would clip at 6000
    if left > 6000:
        right -= left - 6000
        left = 6000
    if right > 6000:
        left -= right - 6000
        right = 6000
    motors.set_speeds(left, right)


# fixed calibration: the robot must not move before the start signal
for i in range(5):
    line.cal_min[i] = CAL_WHITE
    line.cal_max[i] = CAL_BLACK

show("Ch1 " + ROLE, "ready")
wait_for_start()
show("Go!")

last = 0
speed = MIN_SPEED
smooth = 0
t_prev = time.ticks_ms()
t_prox = t_prev
near = 0

while True:
    v = line.read_calibrated()
    total = v[0] + v[1] + v[2] + v[3] + v[4]
    now = time.ticks_ms()
    dt = time.ticks_diff(now, t_prev)
    t_prev = now

    if total < 300:
        # line lost: turn towards where it was last
        speed = MIN_SPEED
        motors.set_speeds(2500 if last > 0 else -2500, -2500 if last > 0 else 2500)
        continue

    position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
    error = position - 2000
    smooth = (7 * smooth + abs(error)) // 8

    if prox and time.ticks_diff(now, t_prox) >= PROX_MS:
        prox.read()
        near = min(prox.front_counts_with_left_leds(), prox.front_counts_with_right_leds())
        t_prox = time.ticks_ms()

    if near >= 6:
        speed = CLOSE_SPEED                      # right behind the opponent
    elif smooth > STRAIGHT_ERR or abs(error) > BRAKE_ERR:
        speed = MIN_SPEED                        # curve: brake at once
    elif near >= CLOSE_LEVEL:
        speed = min(speed, MIN_SPEED)            # opponent close ahead: don't speed up
    else:
        speed = min(speed + ACCEL * dt, TOP_SPEED)  # straight: speed up gradually

    correction = KP * error + KD * (error - last)
    last = error
    set_motors(speed + correction, speed - correction)

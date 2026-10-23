# Circle race: follow a line loop as fast as possible and time every lap with the gyro (one lap = 360°), so the
# track needs no start line. C on the start screen: speed · A: start (calibrates first) · B: stop.
# Runs unchanged in the simulator (arena "Line track").
from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
display = robot.Display()
buzzer = robot.Buzzer()
imu = robot.IMU()
button_a = robot.ButtonA()
button_b = robot.ButtonB()
button_c = robot.ButtonC()
imu.reset()
imu.enable_default()

SPEEDS = (2000, 3000, 4000, 5000, 6000)
speed = 1
KP = 1.6  # tuned at speed 3200; steering scales with the speed
KD = 10


def show(*rows):
    display.fill(0)
    for i, r in enumerate(rows):
        display.text(r, 0, i * 11)
    display.show()


def gyro_offset():
    s = 0.0
    for _ in range(50):
        while not imu.gyro.data_ready():
            pass
        imu.gyro.read()
        s += imu.gyro.last_reading_dps[2]
    return s / 50


def calibrate_turn(left, right, ms):
    motors.set_speeds(left, right)
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < ms:
        line.calibrate()


def race(base, offset):
    """Follow the line until B. Returns the list of lap times in seconds."""
    scale = base / 3200
    last = 0
    angle = 0.0  # degrees turned since the start
    laps = []
    t_lap = time.ticks_us()
    t_prev = t_lap
    best = 0
    while not button_b.check():
        # heading from the gyro: one full turn = one lap
        imu.gyro.read()
        now = time.ticks_us()
        angle += (imu.gyro.last_reading_dps[2] - offset) * time.ticks_diff(now, t_prev) / 1000000
        t_prev = now
        if abs(angle) >= 360 * (len(laps) + 1):
            lap = time.ticks_diff(now, t_lap) / 1000000
            t_lap = now
            laps.append(lap)
            best = min(laps)
            buzzer.play_in_background("!T240 L32 V10 c")
            show("LAP %d  %.2f s" % (len(laps), lap), "best %.2f s" % best, "speed %d" % base, "B: stop")
        v = line.read_calibrated()
        total = v[0] + v[1] + v[2] + v[3] + v[4]
        if total < 300:
            # line lost: turn towards where it was last
            t = int(min(base, 3000))
            motors.set_speeds(t if last > 0 else -t, -t if last > 0 else t)
            continue
        position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
        error = position - 2000
        correction = (KP * error + KD * (error - last)) * scale
        last = error
        motors.set_speeds(base + correction, base - correction)
    motors.off()
    return laps


results = {}
while True:
    while not button_a.check():
        if button_c.check():
            speed = (speed + 1) % len(SPEEDS)
        b = results.get(SPEEDS[speed])
        show("CIRCLE RACE", "C speed: %d" % SPEEDS[speed], "best: %s" % ("%.2f s" % b if b else "-"), "A: go  B: stop")
        time.sleep_ms(30)
    show("keep still ...")
    time.sleep_ms(400)
    offset = gyro_offset()
    show("Calibrating ...")
    line.reset_calibration()
    calibrate_turn(-2000, 2000, 550)
    calibrate_turn(2000, -2000, 1100)
    calibrate_turn(-2000, 2000, 550)
    motors.off()
    base = SPEEDS[speed]
    show("GO %d" % base, "B: stop")
    laps = race(base, offset)
    if laps:
        best = min(laps)
        if base not in results or best < results[base]:
            results[base] = best
        print("speed %d: %d laps, best %.2f s, all %s" % (base, len(laps), best, " ".join("%.2f" % x for x in laps)))
        show("%d laps" % len(laps), "best %.2f s" % best, "speed %d" % base, "A: menu")
    else:
        show("no full lap", "speed %d" % base, "A: menu")
    while not button_a.check():
        time.sleep_ms(30)

# SPARK Sim calibration: runs unchanged on a real Zumo 2040 and in the simulator, so every number can be compared.
# Start it with Thonny or `mpremote run zumo_calibration.py`, keep USB connected: results come as text on the
# console (copy them) and briefly on the display. C: next test · A: start · B: abort. Protocol: calibration/README.md
#
#   STRAIGHT  1 s still, then 1.2 s full speed straight: top speed, acceleration, counts (check with a tape measure)
#   SPIN      1.5 s full speed on the spot: turn rate from the gyro and from the encoders -> track slip when turning
#   PUSH      3 s full speed against a kitchen scale at a wall: read the scale; shows track slip and battery
#   BRAKE     full speed, then motors off: braking distance
#   PROX      live proximity counts; A logs a line (note the distance yourself)
#   LINE      live raw line sensor values; A logs an average of 20 reads (note the surface yourself)
#   IMU       live gyro z and acceleration; A logs a line (turn left by hand, tilt the nose up …)
#   TIMING    microseconds per operation (Python, line, proximity, IMU, display …) and free heap
from zumo_2040_robot import robot
import gc
import time

MAX = 6000
CPR = 909.7  # encoder counts per sprocket turn (12 CPR × 75.81:1)
PITCH_D = 0.0342  # m, sprocket pitch circle (simulator value); STRAIGHT checks it with a tape measure
M_PER_COUNT = 3.14159 * PITCH_D / CPR
TRACK_HALF = 0.0422  # m, centre of the robot to the middle of a track
# without batteries (USB only) or on a table: keep only the sensor tests ("PROX", "LINE", "IMU", "TIMING")
TESTS = ("STRAIGHT", "SPIN", "PUSH", "BRAKE", "PROX", "LINE", "IMU", "TIMING")

motors = robot.Motors()
enc = robot.Encoders()
display = robot.Display()
battery = robot.Battery()
prox = robot.ProximitySensors()
line = robot.LineSensors()
button_a = robot.ButtonA()
button_b = robot.ButtonB()
button_c = robot.ButtonC()
imu = robot.IMU()
imu.reset()
imu.enable_default()
imu.gyro.set_output_data_rate(416)

try:
    import machine

    ROBOT_ID = "".join("%02x" % b for b in machine.unique_id())[-6:]
except Exception:
    ROBOT_ID = "sim"


def show(*rows):
    display.fill(0)
    for i, r in enumerate(rows[:6]):
        display.text(r, 0, i * 10)
    display.show()


def result(test, text):
    print("RESULT %s robot=%s mV=%d %s" % (test, ROBOT_ID, battery.get_level_millivolts(), text))


def gyro_offset():
    s = 0.0
    for _ in range(100):
        while not imu.gyro.data_ready():
            pass
        imu.gyro.read()
        s += imu.gyro.last_reading_dps[2]
    return s / 100


def drive_log(left, right, ms, step_ms=10):
    """Drive ms long with (left, right) and log (t_ms, enc_l, enc_r, gyro_dps, mV)."""
    log = []
    enc.get_counts(reset=True)
    t0 = time.ticks_ms()
    motors.set_speeds(left, right)
    due = 0
    while True:
        t = time.ticks_diff(time.ticks_ms(), t0)
        if t >= ms or button_b.check() is True:
            break
        if t >= due:
            imu.gyro.read()
            cl, cr = enc.get_counts()
            log.append((t, cl, cr, imu.gyro.last_reading_dps[2], battery.get_level_millivolts()))
            due += step_ms
    return log


def speed(log, i, k=5):
    """Mean speed in m/s between log rows i-k and i (both tracks averaged)."""
    a, b = log[max(0, i - k)], log[i]
    dt = (b[0] - a[0]) / 1000
    return 0 if dt <= 0 else ((b[1] - a[1]) + (b[2] - a[2])) / 2 * M_PER_COUNT / dt


def test_straight():
    show("STRAIGHT", "keep still ...")
    gyro_offset()
    log = drive_log(MAX, MAX, 1200)
    motors.off()
    if len(log) < 40:
        return result("STRAIGHT", "aborted")
    v = [speed(log, i) for i in range(len(log))]
    vmax = sum(v[-30:]) / 30
    t90 = next(log[i][0] for i in range(len(v)) if v[i] >= 0.9 * vmax)
    time.sleep_ms(500)
    cl, cr = enc.get_counts()
    print("LOG STRAIGHT t_ms,enc_l,enc_r,gyro_dps,mV")
    for row in log:
        print("LOG %d,%d,%d,%.1f,%d" % row)
    result("STRAIGHT", "vmax=%.3f m/s t90=%d ms mV_min=%d counts_to_stop=%d,%d (measure the distance with a tape!)"
           % (vmax, t90, min(r[4] for r in log), cl, cr))
    show("vmax %.2f m/s" % vmax, "t90 %d ms" % t90, "cnt %d %d" % (cl, cr), "tape the dist.!")


def test_spin():
    show("SPIN", "keep still ...")
    off = gyro_offset()
    log = drive_log(-MAX, MAX, 1500)
    motors.off()
    if len(log) < 40:
        return result("SPIN", "aborted")
    late = log[len(log) // 2:]
    gyro = sum(r[3] for r in late) / len(late) - off
    dt = (late[-1][0] - late[0][0]) / 1000
    track = ((late[-1][2] - late[0][2]) - (late[-1][1] - late[0][1])) / 2 * M_PER_COUNT / dt
    kinematic = track / TRACK_HALF * 57.2958  # deg/s if the tracks did not slip
    result("SPIN", "gyro=%.0f dps track=%.3f m/s kinematic=%.0f dps efficiency=%.2f" % (gyro, track, kinematic, gyro / kinematic))
    show("SPIN", "%.0f deg/s" % gyro, "kin. %.0f" % kinematic, "eff %.2f" % (gyro / kinematic))


def test_push():
    show("PUSH", "nose to scale!", "starts in 1.5 s")
    time.sleep_ms(1500)
    log = drive_log(MAX, MAX, 3000)
    motors.off()
    v = speed(log, len(log) - 1, 50) if len(log) > 50 else 0
    result("PUSH", "track_speed=%.3f m/s (slip, the robot stands) read the scale: grams * 0.00981 = N" % v)
    show("PUSH done", "track %.2f m/s" % v, "read the scale")


def test_brake():
    show("BRAKE")
    drive_log(MAX, MAX, 800)
    enc.get_counts(reset=True)
    motors.off()
    time.sleep_ms(600)
    cl, cr = enc.get_counts()
    d = (cl + cr) / 2 * M_PER_COUNT
    result("BRAKE", "distance=%.3f m (encoders; check with a tape)" % d)
    show("BRAKE", "%.1f cm" % (d * 100))


def live(name, read, header):
    """Live values on the display; A logs a line, B ends."""
    n = 0
    while button_b.check() is not True:
        values = read()
        rows = [" ".join(str(x) for x in values[i:i + 3]) for i in range(0, len(values), 3)]
        show(name, *rows, "A = log  B = end")
        if button_a.check() is True:
            n += 1
            print("BUTTON A: %s logged #%d" % (name, n))
            print("RESULT %s robot=%s #%d %s = %s" % (name, ROBOT_ID, n, header, ",".join(str(x) for x in values)))
        time.sleep_ms(50)
    print("BUTTON B: %s ended after %d logged lines" % (name, n))


def prox_counts():
    prox.read()
    return (prox.left_counts_with_left_leds(), prox.left_counts_with_right_leds(), prox.front_counts_with_left_leds(),
            prox.front_counts_with_right_leds(), prox.right_counts_with_left_leds(), prox.right_counts_with_right_leds())


def line_average():
    s = [0] * 5
    for _ in range(20):
        r = line.read()
        for i in range(5):
            s[i] += r[i]
    return tuple(x // 20 for x in s)


def imu_values():
    imu.read()
    g = imu.gyro.last_reading_dps
    a = imu.acc.last_reading_g
    return ("%.0f" % g[2], "%.2f" % a[0], "%.2f" % a[1], "%.2f" % a[2])


def per_call_us(f, n):
    t0 = time.ticks_us()
    for _ in range(n):
        f()
    return time.ticks_diff(time.ticks_us(), t0) / n


def python_loop():
    x = 0
    for i in range(1000):
        x += i * 3
    return x


def nothing():
    pass


def test_timing():
    show("TIMING", "measuring ...")
    motors.off()
    gc.collect()
    free = gc.mem_free()
    base = per_call_us(nothing, 2000)
    rows = (
        ("python_loop_per_iteration", per_call_us(python_loop, 5) / 1000),
        ("empty_call", base),
        ("line_read", per_call_us(line.read, 50) - base),
        ("prox_read", per_call_us(prox.read, 20) - base),
        ("gyro_read", per_call_us(imu.gyro.read, 50) - base),
        ("imu_read_all", per_call_us(imu.read, 30) - base),
        ("encoders", per_call_us(enc.get_counts, 100) - base),
        ("battery", per_call_us(battery.get_level_millivolts, 100) - base),
        ("motors", per_call_us(lambda: motors.set_speeds(0, 0), 100) - base),
        ("display_show", per_call_us(display.show, 10) - base),
    )
    t0 = time.ticks_us()
    gc.collect()
    gc_us = time.ticks_diff(time.ticks_us(), t0)
    result("TIMING", " ".join("%s=%.1fus" % r for r in rows) + " gc_collect=%dus heap_free=%d" % (gc_us, free))
    show("TIMING (us)", "py iter %.1f" % rows[0][1], "line %.0f" % rows[2][1], "prox %.0f" % rows[3][1], "heap %d" % free)


try:
    choice = 0
    print("SPARK calibration · robot %s · battery %d mV · heap free %d" % (ROBOT_ID, battery.get_level_millivolts(), gc.mem_free()))
    print("MENU > %s" % TESTS[choice])
    while True:
        show("CALIBRATION", "> " + TESTS[choice], "C next  A start", "%d mV" % battery.get_level_millivolts())
        if button_c.check() is True:
            choice = (choice + 1) % len(TESTS)
            print("BUTTON C: menu > %s" % TESTS[choice])
        if button_a.check() is True:
            name = TESTS[choice]
            print("BUTTON A: start %s" % name)
            time.sleep_ms(1000)  # hands off
            if name == "PROX":
                live("PROX", prox_counts, "ll lr fl fr rl rr")
            elif name == "LINE":
                live("LINE", line_average, "raw 0..4")
            elif name == "IMU":
                live("IMU", imu_values, "gz ax ay az")
            else:
                {"STRAIGHT": test_straight, "SPIN": test_spin, "PUSH": test_push, "BRAKE": test_brake, "TIMING": test_timing}[name]()
                motors.off()
                # the result stays on the display until A or C
                while button_a.check() is not True and button_c.check() is not True:
                    time.sleep_ms(20)
            print("MENU > %s" % TESTS[choice])
        time.sleep_ms(20)
finally:
    motors.off()

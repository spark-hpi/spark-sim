# Hello Zumo: shows that the simulator supports all on-board hardware. Runs unchanged on the real robot.
from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
prox = robot.ProximitySensors()
encoders = robot.Encoders()
display = robot.Display()
battery = robot.Battery()
leds = robot.RGBLEDs()
buzzer = robot.Buzzer()
imu = robot.IMU()
imu.reset()
imu.enable_default()

display.fill(0)
display.text("Hello SPARK!", 0, 0)
display.text("Battery %d mV" % battery.get_level_millivolts(), 0, 16)
display.show()
for i in range(6):
    leds.set_hsv(i, [i * 60, 255, 40])
leds.show()
buzzer.play_in_background("T180 L16 cegc>c")

print("start at", time.ticks_ms(), "ms")
motors.set_speeds(3000, 3000)
time.sleep_ms(500)
motors.off()
time.sleep_ms(200)
print("encoders after 0.5 s at half power:", encoders.get_counts())
print("line sensors:", list(line.read()))
prox.read()
print("front proximity (left/right LEDs):", prox.front_counts_with_left_leds(), prox.front_counts_with_right_leds())
imu.read()
print("acceleration (g):", ["%.2f" % v for v in imu.acc.last_reading_g])

t = time.ticks_us()
x = 0
for i in range(1000):
    x += i
print("1000 loop iterations take", time.ticks_diff(time.ticks_us(), t), "us of robot time")

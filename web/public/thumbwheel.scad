include <parameters.scad>

// The orange gear thumb wheel. A cylinder lying on its side (axis along X) with
// grip grooves cut parallel to the axis, all the way around. Scrolls up/down in
// the app; here it just shows the ribbed face like the reference photo.

module thumbwheel() {
  difference() {
    rotate([0, 90, 0]) cylinder(r = wheel_r, h = wheel_w, center = true);
    for (i = [0 : wheel_grooves - 1]) {
      a = i * 360 / wheel_grooves;
      rotate([a, 0, 0])
        translate([0, 0, wheel_r])
          rotate([0, 90, 0])
            cylinder(d = groove_d, h = wheel_w + 2, center = true);
    }
  }
}

thumbwheel();

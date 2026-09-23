/**
 * Minimal Cesium stand-in for cyber layer unit tests.
 *
 * Used only when the real `cesium` package cannot be resolved (e.g. a
 * checkout without node_modules). It implements just enough of the API
 * surface the cyber layer touches — entity storage, property getValue(),
 * and spherical coordinate math with an exact fromDegrees/fromCartesian
 * round-trip — so lifecycle, stats, and analyst-record tests run headless.
 */
const G = globalThis.Math;
const EARTH_RADIUS_M = 6378137;

export class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  magnitude() {
    return G.hypot(this.x, this.y, this.z);
  }
  static magnitude(cartesian) {
    return G.hypot(cartesian.x, cartesian.y, cartesian.z);
  }
  static fromDegrees(lon, lat, height = 0) {
    const lambda = (lon * G.PI) / 180;
    const phi = (lat * G.PI) / 180;
    const r = EARTH_RADIUS_M + height;
    return new Cartesian3(
      r * G.cos(phi) * G.cos(lambda),
      r * G.cos(phi) * G.sin(lambda),
      r * G.sin(phi),
    );
  }
}

export const Cartographic = {
  fromCartesian(cartesian) {
    const r = G.hypot(cartesian.x, cartesian.y, cartesian.z) || 1;
    return {
      latitude: G.asin(G.max(-1, G.min(1, cartesian.z / r))),
      longitude: G.atan2(cartesian.y, cartesian.x),
      height: r - EARTH_RADIUS_M,
    };
  },
};

export const CesiumMath = {
  toDegrees: (radians) => (radians * 180) / G.PI,
  toRadians: (degrees) => (degrees * G.PI) / 180,
};
export { CesiumMath as Math };

export class Color {
  constructor(red = 1, green = 1, blue = 1, alpha = 1) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
  withAlpha(alpha) {
    return new Color(this.red, this.green, this.blue, alpha);
  }
  toCssColorString() {
    const channel = (v) => G.round(v * 255);
    return `rgba(${channel(this.red)},${channel(this.green)},${channel(this.blue)},${this.alpha})`;
  }
}
for (const [name, rgb] of Object.entries({
  RED: [1, 0, 0],
  ORANGE: [1, 0.647, 0],
  MAGENTA: [1, 0, 1],
  YELLOW: [1, 1, 0],
  CYAN: [0, 1, 1],
  LIME: [0, 1, 0],
  GRAY: [0.5, 0.5, 0.5],
})) {
  Color[name] = new Color(...rgb, 1);
}

export class ColorMaterialProperty {
  constructor(color) {
    this.color = color;
  }
}

export const HeightReference = { CLAMP_TO_GROUND: 1, NONE: 0 };
export const ArcType = { NONE: 0, GEODESIC: 1, RHUMB: 2 };
export const JulianDate = { now: () => ({}) };

export class Entity {
  constructor(options = {}) {
    this.id = options.id;
    this.polyline = options.polyline;
    this.ellipse = options.ellipse;
    this.point = options.point;
    const position = options.position;
    this.position =
      position === undefined ? undefined : { getValue: () => position };
    this.properties = {};
    for (const [key, value] of Object.entries(options.properties || {})) {
      this.properties[key] = { getValue: () => value };
    }
  }
}

export class CustomDataSource {
  constructor(name) {
    this.name = name;
    this.show = true;
    const list = [];
    this.entities = {
      add: (entity) => {
        list.push(entity);
        return entity;
      },
      removeAll: () => {
        list.length = 0;
      },
      get values() {
        return list;
      },
    };
  }
}

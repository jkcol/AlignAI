/**
 * Procedural pose synthesis for the public demo.
 *
 * Generates MediaPipe-33 landmark frames for a bodyweight squat, so the demo
 * has a reference track to score against without shipping (or licensing) any
 * video. The same generator produces a "user" track with injectable form
 * errors, which drives the demo when no webcam is available.
 *
 * The skeleton is built in 3D body coordinates from sagittal-plane joint
 * angles, then projected at a three-quarter view. Building it in 3D rather
 * than drawing a 2D figure matters: a squat viewed head-on foreshortens the
 * thighs to near-zero length at the bottom of the rep, and `comparePose`
 * scores limbs by the direction of their vectors — near-zero-length vectors
 * have unstable directions and wash out real form differences.
 *
 * Output follows the MediaPipe convention: x/y normalized to the image
 * ([0,1], y down), z roughly the same scale as x with negative = toward the
 * camera.
 */

export type Vec3 = [number, number, number];
export type Landmarks = Vec3[];

export interface FormErrors {
  /** Knees cave inward toward the midline. 0 = none, 1 = severe. */
  valgus: number;
  /** Rep does not reach depth. 0 = full depth, 1 = quarter squat. */
  shallow: number;
  /** Torso pitches too far forward. 0 = matching reference, 1 = severe. */
  lean: number;
  /** Knees travel too far forward over the toes. */
  kneesForward: number;
  /** Left/right imbalance. Signed: positive sinks the left side, negative the right. */
  asymmetry: number;
}

export const NO_ERRORS: FormErrors = {
  valgus: 0,
  shallow: 0,
  lean: 0,
  kneesForward: 0,
  asymmetry: 0,
};

/** Seconds for one full down-up rep. */
export const REP_PERIOD_S = 3.2;

// --- Geometry -------------------------------------------------------------

const DEG = Math.PI / 180;

/** Segment lengths in body units (shin = 0.42 ≈ hip height 0.84 when standing). */
const L_SHIN = 0.42;
const L_THIGH = 0.42;
const L_TORSO = 0.52;
const L_UPPER_ARM = 0.3;
const L_FOREARM = 0.28;
const L_NECK = 0.16;

/** Half-widths (lateral offset from the midline). */
const W_HIP = 0.09;
const W_SHOULDER = 0.15;
const W_STANCE = 0.13;

/** Three-quarter camera angle: enough depth to read a squat, enough width to read knee travel. */
const YAW = 40 * DEG;

/** Image placement. */
const IMG_CENTER_X = 0.5;
const IMG_ANKLE_Y = 0.88;
const IMG_SCALE = 0.44;
/** z is reported at a slightly smaller scale than x/y, as MediaPipe tends to. */
const Z_SCALE = 0.34;

/** A point in body coordinates: lateral (person's left +), up (+), forward (+, facing). */
type Body = { x: number; u: number; f: number };

const b = (x: number, u: number, f: number): Body => ({ x, u, f });

/** Projects a body-space point to a MediaPipe-style landmark. */
function project(p: Body): Vec3 {
  const sx = p.x * Math.cos(YAW) + p.f * Math.sin(YAW);
  const depth = -p.x * Math.sin(YAW) + p.f * Math.cos(YAW);
  return [
    IMG_CENTER_X + IMG_SCALE * sx,
    IMG_ANKLE_Y - IMG_SCALE * p.u,
    -Z_SCALE * depth,
  ];
}

/**
 * Squat depth as a function of time: a smooth down-up cycle with a brief hold
 * at the top, which is what gives the rep counter a clean edge to latch onto.
 */
export function squatPhase(t: number): number {
  const u = ((((t % REP_PERIOD_S) + REP_PERIOD_S) % REP_PERIOD_S) / REP_PERIOD_S);
  if (u > 0.85) return 0;
  return (1 - Math.cos((2 * Math.PI * u) / 0.85)) / 2;
}

/** Builds one leg (ankle → knee → hip) in body coordinates. */
function leg(side: 1 | -1, depth: number, errors: FormErrors) {
  // Shank pitches forward as the knee travels over the foot; the thigh rotates
  // toward horizontal as the hip drops and travels back.
  const shankAngle = depth * (22 + 26 * errors.kneesForward) * DEG;
  const thighAngle = depth * 78 * DEG;

  // Valgus pulls the knee toward the midline; the ankle stays planted.
  const ankleX = side * W_STANCE;
  const kneeX = side * W_STANCE * (1 - 0.92 * errors.valgus * depth);
  const hipX = side * W_HIP;

  const ankle = b(ankleX, 0, 0);
  const knee = b(
    kneeX,
    L_SHIN * Math.cos(shankAngle),
    L_SHIN * Math.sin(shankAngle)
  );
  const hip = b(
    hipX,
    knee.u + L_THIGH * Math.cos(thighAngle),
    knee.f - L_THIGH * Math.sin(thighAngle)
  );

  return { ankle, knee, hip };
}

/**
 * Builds one frame of the squat at depth `d` (0 = standing, 1 = bottom),
 * with optional form errors applied.
 */
export function squatFrame(d: number, errors: FormErrors = NO_ERRORS): Landmarks {
  const base = Math.max(0, Math.min(1, d)) * (1 - 0.65 * errors.shallow);

  // Asymmetry sinks one side deeper than the other (sign picks which).
  const dL = Math.max(0, Math.min(1, base * (1 + 0.3 * errors.asymmetry)));
  const dR = Math.max(0, Math.min(1, base * (1 - 0.3 * errors.asymmetry)));

  const left = leg(1, dL, errors);
  const right = leg(-1, dR, errors);

  const depth = base;
  const hipMid = b(
    (left.hip.x + right.hip.x) / 2,
    (left.hip.u + right.hip.u) / 2,
    (left.hip.f + right.hip.f) / 2
  );

  // Torso counterbalances the hips travelling back; extra lean pitches it further.
  const torsoAngle = depth * (38 + 34 * errors.lean) * DEG;
  const torsoUp = Math.cos(torsoAngle);
  const torsoFwd = Math.sin(torsoAngle);

  const shoulderMid = b(
    hipMid.x,
    hipMid.u + L_TORSO * torsoUp,
    hipMid.f + L_TORSO * torsoFwd
  );

  const shoulder = (side: 1 | -1) =>
    b(shoulderMid.x + side * W_SHOULDER, shoulderMid.u, shoulderMid.f);

  // Arms reach forward for counterbalance as the squat deepens.
  const armAngle = (25 + 55 * depth) * DEG;
  const elbowOf = (sh: Body, side: 1 | -1) =>
    b(
      sh.x - side * 0.02,
      sh.u - L_UPPER_ARM * Math.cos(armAngle),
      sh.f + L_UPPER_ARM * Math.sin(armAngle)
    );
  const wristOf = (el: Body, side: 1 | -1) => {
    const fore = armAngle + (35 + 30 * depth) * DEG;
    return b(
      el.x - side * 0.02,
      el.u - L_FOREARM * Math.cos(fore),
      el.f + L_FOREARM * Math.sin(fore)
    );
  };

  const lSh = shoulder(1);
  const rSh = shoulder(-1);
  const lEl = elbowOf(lSh, 1);
  const rEl = elbowOf(rSh, -1);
  const lWr = wristOf(lEl, 1);
  const rWr = wristOf(rEl, -1);

  // Head sits on the neck, tipping forward with the torso.
  const head = b(
    shoulderMid.x,
    shoulderMid.u + L_NECK * torsoUp,
    shoulderMid.f + L_NECK * torsoFwd
  );

  const lm: Landmarks = new Array(33);
  const set = (i: number, p: Body) => {
    lm[i] = project(p);
  };
  const near = (p: Body, dx: number, du: number, df: number) =>
    b(p.x + dx, p.u + du, p.f + df);

  // Face
  set(0, near(head, 0, 0, 0.06));
  set(1, near(head, 0.025, 0.03, 0.05));
  set(2, near(head, 0.035, 0.03, 0.05));
  set(3, near(head, 0.045, 0.03, 0.045));
  set(4, near(head, -0.025, 0.03, 0.05));
  set(5, near(head, -0.035, 0.03, 0.05));
  set(6, near(head, -0.045, 0.03, 0.045));
  set(7, near(head, 0.06, 0.015, -0.01));
  set(8, near(head, -0.06, 0.015, -0.01));
  set(9, near(head, 0.022, -0.035, 0.05));
  set(10, near(head, -0.022, -0.035, 0.05));

  // Upper body
  set(11, lSh);
  set(12, rSh);
  set(13, lEl);
  set(14, rEl);
  set(15, lWr);
  set(16, rWr);
  set(17, near(lWr, 0.02, -0.03, 0.02));
  set(18, near(rWr, -0.02, -0.03, 0.02));
  set(19, near(lWr, 0.005, -0.04, 0.035));
  set(20, near(rWr, -0.005, -0.04, 0.035));
  set(21, near(lWr, -0.015, -0.025, 0.03));
  set(22, near(rWr, 0.015, -0.025, 0.03));

  // Lower body
  set(23, left.hip);
  set(24, right.hip);
  set(25, left.knee);
  set(26, right.knee);
  set(27, left.ankle);
  set(28, right.ankle);
  set(29, near(left.ankle, 0, -0.02, -0.06));
  set(30, near(right.ankle, 0, -0.02, -0.06));
  set(31, near(left.ankle, 0, -0.035, 0.11));
  set(32, near(right.ankle, 0, -0.035, 0.11));

  return lm;
}

/** Reference (textbook) squat at time `t` seconds. */
export function referenceFrameAt(t: number): Landmarks {
  return squatFrame(squatPhase(t), NO_ERRORS);
}

/** Smooth 0..1 cycle with a period of `period` seconds. */
function cycle(t: number, period: number, offset = 0): number {
  return (1 - Math.cos((2 * Math.PI * (t + offset)) / period)) / 2;
}

/** Seconds for the trainee to drift from clean form to sloppy and back. */
const FATIGUE_PERIOD_S = 14;

/**
 * How sloppy the simulated trainee is right now, 0 (clean) to 1 (falling apart).
 *
 * The demo needs to move through the score range the engine actually produces,
 * not sit at a flat 99. `comparePose` scores limbs by direction cosine mapped
 * to (cos+1)/2, which is forgiving: subtle faults alone barely register. What
 * genuinely moves the score is losing depth and falling out of sync with the
 * reference — which is also what a tiring beginner really does.
 */
export function sloppinessAt(t: number): number {
  return cycle(t, FATIGUE_PERIOD_S);
}

/** How far behind the reference the trainee is, in seconds. */
export function lagAt(t: number): number {
  return 0.08 + 0.78 * sloppinessAt(t);
}

/** Form errors the simulated trainee exhibits at time `t`. */
export function simulatedErrorsAt(t: number): FormErrors {
  const s = sloppinessAt(t);
  // Each fault rides the fatigue cycle but peaks at its own time, so the
  // coach calls out different joints rather than the same one every rep.
  return {
    shallow: Math.min(1, 0.1 + 0.88 * s),
    valgus: s * cycle(t, 13, 2),
    lean: s * cycle(t, 11, 5),
    kneesForward: s * cycle(t, 17, 9),
    // Signed and slow, so the coach flags the left leg on some reps and the
    // right on others rather than always naming the same side.
    asymmetry: s * Math.sin((2 * Math.PI * (t + 4)) / 19),
  };
}

/**
 * Simulated user squat at time `t`. Form degrades and recovers on a slow cycle
 * so the demo shows clean reps, the coach catching a breakdown, and recovery.
 */
export function simulatedUserFrameAt(t: number): Landmarks {
  return squatFrame(squatPhase(t - lagAt(t)), simulatedErrorsAt(t));
}

/**
 * Mirrors a synthetic frame's left/right landmarks.
 *
 * `comparePoseWithCoaching` swaps the live pose's left/right landmarks
 * internally to handle mirror mode (the user faces the camera, so their right
 * matches the instructor's left). Synthetic user frames are authored in the
 * same frame of reference as the synthetic reference, so we pre-swap here to
 * cancel that out.
 */
export function preFlipForMirror(lm: Landmarks): Landmarks {
  const PAIRS: [number, number][] = [
    [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],
    [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
    [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
  ];
  const out = lm.slice() as Landmarks;
  for (const [a, c] of PAIRS) {
    const tmp = out[a];
    out[a] = out[c];
    out[c] = tmp;
  }
  return out;
}

/**
 * Pre-computes a reference track sampled at `fps`, matching the shape the app's
 * preprocess step produces: `{ t, landmarks }` per frame.
 */
export function buildReferenceTrack(fps = 15, cycles = 1): { t: number; landmarks: Landmarks }[] {
  const total = Math.round(REP_PERIOD_S * cycles * fps);
  const frames: { t: number; landmarks: Landmarks }[] = [];
  for (let i = 0; i < total; i++) {
    const t = i / fps;
    frames.push({ t: Number(t.toFixed(3)), landmarks: referenceFrameAt(t) });
  }
  return frames;
}

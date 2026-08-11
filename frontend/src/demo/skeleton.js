/**
 * Canvas skeleton renderer for the demo.
 *
 * Draws a MediaPipe-33 landmark frame as a stick figure. Limbs can be tinted
 * per-limb by score so the visitor can see *which* joint the coach is talking
 * about, not just the number.
 */

/** [fromIdx, toIdx, limbName] — limbName matches comparePose's limbScores keys. */
const BONES = [
  [11, 12, "torso"],
  [11, 23, "left_torso"],
  [12, 24, "right_torso"],
  [23, 24, "torso"],
  [11, 13, "left_upper_arm"],
  [13, 15, "left_forearm"],
  [12, 14, "right_upper_arm"],
  [14, 16, "right_forearm"],
  [23, 25, "left_thigh"],
  [25, 27, "left_shin"],
  [24, 26, "right_thigh"],
  [26, 28, "right_shin"],
  [27, 31, null],
  [28, 32, null],
];

const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** Green → amber → red by score. */
function scoreColor(score, alpha = 1) {
  if (score == null) return `rgba(148, 163, 184, ${alpha})`;
  const s = Math.max(0, Math.min(1, score));
  if (s >= 0.75) return `rgba(52, 211, 153, ${alpha})`;
  if (s >= 0.55) return `rgba(251, 191, 36, ${alpha})`;
  return `rgba(248, 113, 113, ${alpha})`;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number,number,number][]} landmarks - 33 normalized landmarks
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.limbScores] - tint bones by score
 * @param {string} [opts.color] - flat color when limbScores is omitted
 * @param {number} [opts.lineWidth]
 * @param {boolean} [opts.mirror] - flip horizontally (for webcam-style preview)
 */
export function drawSkeleton(ctx, landmarks, opts = {}) {
  if (!landmarks || landmarks.length < 33) return;

  const { width: w, height: h } = ctx.canvas;
  const { limbScores, color = "#7dd3fc", lineWidth = 6, mirror = false } = opts;

  const px = (lm) => {
    const x = mirror ? 1 - lm[0] : lm[0];
    return [x * w, lm[1] * h];
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const [from, to, limb] of BONES) {
    const a = landmarks[from];
    const b = landmarks[to];
    if (!a || !b) continue;
    const [ax, ay] = px(a);
    const [bx, by] = px(b);

    const stroke = limbScores && limb ? scoreColor(limbScores[limb]) : color;

    // Soft glow underneath so the figure reads against the video behind it.
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = lineWidth + 8;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // Head
  const nose = landmarks[0];
  const lSh = landmarks[11];
  const rSh = landmarks[12];
  if (nose && lSh && rSh) {
    const [nx, ny] = px(nose);
    const shoulderSpan = Math.abs(px(lSh)[0] - px(rSh)[0]);
    const r = Math.max(10, shoulderSpan * 0.38);
    ctx.strokeStyle = limbScores ? scoreColor(limbScores.torso) : color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(nx, ny - r * 0.35, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Joints
  ctx.fillStyle = "#f8fafc";
  for (const i of JOINTS) {
    const lm = landmarks[i];
    if (!lm) continue;
    const [x, y] = px(lm);
    ctx.beginPath();
    ctx.arc(x, y, lineWidth * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/** Sizes a canvas to its CSS box at device pixel ratio. Returns true if resized. */
export function fitCanvas(canvas) {
  if (!canvas) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { comparePoseWithCoaching } from "../comparePose";
import { createVoiceCoachingEngine, preloadVoices } from "../voiceCoaching";
import {
  REP_PERIOD_S,
  referenceFrameAt,
  simulatedUserFrameAt,
  preFlipForMirror,
} from "./poseSynth";
import { drawSkeleton, fitCanvas } from "./skeleton";
import "./demo.css";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm";

const EXERCISE_MUSCLE = "quadriceps";
const COMPARE_HZ = 15;

/** Limbs surfaced in the breakdown panel, in display order. */
const TRACKED_LIMBS = [
  ["left_thigh", "L thigh"],
  ["right_thigh", "R thigh"],
  ["left_shin", "L shin"],
  ["right_shin", "R shin"],
  ["torso", "Torso"],
  ["left_upper_arm", "L arm"],
  ["right_upper_arm", "R arm"],
];

function scoreClass(score) {
  if (score == null) return "";
  if (score >= 75) return "good";
  if (score >= 55) return "ok";
  return "bad";
}

export default function DemoApp() {
  // "sim" = synthetic user track, "webcam" = live MediaPipe on your camera.
  const [source, setSource] = useState("sim");
  const [camState, setCamState] = useState("idle"); // idle | loading | live | denied | error
  const [camError, setCamError] = useState("");
  const [voiceOn, setVoiceOn] = useState(false);
  const [running, setRunning] = useState(true);

  const [score, setScore] = useState(null);
  const [limbScores, setLimbScores] = useState({});
  const [feedback, setFeedback] = useState(null);
  const [reps, setReps] = useState(0);
  const [avgScore, setAvgScore] = useState(null);

  const refCanvasRef = useRef(null);
  const userCanvasRef = useRef(null);
  const videoRef = useRef(null);

  const landmarkerRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const clockRef = useRef({ start: null, t: 0 });
  const lastCompareRef = useRef(0);
  const voiceRef = useRef(null);
  const voiceOnRef = useRef(false);
  const sourceRef = useRef("sim");
  const runningRef = useRef(true);

  // Rep detection state, driven off hip height.
  const repRef = useRef({ down: false, minY: 1, maxY: 0, samples: [] });
  const scoreAccRef = useRef({ sum: 0, n: 0 });

  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);
  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => { runningRef.current = running; }, [running]);

  useEffect(() => {
    preloadVoices();
    voiceRef.current = createVoiceCoachingEngine();
    return () => voiceRef.current?.cancel();
  }, []);

  // --- Webcam + MediaPipe ------------------------------------------------

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startWebcam = useCallback(async () => {
    setCamState("loading");
    setCamError("");
    try {
      if (!landmarkerRef.current) {
        const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
        landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL },
          runningMode: "VIDEO",
          numPoses: 1,
        });
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamState("live");
      setSource("webcam");
      repRef.current = { down: false, minY: 1, maxY: 0, samples: [] };
      scoreAccRef.current = { sum: 0, n: 0 };
      setReps(0);
    } catch (err) {
      stopWebcam();
      const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
      setCamState(denied ? "denied" : "error");
      setCamError(
        denied
          ? "Camera permission was denied — the simulated run below still shows the full pipeline."
          : err?.message || "Could not start the camera."
      );
      setSource("sim");
    }
  }, [stopWebcam]);

  const useSimulated = useCallback(() => {
    stopWebcam();
    setCamState("idle");
    setCamError("");
    setSource("sim");
    repRef.current = { down: false, minY: 1, maxY: 0, samples: [] };
    scoreAccRef.current = { sum: 0, n: 0 };
    setReps(0);
  }, [stopWebcam]);

  useEffect(() => stopWebcam, [stopWebcam]);

  // --- Main loop ---------------------------------------------------------

  useEffect(() => {
    let stopped = false;

    function frame(now) {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(frame);

      const clock = clockRef.current;
      if (clock.start == null) clock.start = now;
      if (!runningRef.current) {
        // Freeze the clock while paused by sliding the origin forward.
        clock.start = now - clock.t * 1000;
      } else {
        clock.t = (now - clock.start) / 1000;
      }
      const t = clock.t;

      // Reference is always the synthetic textbook squat.
      const refLm = referenceFrameAt(t);

      // Live pose: real landmarks from the webcam, or the synthetic user.
      let liveLm = null;
      let liveIsSynthetic = false;
      if (sourceRef.current === "webcam" && landmarkerRef.current && videoRef.current) {
        const v = videoRef.current;
        if (v.readyState >= 2 && v.videoWidth > 0) {
          const result = landmarkerRef.current.detectForVideo(v, now);
          if (result?.landmarks?.length) {
            liveLm = result.landmarks[0].map((p) => [p.x, p.y, p.z]);
          }
        }
      } else {
        liveLm = preFlipForMirror(simulatedUserFrameAt(t));
        liveIsSynthetic = true;
      }

      // --- Score at a fixed rate, using the app's real comparison engine ---
      let currentLimbScores = null;
      if (liveLm && now - lastCompareRef.current >= 1000 / COMPARE_HZ) {
        lastCompareRef.current = now;
        const result = comparePoseWithCoaching(
          { landmarks: refLm },
          { landmarks: liveLm },
          { exerciseMuscle: EXERCISE_MUSCLE }
        );
        currentLimbScores = result.limbScores;
        const s100 = Math.round(result.score * 100);
        setScore(s100);
        setLimbScores(result.limbScores);
        setFeedback(result.feedback);

        const acc = scoreAccRef.current;
        acc.sum += s100;
        acc.n += 1;
        setAvgScore(Math.round(acc.sum / acc.n));

        if (voiceOnRef.current && voiceRef.current) {
          voiceRef.current.processFrame({
            score: result.score,
            limbScores: result.limbScores,
            feedback: result.feedback,
          });
        }

        // Rep counting off hip height: a rep closes when the hips drop past a
        // threshold and come back up. Works for both real and synthetic poses.
        const lHip = liveLm[23];
        const rHip = liveLm[24];
        if (lHip && rHip) {
          const hipY = (lHip[1] + rHip[1]) / 2;
          const rep = repRef.current;
          rep.samples.push(hipY);
          if (rep.samples.length > 90) rep.samples.shift();
          if (rep.samples.length > 20) {
            const lo = Math.min(...rep.samples);
            const hi = Math.max(...rep.samples);
            const range = hi - lo;
            if (range > 0.04) {
              const downLine = lo + range * 0.7;
              const upLine = lo + range * 0.3;
              if (!rep.down && hipY > downLine) rep.down = true;
              else if (rep.down && hipY < upLine) {
                rep.down = false;
                setReps((r) => r + 1);
              }
            }
          }
        }
      }

      // --- Render ----------------------------------------------------------
      const refCanvas = refCanvasRef.current;
      if (refCanvas) {
        fitCanvas(refCanvas);
        const ctx = refCanvas.getContext("2d");
        ctx.clearRect(0, 0, refCanvas.width, refCanvas.height);
        drawSkeleton(ctx, refLm, { color: "#7dd3fc", lineWidth: 7 });
      }

      const userCanvas = userCanvasRef.current;
      if (userCanvas) {
        fitCanvas(userCanvas);
        const ctx = userCanvas.getContext("2d");
        ctx.clearRect(0, 0, userCanvas.width, userCanvas.height);
        if (liveLm) {
          drawSkeleton(ctx, liveLm, {
            limbScores: currentLimbScores || undefined,
            lineWidth: 7,
            // Synthetic frames are pre-flipped for the engine; un-flip to draw.
            mirror: liveIsSynthetic,
          });
        }
      }
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onToggleVoice = () => {
    setVoiceOn((v) => {
      const next = !v;
      if (!next) voiceRef.current?.cancel();
      return next;
    });
  };

  const isSim = source === "sim";
  const tempo = Math.round(60 / REP_PERIOD_S);

  return (
    <div className="demo-root">
      <header className="demo-header">
        <div className="demo-brand">
          <span className="demo-logo">◆</span>
          <div>
            <h1>AlignAI</h1>
            <p>Real-time exercise form coach — live demo</p>
          </div>
        </div>
        <a
          className="demo-repo-link"
          href="https://github.com/jkcol/AlignAI"
          target="_blank"
          rel="noreferrer"
        >
          View source on GitHub →
        </a>
      </header>

      <div className="demo-banner">
        <strong>What you're seeing:</strong> the reference figure and — in simulated
        mode — the trainee are both procedurally generated, so this page needs no
        server, no API keys, and no video downloads. Everything else is the real
        thing: pose scoring, per-limb breakdown, coaching messages and rep
        counting all run through the same{" "}
        <code>comparePose</code> engine the full app uses, in your browser.{" "}
        <button className="demo-inline-btn" onClick={startWebcam}>
          Turn on your camera
        </button>{" "}
        to score your own form against the reference.
      </div>

      <div className="demo-stage">
        <section className="demo-panel">
          <div className="demo-panel-head">
            <h2>Reference</h2>
            <span className="demo-tag">Bodyweight squat · {tempo} rpm</span>
          </div>
          <div className="demo-canvas-wrap">
            <canvas ref={refCanvasRef} className="demo-canvas" />
          </div>
        </section>

        <section className="demo-panel">
          <div className="demo-panel-head">
            <h2>You</h2>
            <span className={`demo-tag ${isSim ? "" : "live"}`}>
              {isSim ? "Simulated trainee" : "Live camera"}
            </span>
          </div>
          <div className="demo-canvas-wrap">
            <video
              ref={videoRef}
              className={`demo-video ${camState === "live" ? "visible" : ""}`}
              playsInline
              muted
            />
            <canvas ref={userCanvasRef} className="demo-canvas" />
            {camState === "loading" && (
              <div className="demo-overlay">Starting camera…</div>
            )}
          </div>
        </section>

        <aside className="demo-readout">
          <div className={`demo-score ${scoreClass(score)}`}>
            <div className="demo-score-value">{score == null ? "—" : score}</div>
            <div className="demo-score-label">Form score</div>
          </div>

          <div className="demo-stats">
            <div>
              <span className="demo-stat-value">{reps}</span>
              <span className="demo-stat-label">Reps</span>
            </div>
            <div>
              <span className="demo-stat-value">{avgScore == null ? "—" : avgScore}</span>
              <span className="demo-stat-label">Session avg</span>
            </div>
          </div>

          <div className="demo-feedback">
            <h3>Coach</h3>
            <p className={feedback?.message ? "active" : ""}>
              {feedback?.message || "Form looks good — keep going."}
            </p>
          </div>

          <div className="demo-limbs">
            <h3>Per-limb match</h3>
            {TRACKED_LIMBS.map(([key, label]) => {
              const v = limbScores[key];
              const pct = v == null ? 0 : Math.round(v * 100);
              return (
                <div className="demo-limb" key={key}>
                  <span className="demo-limb-label">{label}</span>
                  <div className="demo-limb-track">
                    <div
                      className={`demo-limb-fill ${scoreClass(pct)}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="demo-limb-value">{v == null ? "—" : pct}</span>
                </div>
              );
            })}
          </div>

          <div className="demo-controls">
            <button
              className={`demo-btn ${isSim ? "primary" : ""}`}
              onClick={useSimulated}
              disabled={isSim}
            >
              Simulated run
            </button>
            <button
              className={`demo-btn ${!isSim ? "primary" : ""}`}
              onClick={startWebcam}
              disabled={camState === "loading" || camState === "live"}
            >
              {camState === "live" ? "Camera on" : "Use my camera"}
            </button>
            <button className="demo-btn" onClick={() => setRunning((r) => !r)}>
              {running ? "Pause" : "Resume"}
            </button>
            <button
              className={`demo-btn ${voiceOn ? "primary" : ""}`}
              onClick={onToggleVoice}
            >
              Voice coach {voiceOn ? "on" : "off"}
            </button>
          </div>

          {camError && <p className="demo-error">{camError}</p>}
        </aside>
      </div>

      <footer className="demo-footer">
        <div>
          <h3>How it works</h3>
          <p>
            Pose landmarks come from MediaPipe's Pose Landmarker running as
            WebAssembly in your browser — no frames are uploaded anywhere. Each
            sampled frame is matched to the reference frame at the same point in
            the rep, then scored limb-by-limb as the cosine similarity between
            corresponding limb vectors, weighted toward the muscles the exercise
            targets. The weakest limb drives the coaching message, which the
            voice coach speaks through the Web Speech API.
          </p>
        </div>
        <div>
          <h3>Not in this demo</h3>
          <p>
            The full app adds a FastAPI backend: exercise search against the
            YMove API, YOLOv8-pose reference extraction on Modal GPU workers,
            GPT-4o-mini for contextual coaching cues, ElevenLabs voices,
            Supermemory-backed form guides, and PT referral reports. Those need
            API keys and a server, so they're left out of the free hosted demo —{" "}
            <a href="https://github.com/jkcol/AlignAI#readme" target="_blank" rel="noreferrer">
              the README
            </a>{" "}
            covers running the whole stack locally.
          </p>
        </div>
      </footer>
    </div>
  );
}

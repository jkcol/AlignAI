# AlignAI

**An AI form coach for physical therapy and workouts.** AlignAI compares your live webcam
pose against a reference exercise video in real time, scores how closely your form matches,
and coaches you with generated voice feedback when you drift — so someone rehabbing an
injury or learning an exercise at home gets correction without a trainer in the room.

Built at **HackIllinois** by a team of four. *(Previously named FormAI.)*

## Live demo

**▶ [jkcol.github.io/AlignAI](https://jkcol.github.io/AlignAI/)** — no install, no sign-up, no API keys.

The demo runs the real pose-comparison engine entirely in your browser. Allow camera access
to score your own squat against the reference, or leave it off and watch the simulated
trainee — the scoring, per-limb breakdown, coaching messages, and rep counting are identical
either way, because they all run through the same [`comparePose`](frontend/src/comparePose.ts)
code the full app uses.

To keep it free to host and safe to leave open to the public, the demo has no backend: the
reference figure (and the simulated trainee) are generated procedurally in
[`poseSynth.ts`](frontend/src/demo/poseSynth.ts) rather than extracted from video, so there
are no server costs, no API keys to leak, and nothing to rate-limit. Everything that needs
the FastAPI service — exercise search, YOLOv8 reference extraction, GPT-4o-mini coaching,
ElevenLabs voices, PT reports — is left out of the demo and covered under
[Quick start](#quick-start) below.

Run it locally with `npm run dev:demo` in `frontend/`.

## How it works

Pose estimation runs **in the browser**: a MediaPipe Pose Landmarker (33 keypoints) executes
via **WebAssembly** against the webcam feed, so per-frame tracking sustains ~30 FPS with no
network round-trip. Reference videos are processed server-side — a **FastAPI** service
orchestrates **YOLOv8-pose** on **Modal** GPU workers to extract keypoints from the demo
clip, then the two keypoint streams are compared to produce a form score.

Coaching sits on top: **GPT-4o-mini** turns pose deltas into corrections, **ElevenLabs**
speaks them, and **Supermemory** (RAG) retains exercise form guides and your history so
feedback improves across sessions. Progress is charted with Recharts.

## Stack

**Frontend:** React, Vite, JavaScript/TypeScript, WebAssembly, MediaPipe Tasks Vision, WebRTC (`getUserMedia`), Recharts
**Backend:** Python, FastAPI, Server-Sent Events (SSE), Pydantic, httpx, OpenCV
**ML / CV:** MediaPipe Pose Landmarker, YOLOv8-pose (Ultralytics), pose comparison and scoring
**Cloud:** Modal (serverless GPU, Volumes, web endpoints)
**AI services:** OpenAI GPT-4o-mini, ElevenLabs (TTS), Perplexity Sonar, xAI Grok (video), Supermemory (RAG)
**Testing:** Vitest (unit), Playwright (end-to-end)

See [`DEVPOST.md`](./DEVPOST.md) for the full hackathon writeup.

## Quick start

From the project root:

```bash
# Backend (Terminal 1)
./run-backend.sh

# Frontend (Terminal 2)
./run-frontend.sh
```

Then open **http://localhost:8000** in your browser. Run `npm install` in `frontend/` the first time.

---

## Manual setup

### Backend

```bash
cd .
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python pose_server.py
```

Runs at `http://localhost:8001`. Copy `.env.example` to `.env` and add your API keys. For the Exercise tab, set `YMOVE_API_KEY` (get a key at [ymove.app/exercise-api/signup](https://ymove.app/exercise-api/signup)).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs at `http://localhost:8000`.

When you open the app, allow webcam access. You should see your live camera feed and an annotated video where the pose skeleton is overlaid, powered entirely in-browser by a WebAssembly MediaPipe Pose model (no Python backend needed).

## Tabs

- **Exercise Workout**: Search exercises from the [YMove Exercise API](https://ymove.app/exercise-api/docs). Select an exercise to load its demo video instantly (no YouTube download), then compare your form with your webcam. Requires `YMOVE_API_KEY` (get one at [ymove.app/exercise-api/signup](https://ymove.app/exercise-api/signup)).
- **AI Generated Video**: Enter a text description of a workout/exercise; the app runs a pipeline on [Modal.com](https://modal.com) and displays the result in the same left-panel layout with play/pause, seek, volume, and speed controls.

### AI video pipeline (Modal.com)

The pipeline runs on Modal: **Perplexity** (research + prompt writing) → **Grok** (xAI video gen).

1. Install Modal and authenticate: `pip install modal` then `modal setup`.
2. Create a Modal secret with your API keys (Modal dashboard → Secrets, or CLI):
   - Secret name: `formai-video-keys`
   - Keys: `PERPLEXITY_API_KEY`, `XAI_API_KEY`
3. Deploy: `modal deploy modal_video_app`
4. Set `MODAL_VIDEO_DOWNLOAD_BASE` and `MODAL_VIDEO_GENERATE_ENDPOINT` to your deployed web endpoint URL (e.g. `https://your-workspace--formai-video-generate.modal.run`) and run the backend.

Without `MODAL_VIDEO_DOWNLOAD_BASE` and `MODAL_VIDEO_GENERATE_ENDPOINT` or the API keys, the AI tab will show an error when you click Generate; the Exercise tab and pose demo still work if `YMOVE_API_KEY` is set.

### Preprocess on Modal (recommended)

Reference video pose extraction (YouTube, API, AI-generated) runs faster on Modal with GPU (YOLOv8). Compare runs locally on the backend—it's lightweight and doesn't need Modal.

**Compare app** (preprocess, compare-full):
1. `modal deploy compare.modal_compare_app`
2. In `.env`, set:
   - `MODAL_PREPROCESS_ENDPOINT` – e.g. `https://your-workspace--formai-compare-preprocess.modal.run` (required for AI-generated video tab; speeds up Exercise tab)
   - `MODAL_COMPARE_FULL_ENDPOINT` – e.g. `https://your-workspace--formai-compare-compare-full.modal.run` (optional; for test_compare --full)
3. No secrets needed. Both endpoints use a GPU (T4) for fast YOLOv8 pose detection.

Without `MODAL_PREPROCESS_ENDPOINT`, the AI-generated video tab will fail (503) when extracting poses; the Exercise tab falls back to slower local/browser preprocessing.

### Voice coaching (Modal + ElevenLabs, optional)

Voice coach uses **Modal + Eleven Labs** for a coach-like voice when the Modal app is deployed.

1. **Deploy the Modal app** (includes TTS): `modal deploy modal_video_app`
2. **Add `ELEVENLABS_API_KEY` to the Modal secret** `formai-video-keys` (same secret as Perplexity/xAI). In Modal dashboard: Secrets → formai-video-keys → add `ELEVENLABS_API_KEY` with your [ElevenLabs](https://elevenlabs.io) API key.
3. **Set `MODAL_VIDEO_GENERATE_ENDPOINT`** in `.env` to your Modal app URL (e.g. `https://your-workspace--formai-video-fastapi-app.modal.run`).

The backend proxies TTS at `POST /api/tts` to Modal’s `/tts` endpoint, which uses Eleven Labs with a **coach-style voice** (Adam by default). Optional: set `ELEVENLABS_VOICE_ID` in the Modal secret to override the voice.

If Modal is not configured, you can still use direct ElevenLabs by setting `ELEVENLABS_API_KEY` (and optionally `ELEVENLABS_VOICE_ID`) in `.env`; the backend will call ElevenLabs directly. The Voice coach label shows "· ElevenLabs" when enabled.

### AI coaching (optional)

For smarter, contextual coaching feedback, set `OPENAI_API_KEY`. When enabled, the app will call GPT-4o-mini to generate short, actionable form tips (e.g. "Bring your elbow closer to your body") instead of generic "Adjust your arm" messages. Voice coach uses the LLM output exclusively (no voice when the LLM call fails).

### PT Report Email (optional)

To send PT referral reports by email, add `RESEND_API_KEY` to `.env` (get one at [resend.com](https://resend.com)). Optionally set `RESEND_FROM_EMAIL` to a verified domain (default: `AlignAI <onboarding@resend.dev>`).

### Supermemory (optional – RAG for form guides)

[Supermemory](https://supermemory.ai/) powers retrieval-augmented coaching: the LLM gets relevant form cues from an exercise knowledge base before generating tips.

1. **Set `SUPERMEMORY_API_KEY`** in `.env` (get one at [console.supermemory.ai](https://console.supermemory.ai/start)).
2. **Seed the knowledge base** with exercise guides:
   ```bash
   python seed_supermemory_exercises.py
   ```
   This adds form cues and ExRx.net URLs to the `formai_exercises` container. Indexing takes 10–30 seconds.
3. When an exercise is selected, its name and video URL are added to Supermemory for better RAG context.
4. When a workout ends, the AI summary and key feedback are saved to your **user context** so the coach develops a memory of your progress, recurring issues, and patterns over time.

The Voice coach label shows "(with form guides)" when Supermemory is configured. The coach uses both generic form cues and your past workout history to personalize feedback.

### Pose compare (local)

The compare model runs locally on the backend (DTW alignment, joint angles, exercise-specific weights).

- **POST `/api/pose/compare`** with `reference` and `user` pose sequences → returns `{ score, per_frame, ... }`
- **POST `/api/pose/compare-full`** with `youtube_url` + `user`, or `reference` + `user` → same result

Uses MediaPipe-style 33-landmark format; preprocess outputs `{ "frames": [{ "landmarks": [[x,y,z],...] }] }`.

### Workout history & rep counting

- **Workout history**: Completed workout summaries are saved to `localStorage` and shown in a collapsible "Workout history" section. Use "Clear history" to remove them.
- **Rep counting**: During an active workout, reps are counted automatically by detecting when your form dips (score &lt; 65%) and returns to reference (score &gt; 82%). Reps appear next to the match score and in the workout summary.

### Production

- **CORS**: Set `CORS_ORIGINS` in `.env` (comma-separated URLs) to restrict allowed origins. Default is `*` for development.
- **Rate limiting**: Expensive endpoints (TTS, LLM coaching, workout summary) are limited to 30 requests per minute per IP.

### AI Coach (chatbot)

A floating circular button (bottom-right) opens the **FormAI Coach** — a chatbot that knows your workout history via Supermemory. Features:

- **Chat**: Ask questions about your workouts, form, or progress. Uses your saved session data for personalized answers.
- **Progress**: Charts showing form score and reps over time. Trend analysis (improving/declining).
- **PT Report**: When progress declines or form scores drop, generate a formal report to share with a physical therapist. Includes workout history, trends, and areas of concern. Copy to clipboard to share.

Requires `OPENAI_API_KEY`. Progress data is stored in `data/progress.json` (created on first workout).

### Tests

- **Unit tests**: `cd frontend && npm run test`
- **E2E tests**: `cd frontend && npm run test:e2e` (requires Playwright; starts dev server automatically)

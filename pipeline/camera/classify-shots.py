#!/usr/bin/env python3
"""
Classify each detected shot's framing, then author camera-track.json.

For each shot we sample up to 3 frames (25/50/75% into the shot), run MediaPipe
pose to find the performer's bounding box, and derive framing:

  bbox height fraction of frame:
    > 0.75 or partial-body (top/bottom clipped)  -> close
    0.4 .. 0.75                                   -> medium
    < 0.4                                         -> wide
  feet-only (bbox sits in lower part of frame, top below mid) -> close-feet
  face-dominant (bbox top high, short bbox, upper frame)      -> close-face
  side vs center by bbox x-centre
  no person detected                              -> establishing (wide)

The averaged per-shot signals pick one final type, mapped to a plausible
concert-hall camera placement (stage centre at origin, performer at origin,
+Z toward stage front, metres).
"""
import json
import math
from pathlib import Path

import cv2
import mediapipe as mp

ROOT = Path(__file__).resolve().parents[2]
VIDEO = next((ROOT / "Assets/Koncerty/1").glob("Video*/*.mp4"))
CUTS = Path(__file__).resolve().parent / "cuts.json"
OUT = ROOT / "public/concerts/motown25-billiejean/camera-track.json"
DURATION = 296.8  # audio master length (§2)

mp_pose = mp.solutions.pose


def sample_frames(cap, fps, start, end):
    """Yield up to 3 frames at 25/50/75% through the shot."""
    frames = []
    span = max(end - start, 0.05)
    for frac in (0.25, 0.5, 0.75):
        t = start + span * frac
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if ok and frame is not None:
            frames.append(frame)
    return frames


def analyse_bbox(frame, pose):
    """Return (h_frac, cx, top, bottom) of person bbox in [0,1], or None."""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    res = pose.process(rgb)
    if not res.pose_landmarks:
        return None
    xs, ys, vis = [], [], []
    for lm in res.pose_landmarks.landmark:
        if lm.visibility > 0.3:
            xs.append(lm.x)
            ys.append(lm.y)
            vis.append(lm.visibility)
    if len(xs) < 4:
        return None
    top, bottom = min(ys), max(ys)
    cx = sum(xs) / len(xs)
    h_frac = bottom - top
    # which landmarks are present -> feet vs face detection
    lms = res.pose_landmarks.landmark
    ankle_vis = max(lms[27].visibility, lms[28].visibility)
    knee_vis = max(lms[25].visibility, lms[26].visibility)
    shoulder_vis = max(lms[11].visibility, lms[12].visibility)
    face_vis = max(lms[0].visibility, lms[7].visibility, lms[8].visibility)
    return dict(h_frac=h_frac, cx=cx, top=top, bottom=bottom,
                ankle_vis=ankle_vis, knee_vis=knee_vis,
                shoulder_vis=shoulder_vis, face_vis=face_vis)


def classify_shot(signals):
    """Fuse per-frame signals into one framing type."""
    if not signals:
        return "establishing"
    n = len(signals)
    h = sum(s["h_frac"] for s in signals) / n
    cx = sum(s["cx"] for s in signals) / n
    top = sum(s["top"] for s in signals) / n
    bottom = sum(s["bottom"] for s in signals) / n
    ankle = sum(s["ankle_vis"] for s in signals) / n
    knee = sum(s["knee_vis"] for s in signals) / n
    shoulder = sum(s["shoulder_vis"] for s in signals) / n
    face = sum(s["face_vis"] for s in signals) / n

    partial = top < 0.02 or bottom > 0.98  # clipped by frame edge

    # feet-only: legs visible (ankles/knees) but upper body out of frame
    # (shoulders + face weak) -> a low camera framing the footwork.
    if ankle > 0.4 and knee > 0.4 and shoulder < 0.4 and face < 0.4:
        return "close-feet"
    if top > 0.5 and ankle > 0.5 and face < 0.4:
        return "close-feet"
    # face-dominant: high in frame, short bbox, face strong, no ankles
    if face > 0.6 and ankle < 0.3 and h < 0.55 and bottom < 0.75:
        return "close-face"

    if h > 0.75 or partial:
        base = "close"
    elif h >= 0.4:
        base = "medium"
    else:
        return "wide"

    # side framing when subject sits well off-centre
    if abs(cx - 0.5) > 0.28:
        return "side"
    return "close-face" if base == "close" else "medium"


# Camera placements (metres). Base + small per-shot jitter so consecutive
# same-type shots differ like a real multi-cam broadcast.
BASE = {
    "wide":         dict(pos=[0, 4, 22],   fov=40, look="stage"),
    "establishing": dict(pos=[0, 5, 24],   fov=42, look="stage"),
    "medium":       dict(pos=[2, 1.8, 8],  fov=35, look="performer"),
    "close-face":   dict(pos=[0.5, 1.7, 3.5], fov=30, look="performer"),
    "close-feet":   dict(pos=[0.8, 0.4, 3.5], fov=30, look="performer"),
    "side":         dict(pos=[7, 1.8, 6],  fov=34, look="performer"),
}


def jitter(base, i):
    """Deterministic small offset varying shot-to-shot."""
    a = i * 1.37
    dx = math.sin(a) * (1.6 if base[0] != 0 or True else 1.0)
    dz = math.cos(a * 0.7) * 1.8
    dy = math.sin(a * 1.9) * 0.25
    # mirror side cameras left/right alternately
    return [round(base[0] + dx, 2),
            round(max(0.15, base[1] + dy), 2),
            round(base[2] + dz, 2)]


def main():
    cuts = json.loads(CUTS.read_text())
    cap = cv2.VideoCapture(str(VIDEO))
    fps = cap.get(cv2.CAP_PROP_FPS)

    shots = []
    hist = {}
    low_conf = []
    side_flip = 1
    with mp_pose.Pose(static_image_mode=True, model_complexity=1,
                      min_detection_confidence=0.4) as pose:
        for c in cuts:
            frames = sample_frames(cap, fps, c["start"], c["end"])
            sig = [b for b in (analyse_bbox(f, pose) for f in frames) if b]
            ftype = classify_shot(sig)
            if not sig:
                low_conf.append((c["index"], c["start"], "no-pose"))
            elif len(sig) < 2:
                low_conf.append((c["index"], c["start"], "single-frame"))

            b = BASE[ftype]
            pos = jitter(b["pos"], c["index"])
            if ftype == "side":
                side_flip *= -1
                pos[0] = round(abs(pos[0]) * side_flip, 2)
            shot = {
                "t": round(c["start"], 3) if c["index"] else 0.0,
                "type": ftype,
                "posHint": pos,
                "lookAt": "performer" if b["look"] == "performer" else "stage",
                "fov": b["fov"],
            }
            if ftype == "close-feet":
                shot["lookHeight"] = 0.2  # aim at feet, not torso
            shots.append(shot)
            hist[ftype] = hist.get(ftype, 0) + 1
    cap.release()

    track = {
        "concert": "motown25-billiejean",
        "duration": DURATION,
        "coordinateSystem": {
            "origin": "stage center / performer",
            "up": "+Y", "stageFront": "+Z", "units": "meters",
        },
        "shots": shots,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(track, indent=2))

    # ---- validation ----
    print(f"\nShots: {len(shots)}  Duration: {DURATION}")
    print("Histogram:", hist)
    assert shots[0]["t"] == 0.0, "first shot must start at t=0"
    gaps = []
    for i in range(len(shots) - 1):
        if shots[i + 1]["t"] <= shots[i]["t"]:
            gaps.append((i, "non-monotonic"))
    print("Gap/overlap issues:", gaps or "none")
    print("Low-confidence shots:", low_conf or "none")
    print(f"\n{'t':>8} {'type':<13} {'posHint':<22} fov")
    for s in shots:
        print(f"{s['t']:>8.2f} {s['type']:<13} {str(s['posHint']):<22} {s['fov']}")
    print(f"\nWrote -> {OUT}")


if __name__ == "__main__":
    main()

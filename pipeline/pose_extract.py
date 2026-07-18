#!/usr/bin/env python3
"""Step 1: Run MediaPipe Pose (heavy) over the Billie Jean video at 30fps in VIDEO mode.
Stores per-frame world landmarks, normalized landmarks, visibility, detection confidence.
Output: pipeline/work/pose-raw.npz
"""
import os, sys, time, glob
import numpy as np
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
VIDEO = glob.glob(os.path.join(ROOT, "Assets", "Koncerty", "1", "Video*", "*.mp4"))[0]
TASK = os.path.join(WORK, "pose_landmarker_heavy.task")
OUT = os.path.join(WORK, "pose-raw.npz")

SAMPLE_FPS = 30.0

def main():
    print("VIDEO:", VIDEO)
    cap = cv2.VideoCapture(VIDEO)
    src_fps = cap.get(cv2.CAP_PROP_FPS)
    n_src = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = n_src / src_fps
    print(f"src_fps={src_fps:.3f} n_src={n_src} dur={dur:.3f}s")

    n_out = int(np.floor(dur * SAMPLE_FPS))
    print(f"sampling {n_out} frames @ {SAMPLE_FPS}fps")

    opts = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=TASK),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
        min_tracking_confidence=0.3,
        output_segmentation_masks=False,
    )
    landmarker = vision.PoseLandmarker.create_from_options(opts)

    NLM = 33
    world = np.zeros((n_out, NLM, 3), np.float32)
    norm = np.zeros((n_out, NLM, 3), np.float32)
    vis = np.zeros((n_out, NLM), np.float32)
    pres = np.zeros((n_out, NLM), np.float32)
    conf = np.zeros((n_out,), np.float32)   # detection confidence (mean presence) 0 if no detection
    times = np.zeros((n_out,), np.float32)

    t0 = time.time()
    for i in range(n_out):
        t = i / SAMPLE_FPS
        times[i] = t
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            conf[i] = 0.0
            continue
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        ts_ms = int(round(t * 1000.0))
        res = landmarker.detect_for_video(mp_img, ts_ms)
        if res.pose_world_landmarks and len(res.pose_world_landmarks) > 0:
            wl = res.pose_world_landmarks[0]
            nl = res.pose_landmarks[0]
            for k in range(NLM):
                world[i, k] = (wl[k].x, wl[k].y, wl[k].z)
                norm[i, k] = (nl[k].x, nl[k].y, nl[k].z)
                vis[i, k] = nl[k].visibility
                pres[i, k] = nl[k].presence
            # confidence: mean visibility of core torso+limb landmarks
            core = [0,11,12,13,14,15,16,23,24,25,26,27,28]
            conf[i] = float(np.mean([nl[k].visibility for k in core]))
        else:
            conf[i] = 0.0
        if i % 300 == 0:
            el = time.time() - t0
            rate = (i+1)/el if el > 0 else 0
            eta = (n_out - i) / rate if rate > 0 else 0
            print(f"  frame {i}/{n_out}  t={t:6.1f}s  conf={conf[i]:.2f}  {rate:.1f}fps ETA {eta/60:.1f}min", flush=True)

    cap.release()
    np.savez_compressed(OUT, world=world, norm=norm, vis=vis, pres=pres,
                        conf=conf, times=times, sample_fps=SAMPLE_FPS, duration=dur)
    det = float(np.mean(conf > 0.3))
    print(f"DONE {n_out} frames in {(time.time()-t0)/60:.1f}min. detected(conf>0.3)={det*100:.1f}%")
    print("saved", OUT)

if __name__ == "__main__":
    main()

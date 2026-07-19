#!/usr/bin/env python3
"""Step 1 (v8): MediaPipe Pose (heavy) over the 4K time-aligned source.
Decodes via an ffmpeg pipe (AV1, sequential — no per-frame seeking), downscaled
to 1440px height, resampled to 30 fps, trimmed by +0.0222 s so that output
t=0 == audio t=0 (the 4K file leads the audio master by 0.0222 s).
Output: pipeline/work/pose-raw-4k.npz  (pose-raw.npz stays untouched)
"""
import os, subprocess, time
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
VIDEO = os.path.join(ROOT, "Assets", "Koncerty", "1", "Video-alt", "billie-jean-motown25-4K.mp4")
TASK = os.path.join(WORK, "pose_landmarker_heavy.task")
OUT = os.path.join(WORK, "pose-raw-4k.npz")

SAMPLE_FPS = 30.0
OFFSET = 0.0222           # video leads audio; trim this much off the head
H = 1440                  # decode height (MediaPipe resizes internally anyway)
W = 2560                  # 16:9 at 1440
SRC_DUR = 296.863233
DUR = SRC_DUR - OFFSET

def main():
    n_out = int(np.floor(DUR * SAMPLE_FPS))
    print(f"4K source, trim {OFFSET}s, sampling {n_out} frames @ {SAMPLE_FPS} fps at {W}x{H}")

    cmd = ["ffmpeg", "-v", "error", "-ss", f"{OFFSET}", "-i", VIDEO,
           "-vf", f"fps={SAMPLE_FPS},scale={W}:{H}",
           "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=W*H*3*4)

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
    conf = np.zeros((n_out,), np.float32)
    times = np.zeros((n_out,), np.float32)

    frame_bytes = W*H*3
    t0 = time.time()
    for i in range(n_out):
        buf = proc.stdout.read(frame_bytes)
        if buf is None or len(buf) < frame_bytes:
            print(f"stream ended early at frame {i}")
            break
        t = i / SAMPLE_FPS
        times[i] = t
        rgb = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = landmarker.detect_for_video(mp_img, int(round(t*1000.0)))
        if res.pose_world_landmarks and len(res.pose_world_landmarks) > 0:
            wl = res.pose_world_landmarks[0]
            nl = res.pose_landmarks[0]
            for k in range(NLM):
                world[i, k] = (wl[k].x, wl[k].y, wl[k].z)
                norm[i, k] = (nl[k].x, nl[k].y, nl[k].z)
                vis[i, k] = nl[k].visibility
                pres[i, k] = nl[k].presence
            core = [0,11,12,13,14,15,16,23,24,25,26,27,28]
            conf[i] = float(np.mean([nl[k].visibility for k in core]))
        if i % 600 == 0:
            el = time.time() - t0
            rate = (i+1)/el if el > 0 else 0
            eta = (n_out - i) / rate if rate > 0 else 0
            print(f"  frame {i}/{n_out} t={t:6.1f}s conf={conf[i]:.2f} {rate:.1f}fps ETA {eta/60:.1f}min", flush=True)

    proc.stdout.close(); proc.wait()
    np.savez_compressed(OUT, world=world, norm=norm, vis=vis, pres=pres,
                        conf=conf, times=times, sample_fps=SAMPLE_FPS, duration=DUR)
    det = float(np.mean(conf > 0.5))
    print(f"DONE {n_out} frames in {(time.time()-t0)/60:.1f}min. detected(conf>0.5)={det*100:.1f}%")
    print("saved", OUT)

if __name__ == "__main__":
    main()

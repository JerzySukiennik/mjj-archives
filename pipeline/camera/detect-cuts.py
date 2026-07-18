#!/usr/bin/env python3
"""
Detect TV-broadcast camera cuts in the Motown 25 Billie Jean video.

Uses PySceneDetect. The broadcast mixes hard cuts and the occasional dissolve,
so we run AdaptiveDetector (robust to fast motion / motion blur, catches
gradual transitions better than a fixed threshold) and fall back-compare with
ContentDetector.

Output: pipeline/camera/cuts.json  ->  [{"index", "start", "end"} ...]
"""
import json
import sys
from pathlib import Path

from scenedetect import open_video, SceneManager
from scenedetect.detectors import AdaptiveDetector, ContentDetector

ROOT = Path(__file__).resolve().parents[2]
VIDEO = next((ROOT / "Assets/Koncerty/1").glob("Video*/*.mp4"))
OUT = Path(__file__).resolve().parent / "cuts.json"


def detect(detector):
    video = open_video(str(VIDEO))
    sm = SceneManager()
    sm.add_detector(detector)
    sm.detect_scenes(video, show_progress=False)
    scenes = sm.get_scene_list()
    return [(s.get_seconds(), e.get_seconds()) for s, e in scenes]


def main():
    # AdaptiveDetector: adaptive_threshold tuned down a touch to catch quick
    # cuts during fast footwork; min_scene_len avoids double-triggering on
    # single hard cuts amid motion blur.
    adaptive = detect(
        AdaptiveDetector(adaptive_threshold=3.0, min_scene_len=15)
    )
    content = detect(ContentDetector(threshold=27.0, min_scene_len=15))

    print(f"AdaptiveDetector: {len(adaptive)} scenes", file=sys.stderr)
    print(f"ContentDetector : {len(content)} scenes", file=sys.stderr)

    # Prefer AdaptiveDetector (better on this footage); keep content as sanity.
    scenes = adaptive
    result = [
        {"index": i, "start": round(s, 3), "end": round(e, 3)}
        for i, (s, e) in enumerate(scenes)
    ]
    OUT.write_text(json.dumps(result, indent=2))
    print(f"Wrote {len(result)} shots -> {OUT}", file=sys.stderr)
    for r in result:
        print(f"  {r['index']:2d}  {r['start']:8.3f} -> {r['end']:8.3f}"
              f"  ({r['end']-r['start']:6.2f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Step 2-4: Retarget MediaPipe world landmarks onto the Mixamo skeleton, clean, bake.
Inputs : pipeline/work/pose-raw.npz, pipeline/work/skeleton.json
Outputs: public/concerts/motown25-billiejean/billiejean.motion.json
         pipeline/work/unusable-spans.json
         pipeline/work/retarget-cache.npz (quats+pos+conf for validation/markers)
"""
import os, json
import numpy as np
from scipy.signal import savgol_filter
import qutil as Q

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
OUTDIR = os.path.join(ROOT, "public", "concerts", "motown25-billiejean")
POSE = os.path.join(WORK, "pose-raw.npz")
SKEL = os.path.join(WORK, "skeleton.json")

# MediaPipe landmark indices
NOSE=0; L_SH=11; R_SH=12; L_EL=13; R_EL=14; L_WR=15; R_WR=16
L_IDX=19; R_IDX=20; L_HIP=23; R_HIP=24; L_KN=25; R_KN=26
L_AN=27; R_AN=28; L_FT=31; R_FT=32

def C(v):
    """MediaPipe world/normalized -> model space (Y-up, meters). proper rotation (x,y flip)."""
    return np.array([-v[...,0], -v[...,1], v[...,2]]).T if v.ndim>1 else np.array([-v[0],-v[1],v[2]])

# Bone -> (start_lm, end_lm, child_bone_for_rest_dir). Hips handled separately.
LIMB_MAP = {
    "mixamorig:LeftShoulder": (None, L_SH, "mixamorig:LeftArm"),   # dir shouldersMid->L_SH (special start)
    "mixamorig:LeftArm":      (L_SH, L_EL, "mixamorig:LeftForeArm"),
    "mixamorig:LeftForeArm":  (L_EL, L_WR, "mixamorig:LeftHand"),
    "mixamorig:LeftHand":     (L_WR, L_IDX, "mixamorig:LeftHandMiddle1"),
    "mixamorig:RightShoulder":(None, R_SH, "mixamorig:RightArm"),
    "mixamorig:RightArm":     (R_SH, R_EL, "mixamorig:RightForeArm"),
    "mixamorig:RightForeArm": (R_EL, R_WR, "mixamorig:RightHand"),
    "mixamorig:RightHand":    (R_WR, R_IDX, "mixamorig:RightHandMiddle1"),
    "mixamorig:LeftUpLeg":    (L_HIP, L_KN, "mixamorig:LeftLeg"),
    "mixamorig:LeftLeg":      (L_KN, L_AN, "mixamorig:LeftFoot"),
    "mixamorig:LeftFoot":     (L_AN, L_FT, "mixamorig:LeftToeBase"),
    "mixamorig:RightUpLeg":   (R_HIP, R_KN, "mixamorig:RightLeg"),
    "mixamorig:RightLeg":     (R_KN, R_AN, "mixamorig:RightFoot"),
    "mixamorig:RightFoot":    (R_AN, R_FT, "mixamorig:RightToeBase"),
    "mixamorig:Spine":        (None, None, None),   # torso up special
    "mixamorig:Neck":         (None, None, None),   # head up special
}
# Bones we output rotations for (mapped + a few bind-follow spine bones for hierarchy)
OUTPUT_BONES = list(LIMB_MAP.keys())

def main():
    d = np.load(POSE)
    world = d["world"]; norm = d["norm"]; conf = d["conf"]; times = d["times"]
    fps = float(d["sample_fps"]); dur = float(d["duration"])
    F = world.shape[0]
    skel = json.load(open(SKEL))
    nodes = skel["nodes"]
    restPos = {b: np.array(nodes[b]["restWorldPos"]) for b in nodes}
    restQuat = {b: np.array(nodes[b]["restWorldQuat"]) for b in nodes}
    localBind = {b: np.array(nodes[b]["localRotation"]) for b in nodes}
    parentName = {b: nodes[b]["parent"] for b in nodes}
    hipsParentQ = np.array(skel["hipsParentWorldQuat"])

    GOOD = conf > 0.5

    # ---- temporal outlier rejection ----
    # Reject "good" frames whose core world landmarks jump implausibly vs the last
    # accepted frame (wide/crowd shots where MediaPipe grabs a wrong or mangled body).
    CORE = [0,11,12,23,24,25,26,27,28]
    last = None
    n_rej = 0
    for i in range(F):
        if not GOOD[i]:
            continue
        if last is not None:
            dt = (i - last) / fps
            d = float(np.mean(np.linalg.norm(world[i][CORE] - world[last][CORE], axis=1)))
            # allow ~3 m/s mean landmark speed, floor of 0.45 m for cut jumps
            if d > max(0.45, 3.0 * dt):
                GOOD[i] = False
                n_rej += 1
                continue
        last = i
    # second pass: kill short good islands (< 8 frames ~ 0.27s) — usually spurious
    # detections inside wide/crowd shots that would poison gap blending.
    i = 0
    while i < F:
        if GOOD[i]:
            j = i
            while j < F and GOOD[j]: j += 1
            if (j - i) < 8:
                GOOD[i:j] = False
            i = j
        else:
            i += 1
    print(f"outlier rejection: removed {n_rej} jump frames; good now {GOOD.mean()*100:.1f}%")

    # ---- per-frame retarget ----
    quats = {b: np.zeros((F,4), np.float32) for b in OUTPUT_BONES}
    hips_pos = np.zeros((F,3), np.float32)
    hips_quat = np.zeros((F,4), np.float32)

    # rest torso reference
    r_hipR = restPos["mixamorig:RightUpLeg"]; r_hipL = restPos["mixamorig:LeftUpLeg"]
    rest_right = r_hipR - r_hipL
    rest_shMid = 0.5*(restPos["mixamorig:LeftArm"]+restPos["mixamorig:RightArm"])
    rest_hipMid = 0.5*(r_hipR+r_hipL)
    rest_up = rest_shMid - rest_hipMid

    restY = restPos["mixamorig:Hips"][1]

    for i in range(F):
        if not GOOD[i]:
            continue
        P = C(world[i])            # (33,3) model space, hip-centered
        shMid = 0.5*(P[L_SH]+P[R_SH]); hipMid = 0.5*(P[L_HIP]+P[R_HIP])
        # hips global via frame align
        meas_right = P[R_HIP]-P[L_HIP]
        meas_up = shMid - hipMid
        Ralign = Q.frame_align(rest_right, rest_up, meas_right, meas_up)
        Ghip = Q.qmul(Ralign, restQuat["mixamorig:Hips"])
        hips_quat[i] = Q.qmul(Q.qconj(hipsParentQ), Ghip)   # local = inv(parentRest)*Ghip

        Gmeas = {"mixamorig:Hips": Ghip}

        def measured_dir(bone):
            s,e,ch = LIMB_MAP[bone]
            if bone == "mixamorig:Spine":
                return shMid - hipMid
            if bone == "mixamorig:Neck":
                return P[NOSE] - shMid
            if s is None:  # shoulder clavicle: shouldersMid -> joint
                return P[e] - shMid
            return P[e]-P[s]

        def rest_dir(bone):
            s,e,ch = LIMB_MAP[bone]
            if bone == "mixamorig:Spine":
                return restPos["mixamorig:Neck"]-restPos["mixamorig:Spine"]
            if bone == "mixamorig:Neck":
                return restPos["mixamorig:Head"]-restPos["mixamorig:Neck"]
            return restPos[ch]-restPos[bone]

        for bone in OUTPUT_BONES:
            dM = measured_dir(bone); dR = rest_dir(bone)
            if np.linalg.norm(dM) < 1e-5:
                quats[bone][i] = localBind[bone]; continue
            swing = Q.from_to(dR, dM)
            Gb = Q.qmul(swing, restQuat[bone])
            Gmeas[bone] = Gb
            pn = parentName[bone]
            Gp = Gmeas.get(pn, restQuat.get(pn, np.array([0,0,0,1.0])))
            local = Q.qmul(Q.qconj(Gp), Gb)
            quats[bone][i] = Q.qnorm(local)

        # hips translation: vertical bob from leg compression + lateral from normalized hip x
        ankMidY = 0.5*(P[L_AN][1]+P[R_AN][1])      # negative (below hips)
        legSpan = hipMid[1]-ankMidY
        hips_pos[i,1] = restY   # base; adjust after (needs ref) -> store legSpan in z temp
        hips_pos[i,0] = legSpan   # temp store
        # lateral from normalized landmark hip center x (image 0..1)
        nx = 0.5*(norm[i,L_HIP,0]+norm[i,R_HIP,0])
        hips_pos[i,2] = nx        # temp store

    # ---- fill gaps by slerp between good neighbors ----
    good_idx = np.where(GOOD)[0]
    if len(good_idx)==0:
        raise SystemExit("No good frames detected!")
    def nearest_good(i):
        # returns (prev, next) good indices
        pos = np.searchsorted(good_idx, i)
        nxt = good_idx[pos] if pos < len(good_idx) else good_idx[-1]
        prv = good_idx[pos-1] if pos > 0 else good_idx[0]
        return prv, nxt

    for i in range(F):
        if GOOD[i]: continue
        prv, nxt = nearest_good(i)
        if prv==nxt:
            t=0.0
        else:
            gap = nxt - prv
            if gap <= int(0.5*fps):
                t=(i-prv)/gap            # short gap: straight interpolation
            else:
                # long gap: hold last good pose, blend to next only in final 0.5s
                blend = int(0.5*fps)
                k = i - (nxt - blend)
                t = 0.0 if k < 0 else k/blend
                t = t*t*(3-2*t)          # smoothstep
        for bone in OUTPUT_BONES:
            quats[bone][i] = Q.slerp(quats[bone][prv], quats[bone][nxt], t)
        hips_quat[i] = Q.slerp(hips_quat[prv], hips_quat[nxt], t)
        hips_pos[i,0] = hips_pos[prv,0]*(1-t)+hips_pos[nxt,0]*t
        hips_pos[i,2] = hips_pos[prv,2]*(1-t)+hips_pos[nxt,2]*t

    # ---- resolve translation from temp stores ----
    legSpanArr = hips_pos[:,0].copy()
    nxArr = hips_pos[:,2].copy()
    legRef = np.median(legSpanArr[GOOD]) if GOOD.any() else legSpanArr.mean()
    # smooth lateral strongly
    def smooth(a, w, poly=2):
        w = min(w, len(a) - (1-len(a)%2))
        if w<5 or w%2==0: w=max(5,(w//2)*2+1)
        if w>=len(a): return a
        return savgol_filter(a, w, poly)
    lat = smooth(nxArr, 121)            # ~4s window, very smooth
    lat = (lat-np.median(lat))*3.0      # map normalized-x drift to ~meters (stage)
    lat = np.clip(lat, -2.0, 2.0)
    bob = smooth(legSpanArr, 15)
    yy = restY + np.clip((bob-legRef), -0.25, 0.15)
    hips_pos[:,0] = lat
    hips_pos[:,1] = yy
    hips_pos[:,2] = 0.0

    # ---- light Savitzky-Golay on quats (win 7, poly 2) + renormalize ----
    def filt_quat(arr):
        out = arr.copy()
        # enforce hemisphere continuity first
        for i in range(1,F):
            if np.dot(out[i], out[i-1]) < 0:
                out[i] = -out[i]
        if F >= 9:
            for c in range(4):
                out[:,c] = savgol_filter(out[:,c], 7, 2)
        n = np.linalg.norm(out, axis=1, keepdims=True); n[n<1e-9]=1
        return (out/n).astype(np.float32)
    for bone in OUTPUT_BONES:
        quats[bone] = filt_quat(quats[bone])
    hips_quat = filt_quat(hips_quat)
    for c in range(3):
        if F>=9: hips_pos[:,c] = savgol_filter(hips_pos[:,c], 7, 2)

    # ---- unusable spans (conf<0.5 contiguous > 0.5s) ----
    spans=[]
    i=0
    thr_frames=int(0.5*fps)
    while i<F:
        if not GOOD[i]:
            j=i
            while j<F and not GOOD[j]: j+=1
            if (j-i) > thr_frames:
                spans.append({"start": round(i/fps,3), "end": round(j/fps,3),
                              "frames": int(j-i), "type": "held/blended (mocap unusable)"})
            i=j
        else: i+=1
    json.dump({"note":"conf<0.5 for >0.5s; filled by slerp-blend between good poses; hand-key later",
               "spans":spans}, open(os.path.join(WORK,"unusable-spans.json"),"w"), indent=1)

    # ---- bake motion json ----
    def flat(a): return [round(float(x),5) for x in a.reshape(-1)]
    bones_out = {"mixamorig:Hips": {"pos": flat(hips_pos), "rot": flat(hips_quat)}}
    for bone in OUTPUT_BONES:
        bones_out[bone] = {"rot": flat(quats[bone])}
    motion = {
        "fps": fps, "duration": round(dur,3), "frameCount": F,
        "boneNames": ["mixamorig:Hips"]+OUTPUT_BONES,
        "bones": bones_out,
        "confidence": [round(float(c),3) for c in conf],
    }
    outpath = os.path.join(OUTDIR, "billiejean.motion.json")
    json.dump(motion, open(outpath,"w"), separators=(",",":"))
    # cache for markers/validation
    np.savez_compressed(os.path.join(WORK,"retarget-cache.npz"),
        hips_pos=hips_pos, hips_quat=hips_quat, conf=conf, times=times, fps=fps,
        **{f"q_{b.split(':')[1]}":quats[b] for b in OUTPUT_BONES})

    sz=os.path.getsize(outpath)
    det=float(np.mean(GOOD))
    longest = max([s["frames"] for s in spans], default=0)/fps
    print(f"motion baked: {outpath} ({sz/1e6:.2f} MB), frames={F}")
    print(f"detected(conf>0.5)={det*100:.1f}%  unusable spans={len(spans)}  longest={longest:.1f}s")
    print("spans:", json.dumps(spans))

if __name__ == "__main__":
    main()

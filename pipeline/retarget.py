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


# ---- yaw / grounding helpers -------------------------------------------------
def quat_forward_yaw(q):
    """Heading (radians) of a quaternion: yaw of its rotated +Z axis in the XZ plane."""
    x, y, z, w = q
    # rotate (0,0,1) by q -> forward vector
    fx = 2 * (x * z + w * y)
    fz = 1 - 2 * (x * x + y * y)
    return np.arctan2(fx, fz)

def axis_y_quat(angle):
    """Quaternion (xyzw) for a rotation of `angle` rad about the +Y (world up) axis."""
    return np.array([0.0, np.sin(angle / 2.0), 0.0, np.cos(angle / 2.0)])

def hampel(x, win=7, n_sig=3.0):
    """Hampel filter: replace outliers (|x-median|>n_sig*1.4826*MAD) by the local median.
    Returns filtered copy + boolean mask of replaced samples."""
    x = x.astype(float).copy()
    n = len(x); out = x.copy(); mask = np.zeros(n, bool)
    k = win // 2
    for i in range(n):
        a = max(0, i - k); b = min(n, i + k + 1)
        seg = x[a:b]
        med = np.median(seg)
        mad = np.median(np.abs(seg - med))
        sigma = 1.4826 * mad
        if sigma > 1e-9 and abs(x[i] - med) > n_sig * sigma:
            out[i] = med; mask[i] = True
    return out, mask

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
    hips_global = np.zeros((F,4), np.float32)   # world-space hips orientation (pre local-convert)

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
        hips_global[i] = Ghip                               # store world hips; local convert later
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
        hips_global[i] = Q.slerp(hips_global[prv], hips_global[nxt], t)
        hips_pos[i,0] = hips_pos[prv,0]*(1-t)+hips_pos[nxt,0]*t
        hips_pos[i,2] = hips_pos[prv,2]*(1-t)+hips_pos[nxt,2]*t

    # keep the raw temp stores (legSpan in [,0], normalized hip-x in [,2])
    nxArr = hips_pos[:,2].copy()

    def smooth(a, w, poly=2):
        w = min(w, len(a) - (1-len(a)%2))
        if w<5 or w%2==0: w=max(5,(w//2)*2+1)
        if w>=len(a): return a
        return savgol_filter(a, w, poly)

    # =====================================================================
    # DEFECT 1 + 3 — hips ORIENTATION rebuilt from landmark geometry.
    #
    # Facing (yaw) comes from the measured body-forward = cross(hipRight, up)
    # per frame — NOT from an integrated yaw-rate (v3's cumsum drifted, which
    # left long sections facing -Z). Verified against extracted video frames:
    # at t=110/155/250 (frontal) measured fz ~ +0.9; at t=222 (moonwalk, left
    # profile) measured fx ~ -0.93. Known limitation: when MJ genuinely turns
    # his BACK to the camera (e.g. ~95 s) MediaPipe mirror-flips and reports a
    # frontal pose — undetectable here (face-landmark visibility is ~1.0
    # everywhere), so back-facing spans render as front-facing.
    #
    # Continuity: shortest-path unwrap across good frames + hampel on the yaw
    # signal (kills single-frame flips, preserves genuine sustained spins like
    # 181.8 s), then interpolation over the gap frames. No cumsum => no drift.
    #
    # DEFECT 2 (new) — tilt soft-clamp: hips pitch/roll limited to a plausible
    # upright band (35 deg, tanh soft) so bad mocap spans (t~12 s stumble,
    # t~209 s horizontal body) can never put the model on the floor, while
    # moderate genuine leans survive.
    # =====================================================================
    # measured up/forward per frame in model space (vectorized C())
    Pm = np.stack([-world[...,0], -world[...,1], world[...,2]], axis=-1)  # (F,33,3)
    up_m  = 0.5*(Pm[:,L_SH]+Pm[:,R_SH]) - 0.5*(Pm[:,L_HIP]+Pm[:,R_HIP])
    rgt_m = Pm[:,R_HIP] - Pm[:,L_HIP]
    fwd_m = np.cross(rgt_m, up_m)
    fn = np.linalg.norm(fwd_m, axis=1, keepdims=True); fn[fn<1e-9]=1
    fwd_m /= fn
    un = np.linalg.norm(up_m, axis=1, keepdims=True); un[un<1e-9]=1
    up_m /= un

    good_list = list(good_idx)
    # continuous yaw over GOOD frames (shortest-path unwrap between samples)
    yaw_g = np.zeros(len(good_list))
    prev = None
    for k, gi in enumerate(good_list):
        y = np.arctan2(fwd_m[gi,0], fwd_m[gi,2])
        if prev is None:
            yaw_g[k] = y
        else:
            dlt = (y - prev + np.pi) % (2*np.pi) - np.pi
            yaw_g[k] = yaw_g[k-1] + dlt
        prev = (yaw_g[k] + np.pi) % (2*np.pi) - np.pi
    # hampel on the yaw signal itself: ramps (real spins) keep their local
    # median; isolated flip spikes get replaced.
    yaw_g, n_yaw_out = (lambda r: (r[0], int(r[1].sum())))(hampel(yaw_g, win=11, n_sig=3.0))
    # interpolate yaw + up-vector to ALL frames, then light smoothing
    idx_all = np.arange(F)
    yaw_all = np.interp(idx_all, np.array(good_list, float), yaw_g)
    yaw_all = smooth(yaw_all, 9)
    up_all = np.zeros((F,3))
    for c in range(3):
        up_all[:,c] = np.interp(idx_all, np.array(good_list, float), up_m[good_list, c])
        up_all[:,c] = smooth(up_all[:,c], 9)
    n = np.linalg.norm(up_all, axis=1, keepdims=True); n[n<1e-9]=1
    up_all /= n

    # tilt soft clamp (35 deg, tanh knee)
    TILT_MAX = np.radians(35.0)
    Yup = np.array([0.0,1.0,0.0])
    n_tilt_clamped = 0
    for i in range(F):
        u = up_all[i]
        cosT = np.clip(u[1], -1.0, 1.0)
        theta = np.arccos(cosT)
        if theta > 1e-4:
            th2 = TILT_MAX * np.tanh(theta / TILT_MAX)
            if theta > TILT_MAX: n_tilt_clamped += 1
            horiz = u - u[1]*Yup
            hn = np.linalg.norm(horiz)
            horiz = horiz/hn if hn > 1e-9 else np.array([0.0,0.0,1.0])
            up_all[i] = np.cos(th2)*Yup + np.sin(th2)*horiz

    # rebuild hips orientation: yaw sets heading exactly, tilt from clamped up
    for i in range(F):
        psi = yaw_all[i]
        fwd_h = np.array([np.sin(psi), 0.0, np.cos(psi)])
        u = up_all[i]
        r = np.cross(u, fwd_h)
        rn = np.linalg.norm(r)
        r = r/rn if rn > 1e-9 else np.array([1.0,0.0,0.0])
        Ralign = Q.frame_align(rest_right, rest_up, r, u)
        G0 = Q.qmul(Ralign, restQuat["mixamorig:Hips"])
        # enforce heading EXACTLY on the runtime's probe axis (hips local +Z):
        psi0 = quat_forward_yaw(G0)
        G = Q.qmul(axis_y_quat(psi - psi0), G0)
        hips_global[i] = G
        hips_quat[i]   = Q.qmul(Q.qconj(hipsParentQ), G)        # world -> local
    print(f"yaw rebuild: {n_yaw_out} hampel outliers replaced, {n_tilt_clamped} frames tilt-clamped (>{np.degrees(TILT_MAX):.0f} deg)")

    # ---- automated facing assertion: 90-130 s high-confidence frames must
    # face the audience (+Z). Video frames at 110/155 confirm frontal there.
    tsec = idx_all / fps
    w = (tsec >= 90) & (tsec <= 130) & GOOD
    fz_check = np.array([quat_forward_yaw(hips_global[i]) for i in np.where(w)[0]])
    mean_fz = float(np.mean(np.cos(fz_check)))
    print(f"facing check 90-130s: mean fz={mean_fz:.3f} over {w.sum()} good frames")
    assert mean_fz > 0.4, f"facing check FAILED: mean fz={mean_fz:.3f} <= 0.4"

    # ---- light Savitzky-Golay on quats (win 7, poly 2) + renormalize ----
    def filt_quat(arr):
        out = arr.copy()
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

    # =====================================================================
    # DEFECT 2 — GROUNDING. FK the FINAL pose per frame (same convention as
    # validate.py) and drop the hips so the lowest foot joint touches the
    # floor. Runtime maps baked-Z -> world vertical at 0.01*posScale m/unit,
    # and rest hips sit restY above the stage, so:
    #     footWorldY = objY + restY + 0.01*s*z_b + fRel   (fRel = foot-below-hips, m)
    #     -> z_b = -(restY + fRel) / (0.01*s)   to put the lowest foot on the floor.
    # =====================================================================
    bindT = {b: np.array(nodes[b]["localTranslation"], float) for b in nodes}
    hipsParentP = np.array(skel["hipsParentWorldPos"])
    fk_order = []
    def _visit(b):
        if b in fk_order: return
        p = parentName[b]
        if p in nodes: _visit(p)
        fk_order.append(b)
    for b in nodes: _visit(b)
    def _qmat(q):
        x,y,z,w=q; n=(x*x+y*y+z*z+w*w)**0.5 or 1.0; x,y,z,w=x/n,y/n,z/n,w/n
        return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                         [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                         [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    def _M(t,q):
        m=np.eye(4); m[:3,:3]=_qmat(q); m[:3,3]=t; return m
    FEET = ["mixamorig:LeftFoot","mixamorig:LeftToeBase",
            "mixamorig:RightFoot","mixamorig:RightToeBase"]
    def local_rot(b, i):
        if b == "mixamorig:Hips": return hips_quat[i]
        if b in quats:             return quats[b][i]
        return localBind[b]
    root = _M(hipsParentP, hipsParentQ)
    fRel = np.zeros(F)                     # metres, lowest foot joint below the hips
    for i in range(F):
        W={}
        for b in fk_order:
            lp = np.zeros(3) if b=="mixamorig:Hips" else bindT[b]   # hips at origin: measure shape only
            loc = _M(lp, local_rot(b,i))
            W[b] = root@loc if b=="mixamorig:Hips" else W[parentName[b]]@loc
        hy = W["mixamorig:Hips"][1,3]
        fmin = min(W[b][1,3] for b in FEET)
        fRel[i] = (fmin - hy) * 0.01       # native cm -> metres
    posScale = float(nodes["mixamorig:Hips"]["localTranslation"][1] / restY)  # bindY/restY
    z_b = -(restY + fRel) / (0.01 * posScale)
    z_b = smooth(z_b, 9)                    # light: kill jitter, keep real crouch/toe-stand
    # clamp hips vertical excursion to a physical range (rest grounding is ~z0);
    # blocks a bad-frame pose from slamming the hips through the floor.
    z0 = float(np.median(z_b))
    z_b = np.clip(z_b, z0 - 0.55/(0.01*posScale), z0 + 0.30/(0.01*posScale))

    # =====================================================================
    # DEFECT 4 — LATERAL STAGE TRAVEL from the normalized hip-x trajectory.
    # Moderate smoothing (keeps walks/moonwalk), map to metres, clip to stage.
    # After the 180 facing flip the lateral sense is mirrored, so negate.
    # =====================================================================
    lat = smooth(nxArr, 21)                          # ~0.7 s: responsive, denoised
    # camera sits at +Z looking -Z => screen-right == world +X; normalized-x
    # grows to screen-right, so the gain is POSITIVE (v3's negation mirrored it).
    lat = (lat - np.median(lat)) * 12.0              # normalized drift -> metres
    lat = np.clip(lat, -4.0, 4.0)                    # stage half-width ~4 m
    x_b = lat / (0.01 * posScale)                    # metres -> baked units

    hips_pos[:,0] = x_b
    hips_pos[:,1] = restY                             # depth channel: hold rest (drives posScale)
    hips_pos[:,2] = z_b
    if F>=9:
        for c in range(3): hips_pos[:,c] = savgol_filter(hips_pos[:,c], 7, 2)

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

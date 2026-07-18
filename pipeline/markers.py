#!/usr/bin/env python3
"""Step 5: derive named iconic-moment markers from pose motion energy + hints.
Outputs: public/concerts/motown25-billiejean/markers.json
"""
import os, json
import numpy as np
import qutil as Q

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
OUTDIR = os.path.join(ROOT, "public", "concerts", "motown25-billiejean")

def smooth(a,w):
    if w%2==0: w+=1
    if w>=len(a): return a
    k=np.ones(w)/w
    return np.convolve(a,k,mode="same")

def main():
    d=np.load(os.path.join(WORK,"pose-raw.npz"))
    world=d["world"]; norm=d["norm"]; conf=d["conf"]; fps=float(d["sample_fps"]); dur=float(d["duration"])
    F=world.shape[0]
    c=np.load(os.path.join(WORK,"retarget-cache.npz"))
    hips_quat=c["hips_quat"]; hips_pos=c["hips_pos"]

    good=conf>0.5
    # overall body motion energy: framewise world-landmark displacement (core joints)
    core=[0,11,12,13,14,15,16,23,24,25,26,27,28,31,32]
    W=world[:,core,:]
    vel=np.zeros(F)
    for i in range(1,F):
        if good[i] and good[i-1]:
            vel[i]=np.linalg.norm(W[i]-W[i-1])
    velS=smooth(vel,9)

    # foot horizontal (x,z) speed for moonwalk (alternating glide)
    feet=[27,28,31,32]
    fv=np.zeros(F)
    for i in range(1,F):
        if good[i] and good[i-1]:
            fv[i]=np.linalg.norm((world[i,feet]-world[i-1,feet])[:,[0,2]])
    fvS=smooth(fv,7)

    # hips rotational speed (spins)
    rot=np.zeros(F)
    for i in range(1,F):
        dq=Q.qmul(hips_quat[i],Q.qconj(hips_quat[i-1]))
        rot[i]=2*np.arccos(min(1.0,abs(dq[3])))
    rotS=smooth(rot,5)

    def t2f(t): return int(round(t*fps))
    def f2t(f): return round(f/fps,2)
    def argmax_in(arr,a,b):
        a=max(0,t2f(a)); b=min(F,t2f(b))
        seg=arr[a:b]
        return a+int(np.argmax(seg)) if len(seg) else a

    markers={}
    # intro-pose: first sustained good detection with low motion in first 90s
    introf=None
    for i in range(t2f(2), t2f(90)):
        if good[i] and velS[i]<np.percentile(velS[good],20):
            introf=i; break
    markers["intro-pose"]=f2t(introf if introf else t2f(5))

    # first-beat: strongest energy onset in 78..96s (bass kick / dance start)
    a,b=t2f(78),t2f(98)
    dv=np.diff(velS[a:b]); markers["first-beat"]=f2t(a+int(np.argmax(dv))+1)

    # spin-1: max hips rotational speed spike before moonwalk region (90..215s)
    markers["spin-1"]=f2t(argmax_in(rotS, 90, 215))

    # moonwalk: window of high sustained foot horizontal glide near hint (205..232s)
    a,b=t2f(205),t2f(232)
    win=int(1.5*fps); best=a; bestv=-1
    for i in range(a,max(a+1,b-win)):
        s=fvS[i:i+win].mean()
        if s>bestv: bestv=s; best=i
    markers["moonwalk"]=f2t(best)

    # toe-stand: after moonwalk, hips height peak with low motion (moonwalk..250s)
    a,b=t2f(markers["moonwalk"]),t2f(250)
    seg_y=hips_pos[a:b,1].copy()
    seg_v=velS[a:b]
    score=seg_y - 2.0*(seg_v/ (seg_v.max()+1e-6))
    markers["toe-stand"]=f2t(a+int(np.argmax(score))) if len(score) else 240.0

    # finale: last strong energy spike in 250..end
    a,b=t2f(250),F
    seg=velS[a:b]
    markers["finale"]=f2t(a+int(np.argmax(seg))) if len(seg) else round(dur-5,2)

    markers={k:markers[k] for k in ["intro-pose","first-beat","spin-1","moonwalk","toe-stand","finale"]}
    json.dump({"markers":markers,
               "note":"derived from pose motion energy; moonwalk/toe-stand cross-checked vs known ~3:38 hint"},
              open(os.path.join(OUTDIR,"markers.json"),"w"), indent=1)
    print("markers:", json.dumps(markers))

if __name__=="__main__":
    main()

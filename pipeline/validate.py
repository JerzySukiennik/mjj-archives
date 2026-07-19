#!/usr/bin/env python3
"""Step 6: FK the baked motion, project front-orthographic stick figure, overlay on video frames.
Outputs: pipeline/work/validate/*.png
"""
import os, glob, json
import numpy as np
import cv2
import qutil as Q

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
OUTDIR = os.path.join(ROOT, "public", "concerts", "motown25-billiejean")
VIDEO = glob.glob(os.path.join(ROOT,"Assets","Koncerty","1","Video*","*.mp4"))[0]
VDIR = os.path.join(WORK,"validate"); os.makedirs(VDIR, exist_ok=True)

def qmat(q):
    x,y,z,w=q; n=(x*x+y*y+z*z+w*w)**0.5 or 1; x,y,z,w=x/n,y/n,z/n,w/n
    return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                     [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                     [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
def M(t,q):
    m=np.eye(4); m[:3,:3]=qmat(q); m[:3,3]=t; return m

# skeleton bind data
skel=json.load(open(os.path.join(WORK,"skeleton.json")))
nodes=skel["nodes"]
parent={b:nodes[b]["parent"] for b in nodes}
bindT={b:np.array(nodes[b]["localTranslation"],float) for b in nodes}
bindR={b:np.array(nodes[b]["localRotation"],float) for b in nodes}
hipsParentQ=np.array(skel["hipsParentWorldQuat"]); hipsParentP=np.array(skel["hipsParentWorldPos"])
# order: parents before children
order=[];
def visit(b):
    if b in order: return
    p=parent[b]
    if p in nodes: visit(p)
    order.append(b)
for b in nodes: visit(b)

motion=json.load(open(os.path.join(OUTDIR,"billiejean.motion.json")))
mb=motion["bones"]; F=motion["frameCount"]; fps=motion["fps"]
def getrot(b,i):
    if b in mb and "rot" in mb[b]:
        r=mb[b]["rot"]; return np.array(r[i*4:i*4+4])
    return bindR[b]
def gethippos(i):
    p=mb["mixamorig:Hips"]["pos"]; return np.array(p[i*3:i*3+3])

LIMBS=[("mixamorig:Hips","mixamorig:Spine"),("mixamorig:Spine","mixamorig:Spine1"),
("mixamorig:Spine1","mixamorig:Spine2"),("mixamorig:Spine2","mixamorig:Neck"),
("mixamorig:Neck","mixamorig:Head"),("mixamorig:Head","mixamorig:HeadTop_End"),
("mixamorig:Spine2","mixamorig:LeftShoulder"),("mixamorig:LeftShoulder","mixamorig:LeftArm"),
("mixamorig:LeftArm","mixamorig:LeftForeArm"),("mixamorig:LeftForeArm","mixamorig:LeftHand"),
("mixamorig:Spine2","mixamorig:RightShoulder"),("mixamorig:RightShoulder","mixamorig:RightArm"),
("mixamorig:RightArm","mixamorig:RightForeArm"),("mixamorig:RightForeArm","mixamorig:RightHand"),
("mixamorig:Hips","mixamorig:LeftUpLeg"),("mixamorig:LeftUpLeg","mixamorig:LeftLeg"),
("mixamorig:LeftLeg","mixamorig:LeftFoot"),("mixamorig:LeftFoot","mixamorig:LeftToeBase"),
("mixamorig:Hips","mixamorig:RightUpLeg"),("mixamorig:RightUpLeg","mixamorig:RightLeg"),
("mixamorig:RightLeg","mixamorig:RightFoot"),("mixamorig:RightFoot","mixamorig:RightToeBase")]

def fk(i):
    W={}
    root=M(hipsParentP,hipsParentQ)
    for b in order:
        if b=="mixamorig:Hips":
            local=M(gethippos(i), getrot(b,i))
            W[b]=root@local
        else:
            p=parent[b]
            local=M(bindT[b], getrot(b,i))
            W[b]=W[p]@local
    return {b:W[b][:3,3] for b in W}

def main():
    cap=cv2.VideoCapture(VIDEO)
    times=[3,9,21,35,48,58,70,80,90,100,125,133,150,161,184,199,210,222,229,242,250,267,275,290]
    for t in times:
        i=int(round(t*fps));  i=max(0,min(F-1,i))
        pos=fk(i)
        cap.set(cv2.CAP_PROP_POS_MSEC,t*1000); ok,frame=cap.read()
        if not ok: continue
        H,Wd=frame.shape[:2]
        xs=[pos[b][0] for b in pos]; ys=[pos[b][1] for b in pos]
        # front ortho: model x->right, y->up. fit skeleton into right half panel
        pts=np.array([[pos[b][0],pos[b][1]] for b in pos])
        cx=(pts[:,0].min()+pts[:,0].max())/2;
        span=max(pts[:,1].max()-pts[:,1].min(),0.1)
        scale=(H*0.8)/span
        ox=Wd*0.5; oy=H*0.9; ymin=pts[:,1].min()
        def proj(b):
            X=ox+(pos[b][0]-cx)*scale
            Yv=oy-(pos[b][1]-ymin)*scale
            return int(X),int(Yv)
        for a,bb in LIMBS:
            if a in pos and bb in pos:
                cv2.line(frame,proj(a),proj(bb),(0,255,0),3)
        for b in pos:
            cv2.circle(frame,proj(b),3,(0,180,255),-1)
        cv2.putText(frame,f"t={t:.1f}s frame={i}",(20,40),cv2.FONT_HERSHEY_SIMPLEX,1,(0,255,255),2)
        out=os.path.join(VDIR,f"val_{int(t):03d}s.png")
        cv2.imwrite(out,frame)
        print("wrote",out)
    cap.release()

_mk=None
def markers_t(k):
    global _mk
    if _mk is None:
        p=os.path.join(OUTDIR,"markers.json")
        _mk=json.load(open(p))["markers"] if os.path.exists(p) else {}
    return _mk.get(k,150)

if __name__=="__main__":
    main()

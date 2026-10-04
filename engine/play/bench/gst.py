"""Decodes the core's GS trace (GST lines from Module.gsTrace(frames)) into readable draws.

  node engine/play/bench/probe.mjs --disc x.chd --eval "44:Module.gsTrace(4)" --out work/shots/t
  python engine/play/bench/gst.py work/shots/t/console.log

Units: fbp/tbp/cbp and transfer bp are in 64-word blocks, widths in pixels.
"""
import sys, re
PSM = {0:'CT32',1:'CT24',2:'CT16',0xa:'CT16S',0x13:'T8',0x14:'T4',0x1b:'T8H',0x24:'T4HL',0x2c:'T4HH',0x30:'Z32',0x31:'Z24',0x32:'Z16',0x3a:'Z16S'}
def b(v,lo,n): return (v>>lo)&((1<<n)-1)
def psm(x): return PSM.get(x,hex(x))
ABC = ['Cs','Cd','0']; CC=['As','Ad','FIX']
last=None
for line in open(sys.argv[1],encoding='utf8',errors='replace'):
    i=line.find('GST ')
    if i<0: continue
    line=line[i+4:].strip()
    kind,rest=line.split(' ',1)
    kv=dict(x.split('=',1) for x in rest.split())
    if kind=='ctx':
        h={k:int(v,16) for k,v in kv.items()}
        pr=h['prim']; fr=h['frame']; t0=h['tex0']; al=h['alpha']; te=h['test']
        s=f"prim={b(pr,0,3)} tme={b(pr,4,1)} abe={b(pr,6,1)} fst={b(pr,8,1)} ctx={b(pr,9,1)}"
        s+=f" | FB fbp={b(fr,0,9)*32:x} fbw={b(fr,16,6)*64} {psm(b(fr,24,6))} msk={b(fr,32,32):08x}"
        if b(pr,4,1):
            s+=f" | TEX tbp={b(t0,0,14):x} tbw={b(t0,14,6)*64} {psm(b(t0,20,6))} {1<<b(t0,26,4)}x{1<<b(t0,30,4)} tcc={b(t0,34,1)} tfx={b(t0,35,2)} cbp={b(t0,37,14):x} cpsm={psm(b(t0,51,4))} csm={b(t0,55,1)} csa={b(t0,56,5)} cld={b(t0,61,3)}"
            s+=f" texa={h['texa']:x} clamp={h['clamp']:x} tex1={h['tex1']:x}"
        if b(pr,6,1):
            s+=f" | BLEND ({ABC[b(al,0,2)]}-{ABC[b(al,2,2)]})*{CC[b(al,4,2)]}+{ABC[b(al,6,2)]} fix={b(al,32,8)}"
        s+=f" | TEST ate={b(te,0,1)} atst={b(te,1,3)} aref={b(te,4,8)} afail={b(te,12,2)} date={b(te,14,1)} datm={b(te,15,1)} zte={b(te,16,1)} ztst={b(te,17,2)}"
        extra=[f"{k}={h[k]:x}" for k in ('fba','pabe','colclamp','dthe') if h[k]]
        if extra: s+=' | '+' '.join(extra)
        s+=f" caps={h['caps']:x}"
        last=s
        print('CTX',s)
    elif kind=='draw':
        print('   DRAW',rest)
    elif kind in('h2l','l2l'):
        bb=int(kv['bitblt'],16); tp=int(kv['trxpos'],16); tr=int(kv['trxreg'],16)
        print(kind.upper(),f"src bp={b(bb,0,14)*64:x} bw={b(bb,16,6)*64} {psm(b(bb,24,6))} -> dst bp={b(bb,32,14)*64:x} bw={b(bb,48,6)*64} {psm(b(bb,56,6))} pos s={b(tp,0,11)},{b(tp,16,11)} d={b(tp,32,11)},{b(tp,48,11)} size={b(tr,0,12)}x{b(tr,32,12)}", kv.get('dirty',''))
    else:
        print(kind.upper(),rest)

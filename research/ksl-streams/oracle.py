#!/usr/bin/env python3
"""Independent integer MRG32k3a oracle; does not import/call KSL."""
import hashlib,json,struct

M1=4294967087
M2=4294944443
ORIGIN=[12345]*6
NORM=float('2.328306549295727688e-10')
# State [x(n-2),x(n-1),x(n)] -> [x(n-1),x(n),x(n+1)]
A1=[[0,1,0],[0,0,1],[-810728,1403580,0]]
A2=[[0,1,0],[0,0,1],[-1370589,0,527612]]

def mul(a,b,m):
    return [[sum(a[i][k]*b[k][j] for k in range(3))%m for j in range(3)] for i in range(3)]

def power(a,e,m):
    out=[[int(i==j) for j in range(3)] for i in range(3)]
    while e:
        if e&1: out=mul(out,a,m)
        a=mul(a,a,m)
        e>>=1
    return out

def matvec(a,v,m):
    return [sum(x*y for x,y in zip(row,v))%m for row in a]

def start(address):
    steps=address*(1<<76)
    return matvec(power(A1,steps,M1),ORIGIN[:3],M1)+matvec(power(A2,steps,M2),ORIGIN[3:],M2)

def next_state(s):
    p1=(1403580*s[1]-810728*s[0])%M1
    p2=(527612*s[5]-1370589*s[3])%M2
    s=[s[1],s[2],p1,s[4],s[5],p2]
    # Mirrors the documented binary64 arithmetic, while state evolution above is exact.
    z=p1-p2 if p1>p2 else p1-p2+M1
    u=float(z)*NORM
    return s,u,struct.pack('>d',u).hex()

def field(v):
    b=v.encode('utf-8',errors='strict')
    return struct.pack('>i',len(b))+b

def key(seed,replication,path,role):
    b=field('resilience-lab/ksl-path-substream/v1')+struct.pack('>qqi',seed,replication,len(path))
    b+=b''.join(field(s) for s in path)+field(role)
    h=hashlib.sha256(b).digest()
    return {'seed':seed,'replication':replication,'path':path,'role':role,'canonical_hex':b.hex(),'sha256':h.hex(),'address':int.from_bytes(h[:8],'big')&((1<<63)-1)}

keys=[key(42,0,['system','api'],'processing'),key(0,(1<<63)-1,['а','сервис'],'outcome')]
addresses=[0,1,(1<<51)-1,1<<51,(1<<63)-1]+[k['address'] for k in keys]
fixtures=[]
for addr in addresses:
    initial=start(addr)
    current=initial[:]
    us=[];bits=[]
    for _ in range(4):
        current,u,h=next_state(current)
        us.append(u); bits.append(h)
    fixtures.append({'address':addr,'state':initial,'uniform_values':us,'uniform_bits_hex':bits})
result={'origin':ORIGIN,'norm_bits_hex':struct.pack('>d',NORM).hex(),'keys':keys,'fixtures':fixtures}
print(json.dumps(result,ensure_ascii=False,indent=2))

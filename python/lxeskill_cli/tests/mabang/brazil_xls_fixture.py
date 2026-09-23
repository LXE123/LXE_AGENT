"""Synthetic BIFF8/OLE fixture. Contains no production business rows."""
import struct


def synthetic_xls(headers, rows, *, merges=(), bad_mini_tail=False, cycle=False):
    def rec(code,data=b''):
        return struct.pack('<HH',code,len(data))+data
    def bof(kind):
        return rec(0x809,struct.pack('<HHHHII',0x600,kind,0xDBB,0x7CC,0,6))
    strings=list(dict.fromkeys(str(v) for row in [headers,*rows] for v in row if isinstance(v,str)))
    sst=rec(0xFC,struct.pack('<II',len(strings),len(strings))+b''.join(struct.pack('<HB',len(s),1)+s.encode('utf-16-le') for s in strings))
    sheet=bof(0x10)+rec(0x200,struct.pack('<IIHHH',0,len(rows)+1,0,len(headers),0))
    for r,row in enumerate([headers,*rows]):
        for c,value in enumerate(row):
            if value is None:continue
            prefix=struct.pack('<HHH',r,c,0)
            sheet+=rec(0xFD,prefix+struct.pack('<I',strings.index(value))) if isinstance(value,str) else rec(0x203,prefix+struct.pack('<d',value))
    if merges:sheet+=rec(0xE5,struct.pack('<H',len(merges))+b''.join(struct.pack('<HHHH',r0,r1-1,c0,c1-1) for r0,r1,c0,c1 in merges))
    sheet+=rec(0xA)
    def bound(offset):return rec(0x85,struct.pack('<IBBBB',offset,0,0,1,0)+b'S')
    prefix=bof(5)+sst
    offset=len(prefix)+len(bound(0))+4
    stream=prefix+bound(offset)+rec(0xA)+sheet
    length=max(4096,((len(stream)+511)//512)*512)
    stream=stream.ljust(length,b'\0');count=length//512;fat_sid=count+2;ssat_sid=fat_sid+1
    header=bytearray(512);header[:8]=bytes.fromhex('d0cf11e0a1b11ae1')
    struct.pack_into('<HHHH',header,24,0x3E,3,0xFFFE,9);struct.pack_into('<H',header,32,6)
    struct.pack_into('<IIIIIIIII',header,40,0,1,0,0,4096,ssat_sid,1,0xFFFFFFFE,0)
    struct.pack_into('<109i',header,76,fat_sid,*([-1]*108))
    def entry(name,kind,start,size,child=-1):
        d=bytearray(128);n=(name+'\0').encode('utf-16-le');d[:len(n)]=n
        struct.pack_into('<HBBiii',d,64,len(n),kind,1,-1,-1,child)
        struct.pack_into('<iQ',d,116,start,size);return bytes(d)
    directory=(entry('Root Entry',5,1,512,1)+entry('Workbook',2,2,length)).ljust(512,b'\0')
    fat=[-1]*128;fat[0]=-2;fat[1]=2 if bad_mini_tail else -2
    for i in range(2,fat_sid):fat[i]=i+1 if i+1<fat_sid else -2
    if cycle:fat[3]=2
    fat[fat_sid]=-3;fat[ssat_sid]=-2
    return bytes(header)+directory+bytes(512)+stream+struct.pack('<128i',*fat)+struct.pack('<128i',*([-1]*128))

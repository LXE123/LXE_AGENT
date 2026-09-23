"""Narrow compatibility for the ERP's captured OLE mini-stream tail defect.

The 2026-09-23 export declares a 512-byte root mini-stream, but its FAT
link continues into the otherwise complete Workbook stream. xlrd walks
past the declared root length and marks Workbook sectors as mini-stream.
Check the declared extents and all chain boundaries, then parse only the
unaltered Workbook bytes. Never enable ignore_workbook_corruption.
"""
import io
import math
from xlrd.compdoc import CompDoc, EOCSID
from .errors import BrazilError


def workbook_stream(body):
    doc = CompDoc(body, logfile=io.StringIO())
    entries = [d for d in doc.dirlist if d.etype == 2]
    roots = [d for d in doc.dirlist if d.etype == 5]
    workbooks = [d for d in entries if d.name == 'Workbook']
    if len(roots) != 1 or len(workbooks) != 1:
        raise BrazilError('invalid_workbook', '兼容读取要求唯一 Root Entry 与 Workbook')
    root, workbook = roots[0], workbooks[0]
    if doc.sec_size != 512 or root.tot_size != 512 or workbook.tot_size < doc.min_size_std_stream:
        raise BrazilError('invalid_workbook', 'OLE 结构不匹配已验证的马帮短流尾链特征')

    def chain(start, size, table, sector_size, limit):
        count = math.ceil(size / sector_size)
        if count > limit:
            raise BrazilError('invalid_workbook', 'OLE 声明长度超出文件边界')
        ids, seen, sid = [], set(), start
        for _ in range(count):
            if sid < 0 or sid >= limit or sid >= len(table) or sid in seen:
                raise BrazilError('invalid_workbook', 'OLE 流截断、循环或扇区越界')
            ids.append(sid);seen.add(sid);sid=table[sid]
        return ids,sid

    sectors = (len(body)-512)//512
    root_ids, root_next = chain(root.first_SID,root.tot_size,doc.SAT,512,sectors)
    workbook_ids, workbook_next = chain(workbook.first_SID,workbook.tot_size,doc.SAT,512,sectors)
    if root_next != workbook.first_SID or workbook_next != EOCSID or set(root_ids)&set(workbook_ids):
        raise BrazilError('invalid_workbook', 'OLE 尾链或 Workbook 边界不匹配已验证特征')
    if any(doc.seen[i] != 4 for i in root_ids+workbook_ids):
        raise BrazilError('invalid_workbook', 'Workbook 与 OLE 分配表或目录重叠')
    mini_seen = set()
    for entry in entries:
        if entry is workbook:
            continue
        if entry.name not in {'\x05SummaryInformation','\x05DocumentSummaryInformation'}:
            raise BrazilError('invalid_workbook','OLE 含未验证的额外数据流')
        ids, end = chain(entry.first_SID,entry.tot_size,doc.SSAT,doc.short_sec_size,root.tot_size//doc.short_sec_size)
        if end != EOCSID or mini_seen.intersection(ids):
            raise BrazilError('invalid_workbook','OLE 元信息短流重叠或尾链异常')
        mini_seen.update(ids)
    stream=b''.join(body[512+i*512:1024+i*512] for i in workbook_ids)[:workbook.tot_size]
    if len(stream) != workbook.tot_size:
        raise BrazilError('invalid_workbook','Workbook 实际长度不足')
    return stream

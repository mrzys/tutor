"""Read-only local PDF discovery. Extracted text is a locator, not verified question data."""
from pathlib import Path
import fitz, json, hashlib, re

ROOT=Path('C:/baidunetdiskdownload/高--模拟题/数学')
OUT=Path(__file__).parent
results=[]
seen=set()
fitz.TOOLS.mupdf_display_errors(False)
fitz.TOOLS.mupdf_display_warnings(False)
for p in [*sorted((ROOT/'2026').rglob('*.pdf')),*sorted((ROOT/'2025').rglob('*.pdf'))]:
    if any(k in p.name for k in ['答案','解析','答题卡','细则','DA','PF']): continue
    try:
        with fitz.open(p) as doc:
            for i in range(min(2,len(doc))):
                text=doc[i].get_text()
                if '集合' not in text: continue
                digest=hashlib.sha256(re.sub(r'\s+','',text).encode()).hexdigest()
                if digest in seen: continue
                seen.add(digest)
                results.append({'file':str(p),'page':i+1,'pageCount':len(doc),'text':text,'sameDirectoryPdfFiles':[str(x) for x in p.parent.glob('*.pdf') if x!=p]})
                break
    except Exception as e: continue
    if len(results)>=100:break
(OUT/'discovery-pages.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'locatedPages':len(results),'output':str(OUT/'discovery-pages.json')},ensure_ascii=False))

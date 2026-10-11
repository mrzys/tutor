"""Inventory the five local textbooks; OCR downloads remain ignored, never verified."""
import hashlib
import json
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.tutor/curriculum/textbooks'
SOURCES = json.loads((ROOT / 'docs/curriculum/local-sources.json').read_text(encoding='utf8'))
# Transcribed from the actual PDF contents pages, visually checked 2026-10-11.
SPEC = [
 ('rja-compulsory-1', '必修第一册', '必修 第一册.pdf', 7, [6,7], 258, [
  ('1','集合与常用逻辑用语',1,[('1.1','集合的概念',2),('1.2','集合间的基本关系',7),('1.3','集合的基本运算',10),('1.4','充分条件与必要条件',17),('1.5','全称量词与存在量词',26)]),
  ('2','一元二次函数、方程和不等式',36,[('2.1','等式性质与不等式性质',37),('2.2','基本不等式',44),('2.3','二次函数与一元二次方程、不等式',50)]),
  ('3','函数的概念与性质',59,[('3.1','函数的概念及其表示',60),('3.2','函数的基本性质',76),('3.3','幂函数',89),('3.4','函数的应用（一）',93)]),
  ('4','指数函数与对数函数',103,[('4.1','指数',104),('4.2','指数函数',111),('4.3','对数',122),('4.4','对数函数',130),('4.5','函数的应用（二）',142)]),
  ('5','三角函数',167,[('5.1','任意角和弧度制',168),('5.2','三角函数的概念',177),('5.3','诱导公式',188),('5.4','三角函数的图象与性质',196),('5.5','三角恒等变换',215),('5.6','函数y=Asin(ωx+φ)',231),('5.7','三角函数的应用',242)])]),
 ('rja-compulsory-2','必修第二册','必修 第二册.pdf',7,[6,7],269,[
  ('6','平面向量及其应用',1,[('6.1','平面向量的概念',2),('6.2','平面向量的运算',7),('6.3','平面向量基本定理及坐标表示',25),('6.4','平面向量的应用',38)]),
  ('7','复数',67,[('7.1','复数的概念',68),('7.2','复数的四则运算',75),('7.3','复数的三角表示',83)]),
  ('8','立体几何初步',96,[('8.1','基本立体图形',97),('8.2','立体图形的直观图',107),('8.3','简单几何体的表面积与体积',114),('8.4','空间点、直线、平面之间的位置关系',124),('8.5','空间直线、平面的平行',133),('8.6','空间直线、平面的垂直',146)]),
  ('9','统计',172,[('9.1','随机抽样',173),('9.2','用样本估计总体',193),('9.3','统计案例 公司员工的肥胖情况调查分析',220)]),
  ('10','概率',227,[('10.1','随机事件与概率',228),('10.2','事件的相互独立性',249),('10.3','频率与概率',254)])]),
 ('rja-selective-1','选择性必修第一册','选择性必修 第一册.pdf',5,[5],147,[
  ('1','空间向量与立体几何',1,[('1.1','空间向量及其运算',2),('1.2','空间向量基本定理',11),('1.3','空间向量及其运算的坐标表示',16),('1.4','空间向量的应用',26)]),
  ('2','直线和圆的方程',50,[('2.1','直线的倾斜角与斜率',51),('2.2','直线的方程',59),('2.3','直线的交点坐标与距离公式',70),('2.4','圆的方程',82),('2.5','直线与圆、圆与圆的位置关系',91)]),
  ('3','圆锥曲线的方程',104,[('3.1','椭圆',105),('3.2','双曲线',118),('3.3','抛物线',130)])]),
 ('rja-selective-2','选择性必修第二册','选择性必修 第二册.pdf',5,[5],105,[
  ('4','数列',1,[('4.1','数列的概念',2),('4.2','等差数列',12),('4.3','等比数列',27),('4.4','数学归纳法',44)]),
  ('5','一元函数的导数及其应用',58,[('5.1','导数的概念及其意义',59),('5.2','导数的运算',72),('5.3','导数在研究函数中的应用',84)])]),
 ('rja-selective-3','选择性必修第三册','选择性必修 第三册.pdf',5,[5],147,[
  ('6','计数原理',1,[('6.1','分类加法计数原理与分步乘法计数原理',2),('6.2','排列与组合',14),('6.3','二项式定理',29)]),
  ('7','随机变量及其分布',43,[('7.1','条件概率与全概率公式',44),('7.2','离散型随机变量及其分布列',56),('7.3','离散型随机变量的数字特征',62),('7.4','二项分布与超几何分布',72),('7.5','正态分布',83)]),
  ('8','成对数据的统计分析',92,[('8.1','成对数据的统计相关性',93),('8.2','一元线性回归模型及其应用',105),('8.3','列联表与独立性检验',124)])]),
]

def digest(data):
 return hashlib.sha256(data).hexdigest()

def main():
 books=[]
 legacy={p['pdf_page']:p for p in json.loads((ROOT/'.tutor/curriculum/legacy-pages.json').read_text(encoding='utf8'))}
 legacyFront={p['page']:p for p in json.loads((ROOT/'.tutor/curriculum/legacy-workflow-ocr.json').read_text(encoding='utf8'))[0]['ocr_result']['pages'] if p['page']<=7}
 for bid,volume,suffix,offset,toc,lastprint,chapters in SPEC:
  src=next(x for x in SOURCES if x['path'].endswith(suffix))
  assert digest(Path(src['path']).read_bytes())==src['sha256']
  out=LOCAL/bid;out.mkdir(parents=True,exist_ok=True)
  doc=fitz.open(src['path']);pages=[]
  printedMax = lastprint + (1 if bid in ['rja-compulsory-1','rja-compulsory-2'] else 0)
  for i,page in enumerate(doc):
   num=i+1; txt=page.get_text();source='pdf_text_layer' if len(txt.strip())>50 else 'missing_text_layer'
   review='unverified_extraction';ocrJobId=None;layoutPath=None
   legacyPdfPage=None
   if bid=='rja-compulsory-1' and (num in legacy and num<=267 or num==270):
    legacyPdfPage=268 if num==270 else num
    old=legacy[legacyPdfPage];txt=old['corrected_text'] or old['ocr_text'];source='legacy_ocr';review=old['review_status'];layoutPath='.tutor/curriculum/legacy-workflow-ocr.json'
   elif bid=='rja-compulsory-1' and num in legacyFront:
    legacyPdfPage=num;txt=legacyFront[num]['text'];source='legacy_ocr';review='ocr_unverified';layoutPath='.tutor/curriculum/legacy-workflow-ocr.json'
   elif (out/f'ocr-page-{num:03d}.json').exists():
    layoutPath=(out/f'ocr-page-{num:03d}.json').relative_to(ROOT).as_posix()
    o=json.loads((ROOT/layoutPath).read_text(encoding='utf8'));txt=o['text'];ocrJobId=o['jobId'];source='paddle_ocr';review='ocr_unverified'
   textPath=out/f'page-{num:03d}.txt';textPath.write_bytes(txt.encode('utf8'))
   pages.append({'pdfPage':num,'printedPage':num-offset if offset<num<=offset+printedMax else None,'textSource':source,'textCharacters':len(txt.strip()),'textSha256':digest(txt.encode()),'localTextPath':textPath.relative_to(ROOT).as_posix(),'reviewStatus':review,**({'ocrJobId':ocrJobId} if ocrJobId else {}),**({'legacyPdfPage':legacyPdfPage} if legacyPdfPage else {}),**({'localLayoutPath':layoutPath} if layoutPath else {})})
  nodes=[]
  for ix,(n,title,start,sections) in enumerate(chapters):
   end=chapters[ix+1][2]-1 if ix+1<len(chapters) else lastprint-1
   sec=[]
   for sx,(sn,st,ss) in enumerate(sections):
    se=sections[sx+1][2]-1 if sx+1<len(sections) else end
    sec.append({'id':f'{bid}:{sn}','number':sn,'title':st,'optionalInContents':(bid,sn) in [('rja-compulsory-2','7.3'),('rja-selective-2','4.4')],'printedPageStart':ss,'printedPageEnd':se,'pdfPageStart':ss+offset,'pdfPageEnd':se+offset})
   nodes.append({'id':f'{bid}:{n}','number':n,'title':title,'printedPageStart':start,'printedPageEnd':end,'pdfPageStart':start+offset,'pdfPageEnd':end+offset,'sections':sec})
  counts={k:sum(p['textSource']==k for p in pages) for k in ['pdf_text_layer','legacy_ocr','paddle_ocr','missing_text_layer']}
  ocrJobs=[]
  for receiptPath in sorted(out.glob('*-job.json')):
   receipt=json.loads(receiptPath.read_text(encoding='utf8'))
   chunkPath=Path(str(receiptPath).replace('-job.json','.pdf'))
   if not chunkPath.exists():continue
   used=sum(p.get('ocrJobId')==receipt['jobId'] for p in pages)
   ocrJobs.append({**receipt,'inputPath':chunkPath.relative_to(ROOT).as_posix(),'inputSha256':digest(chunkPath.read_bytes()),'inputTransform':'source_pdf_render_144dpi_jpeg95_image_pdf' if chunkPath.name.startswith('raster-') else 'lossless_pdf_page_subset','usedPageCount':used,'state':'completed_and_imported' if used else 'superseded_after_provider_failure','localRawResultPath':str(receiptPath).replace('-job.json','-result.jsonl').replace(str(ROOT)+'\\','').replace('\\','/') if used else None})
  pending=sum((p['textSource']=='missing_text_layer' or p['textCharacters']==0) and p['printedPage'] is not None for p in pages)
  notes=['Extraction completion does not mean mathematical formula, figure, or knowledge mapping verification.','Section end pages include intervening exercises and review material until the next section; these are coverage ranges, not claim boundaries.']
  if bid=='rja-compulsory-1':notes.append('Legacy OCR skipped physical blank pages 268 and 269: legacy OCR page 268 is the source PDF back cover at physical page 270. Body pages 8 through 267 retain their physical coordinates; the back-cover remap was visually checked.')
  books.append({'id':bid,'title':f'普通高中教科书 数学（A版）{volume}','volume':volume,'publisher':'人民教育出版社','editionYear':None,'editionYearNote':'本地电子教材版权页未标明版次年份，未据旧库2019推定本文件版次','source':{'path':src['path'],'sha256':src['sha256'],'pageCount':len(doc),'byteSize':src['bytes']},'printedPageOffset':offset,'bodyPrintedPageRange':[1,lastprint-1],'appendixPrintedPageRange':[lastprint,printedMax],'tocVerification':{'status':'visually_checked','pdfPages':toc,'titlePage':2,'copyrightPage':3,'checkedAt':'2026-10-11','scope':'chapter and numbered section headings; reading/exploration/project entries are not independent sections'},'processing':{'status':'body_ocr_pending' if pending else 'body_text_extracted_unverified','textLayerPages':counts['pdf_text_layer'],'legacyOcrPages':counts['legacy_ocr'],'newOcrPages':counts['paddle_ocr'],'ocrPendingPages':pending,'nonBodyPagesWithoutText':counts['missing_text_layer']-pending,'reviewStatus':'unverified','notes':notes},'ocrJobs':ocrJobs,'chapters':nodes,'pages':pages})
 result={'schemaVersion':1,'observedAt':'2026-10-11','pageNumberConvention':'All pdfPage values are one-based physical PDF pages; printedPage is nullable.','books':books}
 target=ROOT/'data/curriculum/textbooks.json';target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
 print(json.dumps([{'id':b['id'],'chapters':len(b['chapters']),'sections':sum(len(c['sections']) for c in b['chapters']),**b['processing']} for b in books],ensure_ascii=False))

if __name__=='__main__':main()

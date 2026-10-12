from pathlib import Path
import json,fitz
from PIL import Image,ImageDraw
root=Path(__file__).parent
items=json.loads((root/'source-inventory.json').read_text(encoding='utf-8'))['items'][:25]
out=Path('C:/Users/mrzys/AppData/Local/Temp/tutor-set-transcription-a');out.mkdir(exist_ok=True)
answer_locations=[]
for start in range(0,25,5):
    sheet=Image.new('RGB',(1300,2000),'#ddd');draw=ImageDraw.Draw(sheet)
    answers=Image.new('RGB',(1300,2000),'#ddd');adraw=ImageDraw.Draw(answers)
    for j,item in enumerate(items[start:start+5]):
        with fitz.open(item['sourceFile']) as doc:
            p=doc[item['sourcePage']-1];hit=p.search_for('集合')[0]
            width=p.rect.width/2 if p.rect.width>p.rect.height else p.rect.width
            clip=fitz.Rect(0,max(0,hit.y0-20),width,min(p.rect.height,hit.y0+220))
            pix=p.get_pixmap(matrix=fitz.Matrix(2,2),clip=clip)
            im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples);im.thumbnail((1280,375))
            sheet.paste(im,(0,j*400+25));draw.text((5,j*400+5),item['id']+' SOURCE',fill='#000')
        source_answers=item['answerAvailability']['sourceAnswerSectionPages']
        companion=item['answerAvailability']['companionFiles']
        if item['discoveryIndex']==14: companion=[p for p in companion if '开学' in p]
        elif item['discoveryIndex']==13: companion=[p for p in companion if '二诊' in p]
        afile=companion[0] if companion else item['sourceFile'] if source_answers else None
        page=source_answers[0] if not companion and source_answers else 1
        if afile:
            with fitz.open(afile) as doc:
                p=doc[page-1];width=p.rect.width/2 if p.rect.width>p.rect.height else p.rect.width
                clip=fitz.Rect(0,0,width,min(p.rect.height,400))
                pix=p.get_pixmap(matrix=fitz.Matrix(2,2),clip=clip)
                im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples);im.thumbnail((1280,375))
                answers.paste(im,(0,j*400+25));adraw.text((5,j*400+5),item['id']+' ANSWER p'+str(page),fill='#000')
                (out/(item['id']+'-answer.txt')).write_text(p.get_text(),encoding='utf-8')
            answer_locations.append({'id':item['id'],'sourceFile':afile,'pages':[page]})
    sheet.save(out/f'sources-{start+1:03}.png');answers.save(out/f'answers-{start+1:03}.png')
(out/'answer-locations.json').write_text(json.dumps(answer_locations,ensure_ascii=False,indent=2),encoding='utf-8')
print(out)

from pathlib import Path
import fitz,json
from PIL import Image,ImageDraw
fitz.TOOLS.mupdf_display_errors(False)
fitz.TOOLS.mupdf_display_warnings(False)
a=json.loads((Path(__file__).parent/'discovery-pages.json').read_text(encoding='utf-8'))
out=Path('C:/Users/mrzys/AppData/Local/Temp/tutor-set-source-discovery')
out.mkdir(exist_ok=True)
for start in range(0,100,10):
    sheet=Image.new('RGB',(1800,5*300),'#ddd')
    d=ImageDraw.Draw(sheet)
    for j,x in enumerate(a[start:start+10]):
        with fitz.open(x['file']) as pdf:
            page=pdf[x['page']-1]
            hits=page.search_for('集合')
            y=hits[0].y0 if hits else 0
            clip=fitz.Rect(0,max(0,y-25),page.rect.width,min(page.rect.height,y+180))
            pix=page.get_pixmap(matrix=fitz.Matrix(2,2),clip=clip)
            im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
            im.thumbnail((880,275))
            col=j%2; row=j//2
            sheet.paste(im,(col*900,row*300+22))
            d.text((col*900+5,row*300+5),f'Index {start+j} / p{x["page"]}',fill='#000')
    sheet.save(out/f'clips-{start:03}.png')
print(out)

"""Render a deliberately projected, frozen paper; never read the live question bank."""
import base64
import copy
import io
import json
import os
from pathlib import Path
import re
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Flowable, Spacer, KeepTogether, Image, PageBreak, Table, TableStyle
from reportlab.graphics import renderPDF
from reportlab.graphics.shapes import Group, String
import reportlab
from svglib.svglib import svg2rlg
from svglib.fonts import register_font

FONT = 'TutorCJK'
font_candidates = [os.environ.get('TUTOR_CJK_FONT'), 'C:/Windows/Fonts/simsun.ttc', 'C:/Windows/Fonts/simhei.ttf', '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf']
font_path = next((p for p in font_candidates if p and Path(p).is_file()), None)
if not font_path:
    raise RuntimeError('缺少中文 TrueType 字体，请设置 TUTOR_CJK_FONT')
pdfmetrics.registerFont(TTFont(FONT, font_path))
register_font(FONT, font_path, rlgFontName=FONT)
BOLD = 'ExamHeading'
bold_path = 'C:/Windows/Fonts/simhei.ttf'
pdfmetrics.registerFont(TTFont(BOLD, bold_path if Path(bold_path).is_file() else font_path))

# Linux CJK fallback fonts can deliberately omit all Latin glyphs. Embed separate
# faces and use the same glyph runs for both measuring and painting every string.
reportlab_fonts = Path(reportlab.__file__).parent / 'fonts'
def register_fallback(name, candidates):
    source = next((str(p) for p in candidates if p and Path(p).is_file()), None)
    if source:
        pdfmetrics.registerFont(TTFont(name, source))
        return name
    return None

LATIN = register_fallback('TutorLatin', [os.environ.get('TUTOR_LATIN_FONT'),
    'C:/Windows/Fonts/times.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', reportlab_fonts / 'Vera.ttf'])
LATIN_BOLD = register_fallback('TutorLatinBold', ['C:/Windows/Fonts/timesbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', reportlab_fonts / 'VeraBd.ttf'])
SYMBOL = register_fallback('TutorSymbols', [os.environ.get('TUTOR_SYMBOL_FONT'),
    'C:/Windows/Fonts/seguisym.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'])

def font_runs(text, preferred=FONT):
    runs = []
    candidates = list(dict.fromkeys(f for f in [preferred, LATIN_BOLD if preferred == BOLD else LATIN, SYMBOL, FONT] if f))
    for character in text:
        if character == '\n':
            continue
        face = next((f for f in candidates if pdfmetrics.getFont(f).face.charToGlyph.get(ord(character), 0)), None)
        if face is None:
            raise RuntimeError(f'PDF 字体缺少字符 U+{ord(character):04X}（{character}），请补充字体')
        if runs and runs[-1][1] == face:
            runs[-1] = (runs[-1][0] + character, face)
        else:
            runs.append((character, face))
    return runs

def text_width(text, preferred, size):
    return sum(pdfmetrics.stringWidth(run, face, size) for run, face in font_runs(text, preferred))

def draw_text(canvas, x, y, text, preferred, size):
    for run, face in font_runs(text, preferred):
        canvas.setFont(face, size)
        canvas.drawString(x, y, run)
        x += pdfmetrics.stringWidth(run, face, size)

def fallback_svg_text(group):
    # MathJax uses paths for math but SVG text for \text{...}; it needs the same
    # fallback for mixed Chinese/Latin text as ordinary question content.
    for index, item in enumerate(group.contents):
        if isinstance(item, String):
            runs = font_runs(item.text)
            replacement = Group()
            width = text_width(item.text, FONT, item.fontSize)
            x = item.x - (width / 2 if item.textAnchor == 'middle' else width if item.textAnchor == 'end' else 0)
            for run, face in runs:
                segment = copy.copy(item)
                segment.text, segment.fontName, segment.x, segment.textAnchor = run, face, x, 'start'
                replacement.add(segment)
                x += pdfmetrics.stringWidth(run, face, item.fontSize)
            group.contents[index] = replacement
        elif isinstance(item, Group):
            fallback_svg_text(item)

class RichText(Flowable):
    """Chinese wrapping plus vector TeX; formulas are indivisible line boxes."""
    def __init__(self, text, formulas, size=10.5, color=colors.black, gap=5, align='left', bold=False):
        super().__init__()
        self.text = str(text).replace('\t', '    ')
        self.formulas = formulas
        self.size = size
        self.color = color
        self.gap = gap
        self.spaceAfter = gap
        self.align = align
        self.font = BOLD if bold else FONT

    def wrap(self, width, height):
        tokens = []
        offset = 0
        for match in re.finditer(r'\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$', self.text):
            tokens.extend(('text', x) for x in re.findall(r'[A-Za-z0-9_]+|.', self.text[offset:match.start()], re.S))
            tex = match.group(1) or match.group(2)
            svg = re.sub(r'font-family="[^"]*"', 'font-family="TutorCJK"', self.formulas[tex])
            drawing = svg2rlg(io.BytesIO(svg.encode('utf-8')))
            fallback_svg_text(drawing)
            factor = self.size / 11
            if drawing.width * factor > width:
                factor = width / drawing.width
            drawing.scale(factor, factor)
            drawing.width *= factor
            drawing.height *= factor
            tokens.append(('math', drawing))
            offset = match.end()
        tokens.extend(('text', x) for x in re.findall(r'[A-Za-z0-9_]+|.', self.text[offset:], re.S))
        joined = []
        for kind, value in tokens:
            if kind == 'text' and value in '。，；：！？、）)]' and joined and joined[-1][0] == 'text':
                joined[-1] = ('text', joined[-1][1] + value)
            else:
                joined.append((kind, value))
        tokens = joined
        lines = []
        line = []
        used = 0
        high = self.size * 1.65
        for kind, value in tokens:
            tw = text_width(value, self.font, self.size) if kind == 'text' else value.width
            th = self.size * 1.65 if kind == 'text' else max(self.size * 1.65, value.height + 4)
            closing = kind == 'text' and value in '。，；：！？、）)]'
            if (kind == 'text' and value == '\n') or (used + tw > width and line and not closing):
                lines.append((line, high))
                line, used, high = [], 0, self.size * 1.65
                if kind == 'text' and value == '\n':
                    continue
            line.append((kind, value, tw))
            used += tw
            high = max(high, th)
        if line:
            lines.append((line, high))
        self.lines = lines
        self.width = width
        self.height = sum(h for _, h in lines)
        return width, self.height

    def split(self, width, height):
        self.wrap(width, height)
        fit = 0
        used = 0
        for _, h in self.lines:
            if used + h > height:
                break
            fit += 1
            used += h
        if fit < 2 or len(self.lines) - fit < 2:
            return []
        a = RichLines(self.lines[:fit], self.size, self.color)
        b = RichLines(self.lines[fit:], self.size, self.color)
        a.align = b.align = self.align
        a.font = b.font = self.font
        return [a, b]

    def draw(self):
        self.canv.setFillColor(self.color)
        y = self.height
        for line, high in self.lines:
            y -= high
            x = (self.width - sum(tw for _, _, tw in line)) / 2 if self.align == 'center' else 0
            for kind, value, tw in line:
                if kind == 'text':
                    draw_text(self.canv, x, y + (high - self.size) / 2 + 1, value, self.font, self.size)
                else:
                    renderPDF.draw(value, self.canv, x, y + (high - value.height) / 2)
                x += tw

class RichLines(RichText):
    def __init__(self, lines, size, color):
        Flowable.__init__(self)
        self.lines, self.size, self.color = lines, size, color
        self.spaceAfter = 5
        self.align, self.font = 'left', FONT
    def wrap(self, width, height):
        self.width, self.height = width, sum(h for _, h in self.lines)
        return self.width, self.height

class ChoiceGrid(Flowable):
    """Measure actual text/vector formula widths before choosing 4, 2 or 1 columns."""
    def __init__(self, options, formulas):
        super().__init__()
        self.items = [RichText(f"{o['label']}. {o['text']}", formulas, gap=0) for o in options]
        self.spaceAfter = 6

    def wrap(self, width, height):
        natural = []
        for item in self.items:
            item.wrap(100000, height)
            natural.append(max((sum(tw for _, _, tw in line) for line, _ in item.lines), default=0))
        self.columns = next((n for n in (4, 2, 1) if n <= len(self.items)
                             and max(natural, default=0) <= (width - (n-1)*16)/n), 1)
        cell = (width - (self.columns-1)*16)/self.columns
        self.rows = []
        for start in range(0, len(self.items), self.columns):
            row = self.items[start:start+self.columns]
            row_height = max(item.wrap(cell, height)[1] for item in row)
            self.rows.append((row, row_height))
        self.width, self.height, self.cell = width, sum(h+7 for _, h in self.rows), cell
        return width, self.height

    def draw(self):
        y = self.height
        for row, height in self.rows:
            y -= height
            for col, item in enumerate(row):
                item.drawOn(self.canv, col*(self.cell+16), y+height-item.height)
            y -= 7


def rich_table(rows, formulas, width, size=10.5):
    """Render safe, shared-parser cells, retaining imported row/column spans."""
    occupied, placements, columns = set(), [], 0
    for row_index, row in enumerate(rows):
        column = 0
        for cell in row:
            col_span = max(1, min(20, int(cell.get('colSpan', 1))))
            row_span = max(1, min(20, len(rows)-row_index, int(cell.get('rowSpan', 1))))
            while any((row_index, column+offset) in occupied for offset in range(col_span)):
                column += 1
            placements.append((row_index, column, row_span, col_span, cell))
            occupied.update((r, c) for r in range(row_index, row_index+row_span)
                            for c in range(column, column+col_span))
            column += col_span
            columns = max(columns, column)
    if not columns:
        return None
    data = [['']*columns for _ in rows]
    styles = [('GRID',(0,0),(-1,-1),0.45,colors.black),
              ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
              ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]
    for row, column, row_span, col_span, cell in placements:
        data[row][column] = RichText(cell.get('text', ''), formulas, size=size-0.5,
                                     gap=0, bold=bool(cell.get('header')))
        if row_span > 1 or col_span > 1:
            styles.append(('SPAN',(column,row),(column+col_span-1,row+row_span-1)))
    headers = 0
    for row in rows:
        if not all(cell.get('header') for cell in row):
            break
        headers += 1
    # A spanning header cannot be repeated separately from the rows it joins.
    if any(row < headers <= row+row_span-1 for row, _, row_span, _, _ in placements):
        headers = 0
    table = Table(data, colWidths=[width/columns]*columns, repeatRows=headers,
                  hAlign='LEFT', splitInRow=1)
    table.setStyle(TableStyle(styles))
    table.spaceAfter = 8
    return table


def main():
    model = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output, formulas = sys.argv[2], model['formulas']
    teacher = model['kind'] == 'teacher'
    scored = model.get('scoringMode') != 'none'
    title = model['title']
    width = A4[0] - 104
    story = []
    def rich(text, size=10.5, **kw):
        return RichText(text, formulas, size=size, **kw)
    def add(text, size=10.5, **kw):
        story.append(rich(text, size, **kw))
    def content(text, size=10.5, available_width=None, prefix='', suffix=''):
        # Exactly the same pure parser as browser preview supplies these blocks;
        # imported HTML is data, never interpreted as executable markup.
        blocks = model.get('richTextBlocks', {}).get(str(text), [{'type':'text','text':str(text)}])
        result = []
        for index, block in enumerate(blocks):
            leading = prefix if index == 0 else ''
            trailing = suffix if index == len(blocks)-1 else ''
            if block['type'] == 'text':
                result.append(rich(leading+block['text']+trailing, size))
            else:
                if leading:
                    result.append(rich(leading, size))
                table = rich_table(block['rows'], formulas, available_width or width-26, size)
                if table is not None:
                    result.append(table)
                if trailing:
                    result.append(rich(trailing, size))
        return result

    add(title, 18, align='center', bold=True, gap=8)
    add('参考答案与解析' if teacher else '数学试卷', 12, align='center', gap=9)
    add(f"考试时间：{model['durationMinutes']} 分钟    共 {model['questionCount']} 题" +
        (f"    满分：{model['points']} 分" if scored else ''), 10, align='center', gap=12)
    if not teacher:
        add('姓名：____________    班级：____________    考号：________________', 10, align='center', gap=12)
        add('注意事项：请认真审题，选择题选出正确选项，解答题写出必要的解题过程。', 9, gap=12)
    if any(s['missing'] for s in model['slots']):
        add(f"【未完整卷】计划 {model['plannedQuestions']} 题，缺题位置保留题号" + ('，不计入满分。' if scored else '。'), 9, bold=True)
    if teacher and model['status'] == 'incomplete':
        add('部分参考材料待补充，详见对应题目提示。', 9, gap=10)
    type_labels = {'single_choice':'单项选择题','multiple_choice':'多项选择题','fill_blank':'填空题','free_response':'解答题'}
    numerals = ['一','二','三','四','五','六','七','八','九','十']
    if teacher:
        if scored:
            add('评分说明：分值按本卷题位设置，评分参考请结合本卷赋分使用。',9,gap=10)
        add('答案速查', 12, bold=True, gap=9)
        cells = []
        for slot in model['slots']:
            if slot['missing']:
                answer = '题面缺失'
            elif slot['questionType'] == 'free_response':
                answer = '见详解'
            else:
                answers = slot.get('teacher',{}).get('answers',[])
                answer = '；'.join(item.get('text','') for item in answers) or '待补充'
                if len(answer) > 80 or '\n' in answer or any(block['type'] == 'table' for block in model.get('richTextBlocks', {}).get(answer, [])):
                    answer = '见详解'
            cells.append(rich(f"{slot['number']}. {answer}", 9.5, gap=0))
        grid = Table([cells[i:i+2]+['']*(2-len(cells[i:i+2])) for i in range(0,len(cells),2)], colWidths=[width/2]*2, hAlign='LEFT')
        grid.setStyle(TableStyle([('BOX',(0,0),(-1,-1),0.5,colors.black),('INNERGRID',(0,0),(-1,-1),0.3,colors.black),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
        story.extend([grid, Spacer(1,16)])
        add('试题与解析', 12, bold=True, gap=12)

    # Frozen order is authoritative; no renderer may silently reorder confirmed papers.
    groups = []
    for slot in model['slots']:
        if not groups or groups[-1][0] != slot['questionType']:
            groups.append((slot['questionType'], []))
        groups[-1][1].append(slot)
    for group_index, (question_type, slots) in enumerate(groups):
        group_points = sum(s['points'] for s in slots if not s['missing'])
        number = numerals[group_index] if group_index < len(numerals) else str(group_index+1)
        heading = rich(f"{number}、{type_labels.get(question_type,question_type)}（共 {len(slots)} 小题"+
                       (f"，共 {group_points} 分）" if scored else '）'), 11.5, bold=True, gap=9)
        heading.keepWithNext = True
        section_intro = [heading]
        if question_type == 'single_choice':
            note = rich('每小题只有一个选项符合题意。', 9, gap=9)
            note.keepWithNext = True; section_intro.append(note)
        for slot in slots:
            question_start = len(story)
            if slot['missing']:
                story.append(KeepTogether([*section_intro,rich(f"{slot['number']}. 【题面缺失，此题位留空】", bold=True), Spacer(1,24)]))
                section_intro = []
                continue
            student = slot['student']
            stem_items = content(student['stem'],available_width=width-23-(52 if scored else 0))
            first = stem_items.pop(0) if stem_items else rich('')
            score = rich(f"（{slot['points']} 分）", 9, gap=0) if scored else ''
            # Number and stem share a row; the score has its own fixed gutter.
            row = Table([[rich(f"{slot['number']}.", 10.5, gap=0, bold=True), first, score]],
                        colWidths=[23,width-23-(52 if scored else 0),52 if scored else 0], hAlign='LEFT', splitInRow=1)
            row.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
            question = [*section_intro,row, *stem_items]
            if slot.get('sourceCaption'):
                question.append(rich(slot['sourceCaption'], 8, gap=5))
            section_intro = []
            for asset in student['assets']:
                frozen = next((a for a in model['assets'] if a['slotId'] == slot['slotId'] and a['assetId'] == asset['assetId']), None)
                if not frozen:
                    raise RuntimeError(f"第 {slot['number']} 题冻结图片缺失")
                image = Image(io.BytesIO(base64.b64decode(frozen['dataBase64'])))
                factor = min(1, min(width-26,320)/image.imageWidth, 180/image.imageHeight)
                image.drawWidth, image.drawHeight = image.imageWidth*factor,image.imageHeight*factor
                image.hAlign = 'CENTER'; image.spaceAfter = 7; question.append(image)
            if student['options']:
                if any(option['text'] in model.get('richTextBlocks', {}) for option in student['options']):
                    for option in student['options']:
                        question.extend(content(option['text'], prefix=f"{option['label']}. "))
                else:
                    question.append(ChoiceGrid(student['options'], formulas))
            if not teacher and student['parts']:
                for index, part in enumerate(student['parts']):
                    points = next((p['points'] for p in slot['partPoints'] if p['partId']==part['partId']),None)
                    suffix = f"（{points} 分）" if scored and points is not None else ''
                    question.extend([*content(part['prompt'], prefix=f"（{index+1}）", suffix=suffix),Spacer(1,100 if len(student['parts'])>1 else 150)])
                # A normal two-part problem stays on one page. Oversized problems may
                # split at flowable boundaries instead of overflowing the A4 frame.
                story.append(KeepTogether(question))
            else:
                for index,part in enumerate(student['parts']):
                    question.extend(content(part['prompt'], prefix=f"（{index+1}）"))
                question.append(Spacer(1,13 if student['options'] else 24))
                story.extend(question) if teacher else story.append(KeepTogether(question))
            if not teacher:
                continue
            if slot.get('diagnosticFocus'):
                add('考查重点：' + slot['diagnosticFocus'], 9.5, gap=8)
            material = slot.get('teacher',{})
            for key,label in [('answers','参考答案'),('solutions','解析'),('scoringSuggestions','评分参考')]:
                if key == 'scoringSuggestions' and not scored:
                    continue
                items = material.get(key,[])
                if key == 'scoringSuggestions':
                    # Only this known system disclaimer is consolidated above. Keep
                    # any question-specific suffix and all original solutions intact.
                    boilerplate = '仅引用本次标杆的建议赋分，非原卷评分，也不是题目固定分值；新草稿另设题位分值。'
                    items = [{**item,'text':item.get('text','').removeprefix(boilerplate).strip()} for item in items]
                    items = [item for item in items if item['text']]
                if not items:
                    if key != 'scoringSuggestions':
                        add(f"【{label}待补充】",9)
                    continue
                label_item = rich(label,9.5,bold=True,gap=4)
                label_item.keepWithNext = True; story.append(label_item)
                for item in items:
                    part_id = item.get('partId','main')
                    prefix = f"（{part_id.removeprefix('p')}）" if part_id != 'main' else ''
                    story.extend(content(item.get('text','【内容待补充】'),10,prefix=prefix))
            story.append(Spacer(1,12))
            story[question_start:] = [KeepTogether(story[question_start:])]

    page_count = 0
    def page(canvas,doc):
        nonlocal page_count
        page_count = doc.page
        canvas.saveState()
        canvas.setFillColor(colors.black)
        if doc.page > 1:
            short_title = title if len(title)<=36 else title[:35]+'…'
            draw_text(canvas,52,A4[1]-27,short_title+(' · 参考答案与解析' if teacher else ''),FONT,8)
            canvas.setLineWidth(.35);canvas.line(52,A4[1]-33,A4[0]-52,A4[1]-33)
        footer = f"第 {doc.page} 页"
        draw_text(canvas,(A4[0]-text_width(footer,FONT,8))/2,23,footer,FONT,8)
        canvas.restoreState()
    while story and isinstance(story[-1], Spacer):
        story.pop()
    doc = SimpleDocTemplate(output,pagesize=A4,rightMargin=52,leftMargin=52,topMargin=48,bottomMargin=44,
                            title=title+(' - 参考答案与解析' if teacher else ' - 学生试卷'),author='智教',pageCompression=1)
    doc.build(story,onFirstPage=page,onLaterPages=page)
    print(json.dumps({'pages':page_count},ensure_ascii=False))

if __name__ == '__main__':
    main()

"""Render a deliberately projected, frozen paper; never read the live question bank."""
import base64
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
from reportlab.platypus import SimpleDocTemplate, Flowable, Spacer, KeepTogether, Image, PageBreak
from reportlab.graphics import renderPDF
from svglib.svglib import svg2rlg
from svglib.fonts import register_font

FONT = 'TutorCJK'
font_candidates = [os.environ.get('TUTOR_CJK_FONT'), 'C:/Windows/Fonts/simhei.ttf', '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf']
font_path = next((p for p in font_candidates if p and Path(p).is_file()), None)
if not font_path:
    raise RuntimeError('缺少中文 TrueType 字体，请设置 TUTOR_CJK_FONT')
pdfmetrics.registerFont(TTFont(FONT, font_path))
register_font(FONT, font_path, rlgFontName=FONT)

class RichText(Flowable):
    """Chinese wrapping plus vector TeX; formulas are indivisible line boxes."""
    def __init__(self, text, formulas, size=10.5, color=colors.HexColor('#20262c'), gap=5):
        super().__init__()
        self.text = str(text)
        self.formulas = formulas
        self.size = size
        self.color = color
        self.gap = gap
        self.spaceAfter = gap

    def wrap(self, width, height):
        tokens = []
        offset = 0
        for match in re.finditer(r'\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$', self.text):
            tokens.extend(('text', x) for x in re.findall(r'[A-Za-z0-9_]+|.', self.text[offset:match.start()], re.S))
            tex = match.group(1) or match.group(2)
            svg = re.sub(r'font-family="[^"]*"', 'font-family="TutorCJK"', self.formulas[tex])
            drawing = svg2rlg(io.BytesIO(svg.encode('utf-8')))
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
            tw = pdfmetrics.stringWidth(value, FONT, self.size) if kind == 'text' else value.width
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
        return [a, b]

    def draw(self):
        self.canv.setFont(FONT, self.size)
        self.canv.setFillColor(self.color)
        y = self.height
        for line, high in self.lines:
            y -= high
            x = 0
            for kind, value, tw in line:
                if kind == 'text':
                    self.canv.drawString(x, y + (high - self.size) / 2 + 1, value)
                else:
                    renderPDF.draw(value, self.canv, x, y + (high - value.height) / 2)
                x += tw

class RichLines(RichText):
    def __init__(self, lines, size, color):
        Flowable.__init__(self)
        self.lines, self.size, self.color = lines, size, color
        self.spaceAfter = 5
    def wrap(self, width, height):
        self.width, self.height = width, sum(h for _, h in self.lines)
        return self.width, self.height

def main():
    model = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = sys.argv[2]
    formulas = model['formulas']
    kind = model['kind']
    teacher = kind == 'teacher'
    story = []
    def issue_text(issue):
        if isinstance(issue, str):
            return issue
        number = issue.get('number')
        part = issue.get('partId', 'main')
        location = f"第 {number} 题" if number else ''
        if part != 'main':
            location += f"（小问 {part.removeprefix('p')}）"
        message = issue.get('message') or issue.get('reason') or '；'.join(issue.get('reasons', [])) or '资料待确认'
        return (location + '：' if location else '') + message
    def rich(text, size=10.5, **kw):
        return RichText(text, formulas, size=size, **kw)
    def add(text, size=10.5, **kw):
        story.append(rich(text, size, **kw))
    title = model['title']
    add(title, 19)
    add('教师参考版' if teacher else '学生试卷', 12)
    add(f"考试时间：{model['durationMinutes']} 分钟    实际可用：{model['questionCount']} 题 / {model['points']} 分", 10.5)
    if any(s['missing'] for s in model['slots']):
        add(f"未完整卷：计划 {model['plannedQuestions']} 题 / {model['plannedPoints']} 分；缺题位置保留题号，不计入有效分值。", 10.5)
    if teacher and model['status'] == 'incomplete':
        add('教师材料未完整：' + '；'.join(model['issues']), 9)
    if not teacher:
        add('姓名：________________    班级：________________', 10.5)
    story.append(Spacer(1, 12))
    last_type = None
    type_labels = {'single_choice':'单项选择题','multiple_choice':'多项选择题','fill_blank':'填空题','free_response':'解答题'}
    labels = {'source':'原卷材料','source_adapted':'原卷整理增补','proposed':'建议评分','generated':'补充材料'}
    for slot in model['slots']:
        question_start = len(story)
        if slot['questionType'] != last_type:
            last_type = slot['questionType']
            heading = rich(type_labels.get(last_type,last_type), 13)
            heading.keepWithNext = True
            story.append(heading)
        header = rich(f"第 {slot['number']} 题（{slot['points']} 分）", 11.5)
        header.keepWithNext = True
        story.append(header)
        if slot['missing']:
            add('【题面缺失，此题位留空，不计入有效分值】')
            story.append(Spacer(1, 24))
            continue
        student = slot['student']
        add(student['stem'])
        for option in student['options']:
            add(f"{option['label']}. {option['text']}")
        for asset in student['assets']:
            frozen = next((a for a in model['assets'] if a['slotId'] == slot['slotId'] and a['assetId'] == asset['assetId']), None)
            if not frozen:
                raise RuntimeError(f"第 {slot['number']} 题冻结图片缺失")
            image = Image(io.BytesIO(base64.b64decode(frozen['dataBase64'])))
            factor = min(1, 470/image.imageWidth, 240/image.imageHeight)
            image.drawWidth, image.drawHeight = image.imageWidth*factor, image.imageHeight*factor
            story.append(image)
        for i, part in enumerate(student['parts']):
            point = next((x['points'] for x in slot['partPoints'] if x['partId'] == part['partId']), None)
            add(f"（{i+1}）{part['prompt']}" + (f"（{point} 分）" if point is not None else ''))
            if not teacher:
                story.append(Spacer(1, 60))
        if not teacher:
            story.append(Spacer(1, 22 if student['options'] else 26))
            story[question_start:] = [KeepTogether(story[question_start:])]
            continue
        material = slot['teacher']
        story[question_start:] = [KeepTogether(story[question_start:])]
        add(f"本卷赋分：{slot['points']} 分" + ('；小问 ' + '、'.join(f"{i+1}：{p['points']} 分" for i,p in enumerate(slot['partPoints'])) if slot['partPoints'] else ''), 9)
        for key, label in [('answers','参考答案'),('solutions','参考解析'),('scoringSuggestions','评分建议')]:
            items = material.get(key, [])
            if not items:
                add(f"【{label}缺失】", 9)
            for item in items:
                provenance = item.get('provenance','unknown')
                material_heading = rich(f"【{labels.get(provenance,'来源未知')} · {label} · {item.get('partId','main')}】", 9)
                material_heading.keepWithNext = True
                story.append(material_heading)
                add(item.get('text','【内容缺失】'))
        add('建议评分仅为材料参考，未自动套用于本卷赋分；请按本卷题位和小问分值确认评分。', 9)
        refs = '；'.join(f"{r.get('sourceId','未知来源')} 第 {','.join(str(p) for p in r.get('pages',[]))} 页" for r in slot['sourceRefs'])
        add('来源：' + (refs or '缺失'), 8)
        v = slot['versions']
        add(f"版本：{v['questionId']} / {v['contentVersion']} / {v['teacherVersion']}", 7.5)
        story.append(Spacer(1, 15))
    if teacher:
        summary = model.get('summary', {})
        if summary.get('unknown') or summary.get('scoringIssues') or summary.get('teacher',{}).get('issues'):
            story.append(PageBreak())
            add('输出前确认记录', 13)
            for category,label in [('unknown','范围证据'),('scoringIssues','赋分检查')]:
                for issue in summary.get(category,[]):
                    add(f"{label}：" + issue_text(issue), 9)
            for issue in summary.get('teacher',{}).get('issues',[]):
                add('教师材料：' + issue_text(issue),9)
    page_count = 0
    def page(canvas, doc):
        nonlocal page_count
        page_count = doc.page
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor('#d8dde1'))
        canvas.line(45, A4[1]-35, A4[0]-45, A4[1]-35)
        canvas.setFillColor(colors.HexColor('#66717a'))
        canvas.setFont(FONT,8)
        canvas.drawString(45, A4[1]-27, 'Tutor · ' + ('教师参考版' if teacher else '学生试卷'))
        canvas.drawRightString(A4[0]-45,22,f"第 {doc.page} 页")
        canvas.drawString(45,22,model['paperId'])
        canvas.restoreState()
    doc = SimpleDocTemplate(output,pagesize=A4,rightMargin=45,leftMargin=45,topMargin=48,bottomMargin=40,title=title,author='Tutor',pageCompression=1)
    doc.build(story,onFirstPage=page,onLaterPages=page)
    print(json.dumps({'pages':page_count},ensure_ascii=False))

if __name__ == '__main__':
    main()

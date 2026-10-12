from pathlib import Path
import fitz,json,hashlib,re
HERE=Path(__file__).parent
pages=json.loads((HERE/'discovery-pages.json').read_text(encoding='utf-8'))
# Source-visual review on rendered source pages. This is a locator inventory,
# not a pedagogically reviewed or selectable question-bank import.
rows=[
(0,1,'有限集合与不等式集合的补集交集',['一次不等式']),
(1,1,'一次连不等式与二次方程根集的交集',['一次不等式','二次方程']),
(2,1,'整数平方条件集合与有限集合并集的元素个数',['整数范围','平方运算']),
(3,2,'开区间集合与补集的交集',[]),
(4,1,'开区间与自然数二次不等式集合的交集',['二次不等式']),
(5,1,'有限全集中补集与并集',[]),
(6,1,'二元集合真子集的个数',[]),
(7,1,'对数和绝对值限定集合的关系',['对数不等式','绝对值不等式']),
(8,1,'一次和二次不等式集合的交补运算',['一次不等式','二次不等式']),
(9,1,'绝对值与指数不等式集合的交集',['绝对值不等式','指数不等式']),
(10,1,'自然数有限集合与线性变换条件的交集',['一次方程']),
(11,2,'有序数对集合交集确定直线参数',['平面直角坐标系','一次函数']),
(12,1,'区间与乘积不等式解集求交集',['二次不等式']),
(13,1,'二次不等式定义域与根式值域集合的并集',['二次不等式','根式函数值域']),
(14,2,'一次不等式集合与有限集合的交集',['一次不等式']),
(15,1,'有限定义域二次函数像集与原集合交集',['二次函数求值']),
(16,1,'二次不等式和自然对数不等式集合交集',['二次不等式','对数不等式']),
(20,2,'有限集合与三次方程根集求交集',['三次方程因式分解']),
(21,1,'含参数有限集合并集的元素个数',['元素互异性','平方运算']),
(22,3,'对数与指数不等式集合的并集',['对数不等式','指数不等式']),
(23,1,'有限集合交集的元素个数',[]),
(24,1,'有限全集中并集的补集',[]),
(25,1,'整数全集中有限集合的补集',['整数范围']),
(26,1,'半开区间集合的交补运算',[]),
(27,1,'有限集合与自然数限定集合的并集',['自然数范围']),
(28,1,'三次不等式集合与有限集合的交集',['三次幂单调性']),
(29,2,'整数区间集合与根式函数定义域的交集',['根式函数定义域']),
(30,1,'闭区间与二次不等式集合的交集',['二次不等式']),
(31,1,'有限集合与区间并集补集的交集',[]),
(32,1,'自然数范围与对数不等式集合的交集',['对数不等式']),
(33,1,'列举集合与整数描述集合的相等关系',['整数范围']),
(34,1,'区间并集为全体实数时确定参数',['区间端点比较']),
(35,1,'对数函数定义域与整数二次不等式集合交集',['对数函数定义域','二次不等式']),
(37,3,'三角形类型集合之间的包含关系',['三角形分类','等腰三角形','等边三角形','直角三角形']),
(38,1,'整数整除条件描述集合与有限集合交集',['整除与整数']),
(39,1,'有限集合与绝对值不等式交集的真子集个数',['绝对值不等式','子集计数']),
(40,1,'区间集合与指数不等式解集的交集',['指数不等式']),
(41,1,'平方等式根集与整数限定集合的并集',['二次方程','整数范围']),
(42,2,'有限集合与开区间的交集',[]),
(43,1,'分式不等式解集与有限集合的交集',['分式不等式']),
(44,1,'整数绝对值条件集合与有限集合的并集',['绝对值不等式','整数范围']),
(45,1,'有限集合与半开区间集合的交集',[]),
(47,10,'按自反对称传递三条件判断集合上的等价关系',['新定义等价关系','向量共线','命题充要条件','方程同解']),
(48,1,'有限集合与开区间集合的交集',[]),
(49,1,'绝对值范围与自然数平方条件集合的交集',['绝对值不等式','平方不等式']),
(50,3,'含参数集合的包含关系与元素互异性',['二次方程','参数分类','元素互异性']),
(51,2,'满足双向包含约束的集合个数',['二次不等式','自然数范围','子集计数']),
(52,2,'对数限定集合与自然数平方条件集合的交集',['对数不等式','平方不等式']),
(53,2,'交集等于一集合的充要条件',['充要条件','集合关系']),
(55,1,'三集合交集与二次不等式条件',['二次不等式']),
]
fitz.TOOLS.mupdf_display_errors(False)
fitz.TOOLS.mupdf_display_warnings(False)
items=[]
for n,(idx,qno,topic,deps) in enumerate(rows,1):
    src=pages[idx]; file=Path(src['file'])
    with fitz.open(file) as pdf:
        page=pdf[src['page']-1]
        hits=page.search_for('集合')
        box=list(hits[0]) if hits else None
        source_answers=[]
        for pno,p in enumerate(pdf):
            text=p.get_text()
            if any(s in text for s in ['【答案】','参考答案','答案与解析','答案及解析']):
                source_answers.append(pno+1)
    companions=[]
    for other in file.parent.glob('*.pdf'):
        if other==file:continue
        if any(s in other.name for s in ['答案','解析','详解','教师','DA','细则']):
            companions.append(str(other))
    if idx==25:
        # The subject-organized directory omitted its answer PDF; the original
        # all-subject package still has an exact-title matching answer file.
        companions.extend(str(p) for p in Path('C:/baidunetdiskdownload/高--模拟题/★2026年4月').rglob('福州市2026届高中毕业班4月适应性练习 数学答案.pdf'))
    items.append({
      'id':f'SET-EXP50-{n:03}', 'discoveryIndex':idx,
      'sourceFile':str(file), 'sourceSha256':hashlib.sha256(file.read_bytes()).hexdigest(),
      'sourcePage':src['page'],'originalQuestionNumber':str(qno),
      'questionType':'multiple_choice' if idx==47 else 'single_choice',
      'setTopic':topic,'visibleDependencies':deps,
      'dependencyStatus':'source_visible_only_solution_path_not_reviewed',
      'scopePolicy':'keep_cross_chapter_and_enrichment_questions; evaluate_against_teacher_scope_later',
      'answerAvailability':{'status':'source_answer_section_located' if source_answers else ('companion_file_located' if companions else 'not_located'),
        'sourceAnswerSectionPages':source_answers,'companionFiles':companions,
        'verifiedQuestionAnswer':False},
      'visualVerification':{'status':'question_presence_and_set_topic_checked','sourcePageRendered':True,
        'locatorPhraseBoxPdfPoints':box,'contactSheet':f'clips-{idx//10*10:03}.png',
        'note':'Source formula extraction is not accepted as final transcription. Check the source page again when importing.'},
      'duplicateCheck':{'existingQuestionCount':45,'status':'source_question_visually_compared_to_existing_student_stems',
        'note':'No same mathematical statement found in current 45; similar topic/skill is allowed. Student/teacher duplicate of index54/55 collapsed to teacher index55; index17 duplicate of11 omitted.'},
      'isSelectableCandidate':False,
      'processingStatus':'source_located_requires_transcription_answer_and_solution_review',
    })
assert len(items)==50
assert len({(x['sourceSha256'],x['sourcePage'],x['originalQuestionNumber']) for x in items})==50
result={'schemaVersion':1,'purpose':'50 additional source-located set questions, not imported bank questions',
 'sourceRoot':'C:/baidunetdiskdownload/高--模拟题','selectionCount':len(items),
 'sourceMix':{'singleChoice':49,'multipleChoice':1,'freeResponse':0},
 'limitations':['This batch expands mostly choice-item supply; it does not solve free-response or calibrated difficulty coverage.',
  'Answer-section/file availability is a locator only; no answer has been accepted without subsequent per-question review.',
  'Cross-chapter/enrichment items are retained by user instruction and are not automatically eligible for an early chapter test.'],
 'excludedDiscoveryIndices':{'17':'same mathematical statement as index11','18':'paper report, not question','19':'incidental locus wording rather than set-focused task','36':'set phrase in scope heading; first crop not question','46':'set phrase in scope heading; first crop not question','54':'student duplicate of teacher index55'},
 'items':items}
(HERE/'source-inventory.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
from collections import Counter
print(json.dumps({'count':len(items),'answerLocators':dict(Counter(x['answerAvailability']['status'] for x in items))},ensure_ascii=False))

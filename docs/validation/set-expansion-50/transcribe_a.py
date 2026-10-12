"""Materialize hand-transcribed records checked against rendered source pages."""
from pathlib import Path
import json
HERE=Path(__file__).parent
inventory=json.loads((HERE/'source-inventory.json').read_text(encoding='utf-8'))['items'][:25]
answer_locations={x['id']:x for x in json.loads(Path('C:/Users/mrzys/AppData/Local/Temp/tutor-set-transcription-a/answer-locations.json').read_text(encoding='utf-8'))}
# Each tuple is stem, options A-D, answer. Keep the source's incorrect options
# in item 010; the independent answer is explicitly not a source answer.
records=[
(r'已知集合 $A=\{0,1,2,3,4\}$，$B=\{x\mid x\le2\}$，则 $A\cap(\complement_{\mathbb R}B)=$（　）。',
 [r'$\{0,1,2,3\}$',r'$\{0,1,2\}$',r'$\{2,3,4\}$',r'$\{3,4\}$'],'D'),
(r'已知集合 $A=\{x\mid1<2x-1<3\}$，$B=\{x\mid x^2-3=0\}$，则 $A\cap B=$（　）。',
 [r'$\{-\sqrt3,\sqrt3\}$',r'$\{\sqrt3\}$',r'$\{-\sqrt3\}$',r'$\varnothing$'],'B'),
(r'设 $A=\{x\in\mathbb Z\mid x^2<9\}$，$B=\{0,1,2,3\}$，则集合 $A\cup B$ 中元素的个数为（　）。',
 ['3','4','5','6'],'D'),
(r'已知集合 $A=\{x\mid0<x<2\}$，$B=\{x\mid1<x<3\}$，则 $A\cap\complement_{\mathbb R}B=$（　）。',
 [r'$(0,1]$',r'$(0,1)$',r'$(2,3)$',r'$(2,3]$'],'A'),
(r'已知集合 $A=\{x\mid-1<x<3\}$，$B=\{x\in\mathbb N\mid x^2-3x-4\le0\}$，则 $A\cap B=$（　）。',
 [r'$(-1,3)$',r'$[-1,3]$',r'$\{1,2\}$',r'$\{0,1,2\}$'],'D'),
(r'已知集合 $U=\{x\mid1<x<6,\ x\in\mathbb N\}$，$A=\{2,3\}$，$B=\{2,4,5\}$，则 $(\complement_U A)\cap B=$（　）。',
 [r'$\{4,5\}$',r'$\{2,3,4,5\}$',r'$\{2\}$',r'$\{2,4,5\}$'],'A'),
(r'已知集合 $A=\{1,3\}$，则集合 $A$ 的真子集有（　）。',
 ['3 个','4 个','5 个','6 个'],'A'),
(r'已知集合 $M=\{x\mid\ln x<0\}$，$N=\left\{x\mid|x+1|<\dfrac32\right\}$，则下列关系正确的是（　）。',
 [r'$M\cap N=\left(-\dfrac52,1\right)$',r'$M\cup N=(0,1)$',r'$M\cap N=\left(\dfrac12,1\right)$',r'$M\cap N=\left(0,\dfrac12\right)$'],'D'),
(r'已知集合 $A=\{x\mid2x-4>0\}$，$B=\{x\mid x^2-3x-4>0\}$，则 $A\cap\complement_{\mathbb R}B=$（　）。',
 [r'$\{x\mid-2<x<4\}$',r'$\{x\mid-2<x\le4\}$',r'$\{x\mid2<x<4\}$',r'$\{x\mid2<x\le4\}$'],'D'),
(r'已知集合 $A=\{x\mid|x|\le2\}$，$B=\{x\mid3^{x-1}<1\}$，则 $A\cap B=$（　）。',
 [r'$[-2,2]$',r'$[-2,1]$',r'$(-2,1)$',r'$(1,2)$'],r'$[-2,1)$（原四个选项均不对应此结果）'),
(r'若集合 $A=\{x\in\mathbb N\mid0\le x\le5\}$，$B=\{x\mid2x-1\in A\}$，则 $A\cap B=$（　）。',
 [r'$\{0,1,2\}$',r'$\{1,3,5\}$',r'$\{1,2,3\}$',r'$\{2,4,5\}$'],'C'),
(r'已知集合 $A=\{(x,y)\mid y=2ax\}$，$B=\{(x,y)\mid y=ax-b\}$，$A\cap B=\{(1,3)\}$，则 $b=$（　）。',
 [r'$-2$',r'$-\dfrac32$',r'$\dfrac12$',r'$1$'],'B'),
(r'已知集合 $A=\{x\mid-2<x\le1\}$，$B=\{x\mid(x+1)(x-2)<0\}$，则 $A\cap B=$（　）。',
 [r'$\{x\mid-2<x\le2\}$',r'$\{x\mid0<x<2\}$',r'$\{x\mid-1<x\le1\}$',r'$\{x\mid-1\le x<2\}$'],'C'),
(r'已知集合 $A=\{x\mid x^2-3x+2\le0\}$，$B=\{y\mid y=\sqrt{x-1},\ x\in A\}$，则 $A\cup B=$（　）。',
 [r'$[1,2]$',r'$[0,2]$',r'$[0,+\infty)$',r'$(-\infty,0]$'],'B'),
(r'已知集合 $M=\{x\mid3x+2\le8\}$，$N=\{0,1,2,3\}$，则 $M\cap N=$（　）。',
 [r'$\{0,1,2,3\}$',r'$\{0,1,2\}$',r'$\{1,2\}$',r'$\varnothing$'],'B'),
(r'已知集合 $M=\{-1,0,1\}$，$N=\{y\mid y=x^2-1,\ x\in M\}$，则 $M\cap N=$（　）。',
 [r'$\{-1,0,1\}$',r'$\{-1,0\}$',r'$\{0,1\}$',r'$\{-1,1\}$'],'B'),
(r'设集合 $A=\{x\mid x^2-2x-3\le0\}$，$B=\{x\mid\ln x\ge0\}$，则集合 $A\cap B=$（　）。',
 [r'$[1,3]$',r'$[0,3]$',r'$(0,3]$',r'$[-1,3]$'],'A'),
(r'已知集合 $A=\{-1,0,2,8\}$，$B=\{x\mid x^3=x\}$，则 $A\cap B=$（　）。',
 [r'$\{-1\}$',r'$\{0\}$',r'$\{-1,0\}$',r'$\{2,8\}$'],'C'),
(r'设集合 $A=\{-2,1,a\}$，$B=\{-1,a^2\}$，若 $A\cup B$ 含有 $4$ 个元素，则 $a=$（　）。',
 [r'$-1$',r'$0$',r'$1$',r'$2$'],'B'),
(r'已知集合 $A=\{x\mid\log_2x<1\}$，$B=\{x\mid1\le2^x\le4\}$，则 $A\cup B=$（　）。',
 [r'$(-\infty,2]$',r'$(-\infty,2)$',r'$(0,2)$',r'$[0,2]$'],'D'),
(r'设集合 $M=\{2,3,4\}$，$N=\{1,2,3\}$，则集合 $M\cap N$ 中的元素个数为（　）。',
 ['1','2','3','4'],'B'),
(r'已知集合 $U=\{1,2,3,4\}$，$A=\{1,2\}$，$B=\{1,4\}$，则 $\complement_U(A\cup B)=$（　）。',
 [r'$\{1\}$',r'$\{3\}$',r'$\{1,2,4\}$',r'$\{2,3,4\}$'],'B'),
(r'设全集 $U=\{x\mid0<x<6,\ x\in\mathbb Z\}$，集合 $A=\{1,2,3\}$，则 $\complement_U A=$（　）。',
 [r'$\{4,5\}$',r'$\{4,5,6\}$',r'$\{1,2,3\}$',r'$\{x\mid3<x<6\}$'],'A'),
(r'设集合 $A=\{x\mid x\ge2\}$，$B=\{x\mid1\le x\le4\}$，则 $B\cap(\complement_{\mathbb R}A)=$（　）。',
 [r'$\{x\mid1\le x<2\}$',r'$\{x\mid x\le4\}$',r'$\{x\mid2\le x\le4\}$',r'$\{x\mid x\ge0\}$'],'A'),
(r'已知集合 $A=\{-2,0,2,4\}$，$B=\{x\in\mathbb N\mid x<3\}$，则 $A\cup B=$（　）。',
 [r'$\{0,2\}$',r'$\{-2,0,2\}$',r'$\{-2,0,1,2,4\}$',r'$\{-2,0,1,2,3,4\}$'],'C'),
]
items=[]
for inv,(stem,opts,answer) in zip(inventory,records,strict=True):
    id=inv['id'];proposed=id in ['SET-EXP50-010','SET-EXP50-020']
    loc=answer_locations.get(id)
    if id=='SET-EXP50-006':loc={**loc,'pages':[6]}
    notes=['题面及四个选项经源 PDF 渲染核对；尚未教师复核，不作为已发布候选。',
           'requiredKnowledge 为题面可见的待映射知识名称，不代表完整已核准解法依赖。']
    if id=='SET-EXP50-002':notes.append('源题文件/页头标为 1 月考试，配套答案页头标为 12 月阶段调研；第 1 题题面及四项相同，保留标题不一致待复核。')
    if id=='SET-EXP50-003':notes.append('源文件名为扬州一模，配套答案页头为扬州市 2026 届高三上学期期末；本题题面及四项相同，保留标题不一致待复核。')
    if proposed:notes.append('未找到对应原答案；答案为独立数学解答提议，provenance=generated，需人工复核。')
    if id=='SET-EXP50-010':notes.extend([
        '原选项疑似错误：由指数函数单调性得 x<1，与 [-2,2] 求交集为 [-2,1)，四个原选项均不符。',
        '已再次放大源页确认 B 项右端为闭方括号 ]、C 项两端均为开括号；忠实保留原选项，未擅自更正或指定正确选项字母。'])
    if id=='SET-EXP50-020':notes.append('独立求解提议依据：log_2 x<1 得 0<x<2；1≤2^x≤4 得 0≤x≤2；并集 [0,2] 对应 D。')
    if id=='SET-EXP50-019':notes.extend([
        '源答 B（a=0）已核对，但原题未明写 A 含三个不同元素，不能将列出的三个符号自动当作三个不同值。',
        '反例：a=-2 时 A={-2,1}，B={-1,4}，并集 {-2,-1,1,4} 仍含四个元素。源答依赖未明写的基数前提，保留原题原答，不默认补条件。',
        '该源缺陷记录不计入有效新增题，由 SET-EXP50-055 替补。'])
    issues= ['original_options_no_correct_answer'] if id=='SET-EXP50-010' else ['unstated_cardinality_assumption'] if id=='SET-EXP50-019' else []
    items.append({'id':id,'questionType':inv['questionType'],
      'student':{'stem':stem,'options':[{'label':chr(65+i),'text':t} for i,t in enumerate(opts)],'parts':[],'assets':[]},
      'teacher':{'answers':[{'partId':'main','text':answer,'provenance':'generated' if proposed else 'source',
        'sourceFile':None if proposed else loc['sourceFile'],'pages':[] if proposed else loc['pages']}],'solutions':[]},
      'source':{'path':inv['sourceFile'],'sha256':inv['sourceSha256'],'pdfPage':inv['sourcePage'],'originalQuestionNumber':inv['originalQuestionNumber']},
      'setTopics':[inv['setTopic']],'requiredKnowledge':inv['visibleDependencies'],
      'verification':{'sourceVisualChecked':True,'answerStatus':'independent_proposed' if proposed else 'source_checked',
        'blockingIssues':issues,'sourceIssues':issues,'notes':notes},
      'reviewStatus':'pending_review'})
out=Path('data/question-bank/staging/set-expansion-50-001-025.json');out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({'schemaVersion':1,'items':items},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'{len(items)} records written; 23 source-checked answers; 2 independent proposals; 2 source defects; 23 valid pending-review items')

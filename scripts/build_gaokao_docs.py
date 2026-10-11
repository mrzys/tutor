# -*- coding: utf-8 -*-
import os, sys, re

sys.stdout.reconfigure(encoding='utf-8')
dir_path = r'c:\Users\mrzys\Codebase\tutor-v1\tmp\gaokao_extracted'
docs_out = r'c:\Users\mrzys\Codebase\tutor-v1\docs\gaokao-2025'
os.makedirs(docs_out, exist_ok=True)

PAPERS = [
    {
        'id': 'nation-1',
        'title': '2025年高考数学试卷（全国新高考Ⅰ卷）',
        'filename': '2025年高考数学试卷（全国Ⅰ卷）（解析卷）.txt',
        'start_header': '一、选择题',
        'total_q': 19,
        'types': [(1, 8, '单选题', 5), (9, 11, '多选题', 6), (12, 14, '填空题', 5), (15, 15, '解答题', 13), (16, 16, '解答题', 15), (17, 17, '解答题', 15), (18, 18, '解答题', 17), (19, 19, '解答题', 17)],
        'duration': 120,
        'total_score': 150
    },
    {
        'id': 'nation-2',
        'title': '2025年高考数学试卷（全国新高考Ⅱ卷）',
        'filename': '2025年高考数学试卷（全国Ⅱ卷）（解析卷）.txt',
        'start_header': '一、单选题',
        'total_q': 19,
        'types': [(1, 8, '单选题', 5), (9, 11, '多选题', 6), (12, 14, '填空题', 5), (15, 15, '解答题', 13), (16, 16, '解答题', 15), (17, 17, '解答题', 15), (18, 18, '解答题', 17), (19, 19, '解答题', 17)],
        'duration': 120,
        'total_score': 150
    },
    {
        'id': 'beijing',
        'title': '2025年高考数学试卷（北京卷）',
        'filename': '2025年高考数学试卷（北京）（解析卷）.txt',
        'start_header': '一、选择题',
        'total_q': 21,
        'types': [(1, 10, '单选题', 4), (11, 15, '填空题', 5), (16, 16, '解答题', 13), (17, 17, '解答题', 14), (18, 18, '解答题', 14), (19, 19, '解答题', 14), (20, 20, '解答题', 15), (21, 21, '解答题', 15)],
        'duration': 120,
        'total_score': 150
    },
    {
        'id': 'tianjin',
        'title': '2025年高考数学试卷（天津卷）',
        'filename': '2025年高考数学试卷（天津）（解析卷）.txt',
        'start_header': '一、选择题',
        'total_q': 20,
        'types': [(1, 9, '单选题', 5), (10, 15, '填空题', 5), (16, 16, '解答题', 14), (17, 17, '解答题', 15), (18, 18, '解答题', 15), (19, 19, '解答题', 15), (20, 20, '解答题', 16)],
        'duration': 120,
        'total_score': 150
    },
    {
        'id': 'shanghai',
        'title': '2025年高考数学试卷（上海卷）',
        'filename': '2025年高考数学试卷（上海6月）（解析卷）.txt',
        'start_header': '一、填空题',
        'total_q': 21,
        'types': [(1, 6, '填空题', 4), (7, 12, '填空题', 5), (13, 14, '单选题', 4), (15, 16, '单选题', 5), (17, 19, '解答题', 14), (20, 21, '解答题', 18)],
        'duration': 120,
        'total_score': 150
    }
]

def get_type_and_score(q_num, type_rules):
    for start, end, qtype, score in type_rules:
        if start <= q_num <= end:
            return qtype, score
    return '未知', 5

def infer_pedagogy(q_num, q_type, body_text, ana_text):
    full = (body_text + ' ' + ana_text).lower()
    
    # 主考知识点
    kp = '代数与函数'
    if '虚部' in full or '复数' in full: kp = '复数代数运算与几何意义'
    elif '全集' in full or '交集' in full or '并集' in full or '补集' in full or '集合' in full: kp = '集合概念与集合运算'
    elif '双曲线' in full: kp = '双曲线标准方程与几何性质'
    elif '抛物线' in full: kp = '抛物线标准方程与几何性质'
    elif '椭圆' in full: kp = '椭圆标准方程与几何性质'
    elif '正切' in full or '余弦' in full or '正弦' in full or '对称中心' in full or '最小正周期' in full or 'sin' in full or 'cos' in full or 'tan' in full or '解三角形' in full: kp = '三角恒等变换与解三角形'
    elif '周期' in full or '偶函数' in full or '奇函数' in full or '单调性' in full: kp = '函数性质（奇偶性、周期性、单调性）'
    elif '向量' in full or '风速' in full: kp = '平面向量运算及其物理/实际应用'
    elif '圆' in full and ('圆心' in full or '半径' in full or '相切' in full): kp = '直线与圆的方程及几何位置关系'
    elif '等比数列' in full: kp = '等比数列通项与前n项和'
    elif '等差数列' in full: kp = '等差数列通项与前n项和'
    elif '数列' in full: kp = '数列递推关系与求和综合'
    elif '古典概型' in full or '分布列' in full or '期望' in full or '二项分布' in full: kp = '离散型随机变量分布列与数学期望'
    elif '列联表' in full or '超声波' in full or '独立性检验' in full or '平均数' in full or '方差' in full: kp = '成对数据统计分析与独立性检验'
    elif '棱锥' in full or '棱柱' in full or '圆柱' in full or '球' in full or '线面' in full or '二面角' in full: kp = '立体几何线面位置关系与空间向量'
    elif '导数' in full or '切线' in full or '极值' in full or '零点' in full or '单调区间' in full: kp = '导数在函数单调性、极值与不等式证明中的应用'
    elif '不等式' in full or '基本不等式' in full: kp = '不等式性质与基本不等式'

    # 认知层次 (Intent)
    if q_num in [1, 2] and q_type in ['单选题', '填空题']:
        cog = '概念理解 (concept_check)'
    elif q_type in ['单选题', '填空题'] and q_num <= 6:
        cog = '基础应用 (basic_application)'
    elif q_type == '多选题' and q_num in [10, 11]:
        cog = '综合应用 (comprehensive)'
    elif q_type == '解答题' and q_num >= 17:
        cog = '综合应用 (comprehensive)'
    elif q_num in [7, 8, 14]:
        cog = '综合应用 (comprehensive)'
    else:
        cog = '基础应用 (basic_application)'

    # 核心素养
    literacies = []
    if any(k in full for k in ['向量', '风速', '模型', '3d', '超声波', '乒乓球', '调查', '实际']):
        literacies.append('数学建模')
    if any(k in full for k in ['棱锥', '棱柱', '圆', '椭圆', '双曲线', '抛物线', '图象', '坐标系', '数轴', '几何']):
        literacies.append('直观想象')
    if any(k in full for k in ['证明', '充分', '必要', '若', '分类讨论', '真假', '充要', '反证']):
        literacies.append('逻辑推理')
    if any(k in full for k in ['计算', '求解', '化简', '运算', '方程', '通项', '离心率', '极值', '前n项和']):
        literacies.append('数学运算')
    if any(k in full for k in ['集合', '复数', '周期', '定义', '映射', '符号', '抽象']):
        literacies.append('数学抽象')
    if any(k in full for k in ['概率', '期望', '样本', '方差', '列联表', '频率', '随机']):
        literacies.append('数据分析')
    if not literacies: literacies = ['数学运算', '逻辑推理']
    
    # 考查负担与能力方式
    burden_items = []
    if '分类讨论' in full or '讨论' in full: burden_items.append('严密分类讨论')
    if '构造' in full or '特例' in full or '猜想' in full: burden_items.append('策略发现与创新')
    if '数形结合' in full or '图象' in full: burden_items.append('数形结合表征转换')
    if '运算' in full or '方程' in full: burden_items.append('代数运算求解')
    if '证明' in full: burden_items.append('演绎推理论证')
    if not burden_items: burden_items = ['常规运算法则直接应用']

    return kp, cog, '、'.join(literacies[:3]), '、'.join(burden_items[:2])

def process_paper(cfg):
    filepath = os.path.join(dir_path, cfg['filename'])
    with open(filepath, 'r', encoding='utf-8') as f:
        text = f.read()

    cleaned = re.sub(r'=== Page \d+ ===', '', text)
    cleaned = re.sub(r'第\s*\d+\s*页/共\s*\d+\s*页[^\n]*', '', cleaned)
    cleaned = re.sub(r'学科网[^\n]*', '', cleaned)

    idx = cleaned.find(cfg['start_header'])
    content_after = cleaned[idx:]

    positions = []
    last_pos = 0
    for q in range(1, cfg['total_q'] + 1):
        pattern = rf'(?:\n|\A)\s*{q}\s*(?:[.\uFF0E\u3001]|\s{{1,4}})(?=[^\d\n])'
        m = re.search(pattern, content_after[last_pos:])
        if m:
            actual_pos = last_pos + m.start()
            positions.append((q, actual_pos))
            last_pos = actual_pos + 1
        else:
            print(f"Error: Missing Q{q} in {cfg['id']}")

    questions = []
    for i in range(len(positions)):
        q_num, start_idx = positions[i]
        end_idx = positions[i+1][1] if i + 1 < len(positions) else len(content_after)
        raw_block = content_after[start_idx:end_idx].strip()

        # Extract answer, analysis, solution
        ans_m = re.search(r'【答案】\s*([\s\S]*?)(?=【解析】|【分析】|【详解】|$)', raw_block)
        ans = ans_m.group(1).strip() if ans_m else '见试题解析'

        ana_m = re.search(r'【分析】\s*([\s\S]*?)(?=【详解】|$)', raw_block)
        ana = ana_m.group(1).strip() if ana_m else ''

        sol_m = re.search(r'【详解】\s*([\s\S]*?)$', raw_block)
        sol = sol_m.group(1).strip() if sol_m else ''

        # Body: text before 【答案】 or 【解析】
        body_end = len(raw_block)
        for kw in ['【答案】', '【解析】', '【分析】']:
            k_idx = raw_block.find(kw)
            if k_idx != -1 and k_idx < body_end:
                body_end = k_idx
        body = raw_block[:body_end].strip()

        q_type, score = get_type_and_score(q_num, cfg['types'])
        kp, cog, lit, burden = infer_pedagogy(q_num, q_type, body, ana)

        questions.append({
            'num': q_num,
            'type': q_type,
            'score': score,
            'body': body,
            'answer': ans,
            'analysis': ana,
            'solution': sol,
            'kp': kp,
            'cognitive': cog,
            'literacy': lit,
            'burden': burden
        })

    # Generate Markdown
    md = []
    md.append(f"# {cfg['title']}\n")
    md.append(f"- **年份**：2025年全国普通高等学校招生统一考试")
    md.append(f"- **总题量**：{cfg['total_q']} 题 | **满分**：{cfg['total_score']} 分 | **考试时长**：{cfg['duration']} 分钟")
    md.append(f"- **试卷类型**：{'新高考新结构卷（19题：8单选+3多选+3填空+5解答）' if cfg['total_q'] == 19 else '自主命题卷'}")
    md.append(f"- **物理源文件**：`{cfg['filename']}`\n")
    md.append(f"---\n")
    md.append(f"## 一、 试卷全貌与考查细目表\n")
    md.append(f"| 题号 | 题型 | 分值 | 主考知识点 | 认知层次 | 核心素养 | 关键考查方式与能力负担 |")
    md.append(f"| :---: | :---: | :---: | :--- | :--- | :--- | :--- |")
    for q in questions:
        md.append(f"| **{q['num']}** | {q['type']} | {q['score']}分 | {q['kp']} | {q['cognitive']} | {q['literacy']} | {q['burden']} |")

    md.append(f"\n---\n")
    md.append(f"## 二、 试题逐题全景分析与详细解析\n")
    for q in questions:
        md.append(f"### 第 {q['num']} 题（{q['type']} · {q['score']}分）\n")
        md.append(f"- **【考查主考点】**：{q['kp']}")
        md.append(f"- **【核心素养】**：{q['literacy']}")
        md.append(f"- **【认知层次】**：{q['cognitive']}")
        md.append(f"- **【能力与任务考查】**：{q['burden']}\n")
        md.append(f"#### 题目内容\n")
        md.append(f"```text\n{q['body']}\n```\n")
        md.append(f"#### 【标准答案】\n")
        md.append(f"{q['answer']}\n")
        if q['analysis']:
            md.append(f"#### 【解题思路与分析】\n")
            md.append(f"{q['analysis']}\n")
        if q['solution']:
            md.append(f"#### 【原卷详解与规范步骤】\n")
            md.append(f"{q['solution']}\n")
        md.append(f"---\n")

    md_content = '\n'.join(md)
    out_file = os.path.join(docs_out, f"{cfg['id']}.md")
    with open(out_file, 'w', encoding='utf-8') as f:
        f.write(md_content)
    print(f"Generated: {out_file} ({len(questions)} questions)")

for cfg in PAPERS:
    process_paper(cfg)

print("All 5 papers generated successfully!")

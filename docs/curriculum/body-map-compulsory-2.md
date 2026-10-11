# 必修第二册知识点正文证据映射

覆盖旧知识树本册全部 **152** 个叶节点；正文语义匹配 **143** 条，待复核 **9** 条，未找到 **0** 条。全部保持 `reviewStatus: pending_review`。

共审视 **19** 个教材节，均存在旧知识UID的正文关联；**58** 条的实际证据页未含旧 `source_page`。完整逐条quote、页哈希、定义哈希、关系及疑点见 [JSON](../../data/curriculum/body-map-compulsory-2.json)。

正文文字匹配支持定义或命题主体，包含条件检视，不是关键词命中。为分式、模长、根号等文本层损坏，额外渲染复核了15个原PDF页，23条记录附 `visualEvidence`。渲染文件是本地 `.tutor` 运行材料；可由来源PDF页码、PDF SHA256再现。原文摘录从逐页UTF-8文本连续截取，保留原始断行和抽取字形；跨页定义分开保存，未拼接成伪原文。

本次不修改旧知识定义、不推断官方课标等级、不把知识节点视为认知要求/能力/素养，也不自动发布题库或改变组卷规则。

## 待复核原因

1. 向量垂直坐标条件：旧定义漏非零向量前提。向量模、夹角、复数模、海伦、秦九韶公式：旧定义LaTeX本身损坏或根号作用域错误，原PDF已核对，但需独立修订旧定义。
2. 正弦形式三角形面积：53页只是习题要求推导，54页另一个面积式继续作为待证明题；不能宣称旧定义的三条等式都在教材直接给出。
3. 1的一般n次方根：92页明确给出三次根及正三角形解释，一般n次根留作学生探究，不能用三次特例证明一般公式直接覆盖。
4. 异面直线角：147页总范围讨论空间两直线（含平行0°），旧定义只针对异面严格正角；保留对象区分复核。

## 教材内容缺口

8.4节有平面基本事实1–3、确定平面的推论、位置关系；旧本册叶目录仅“异面直线”对应其中一部分。9.3统计案例涉及调查分析报告和建议的全过程，旧树只有抽样及特征数节点。本次补入实际应用证据，同时用 `sectionCoverageGaps` 单列未有独立UID的内容，不能用“每节有一个UID”冒充知识原子完整覆盖。

## 教材节覆盖

| 节 | 标题 | 有正文证据的UID数 |
|---|---|---:|
| 6.1 | 平面向量的概念 | 7 |
| 6.2 | 平面向量的运算 | 9 |
| 6.3 | 平面向量基本定理及坐标表示 | 13 |
| 6.4 | 平面向量的应用 | 6 |
| 7.1 | 复数的概念 | 11 |
| 7.2 | 复数的四则运算 | 6 |
| 7.3 | 复数的三角表示 | 7 |
| 8.1 | 基本立体图形 | 15 |
| 8.2 | 立体图形的直观图 | 1 |
| 8.3 | 简单几何体的表面积与体积 | 15 |
| 8.4 | 空间点、直线、平面之间的位置关系 | 1 |
| 8.5 | 空间直线、平面的平行 | 6 |
| 8.6 | 空间直线、平面的垂直 | 10 |
| 9.1 | 随机抽样 | 13 |
| 9.2 | 用样本估计总体 | 10 |
| 9.3 | 统计案例 公司员工的肥胖情况调查分析 | 4 |
| 10.1 | 随机事件与概率 | 19 |
| 10.2 | 事件的相互独立性 | 1 |
| 10.3 | 频率与概率 | 2 |

## 逐UID结果

| UID | 名称 | 旧页 | 正文页 | 关系 | 状态 |
|---|---|---:|---|---|---|
| M-K-03-111 | 向量 | 2 | 2 | introduces | text_evidence_matched |
| M-K-03-112 | 有向线段 | 3 | 3 | introduces | text_evidence_matched |
| M-K-03-113 | 零向量 | 3 | 3 | introduces | text_evidence_matched |
| M-K-03-114 | 单位向量 | 3 | 3 | introduces | text_evidence_matched |
| M-K-03-115 | 平行向量 | 3 | 3 | introduces | text_evidence_matched |
| M-K-03-116 | 相等向量 | 4 | 4 | introduces | text_evidence_matched |
| M-K-03-117 | 共线向量 | 4 | 4 | introduces | text_evidence_matched |
| M-K-03-1210 | 相反向量 | 11 | 11 | introduces | text_evidence_matched |
| M-K-03-1211 | 向量的数乘 | 13 | 13 | introduces | text_evidence_matched |
| M-K-03-1212 | 向量共线定理 | 14 | 15 | introduces | text_evidence_matched |
| M-K-03-1213 | 向量的夹角 | 17 | 17 | introduces | text_evidence_matched |
| M-K-03-1214 | 向量的数量积 | 17 | 17 | introduces | text_evidence_matched |
| M-K-03-1215 | 投影向量 | 18 | 18 | introduces | text_evidence_matched |
| M-K-03-1216 | 向量的数量积的运算律 | 20 | 20 | introduces | text_evidence_matched |
| M-K-03-128 | 向量的加法 | 7 | 8, 9 | introduces | text_evidence_matched |
| M-K-03-129 | 向量的减法 | 11 | 11, 12 | introduces | text_evidence_matched |
| M-K-03-1317 | 平面向量基本定理 | 26 | 26 | introduces | text_evidence_matched |
| M-K-03-1318 | 基底 | 26 | 26 | introduces | text_evidence_matched |
| M-K-03-1319 | 向量的正交分解 | 27 | 28 | introduces | text_evidence_matched |
| M-K-03-1320 | 向量的坐标表示 | 28 | 28 | introduces | text_evidence_matched |
| M-K-03-1321 | 向量加法运算的坐标表示 | 29 | 29 | introduces | text_evidence_matched |
| M-K-03-1322 | 向量减法运算的坐标表示 | 29 | 29, 30 | introduces | text_evidence_matched |
| M-K-03-1323 | 向量数乘运算的坐标表示 | 31 | 31 | introduces | text_evidence_matched |
| M-K-03-1324 | 向量共线的坐标表示 | 31 | 31 | introduces | text_evidence_matched |
| M-K-03-1325 | 中点坐标公式 | 33 | 32 | introduces | text_evidence_matched |
| M-K-03-1326 | 向量数量积的坐标表示 | 34 | 34 | introduces | text_evidence_matched |
| M-K-03-1327 | 向量垂直的坐标表示 | 35 | 34 | introduces | needs_review |
| M-K-03-1328 | 向量模的坐标表示 | 34 | 34 | introduces | needs_review |
| M-K-03-1329 | 向量夹角的坐标表示 | 35 | 34 | introduces | needs_review |
| M-K-03-1430 | 余弦定理 | 42 | 43 | introduces | text_evidence_matched |
| M-K-03-1431 | 正弦定理 | 46 | 46 | introduces | text_evidence_matched |
| M-K-03-1432 | 解三角形 | 43 | 43 | introduces | text_evidence_matched |
| M-K-03-1433 | 三角形面积公式（正弦形式） | 49 | 53, 54 | applies | needs_review |
| M-K-03-1434 | 海伦公式 | 55 | 55 | introduces | needs_review |
| M-K-03-1435 | 秦九韶三斜求积公式 | 55 | 55 | explains | needs_review |
| M-K-03-211 | 虚数单位 | 68 | 68, 69 | introduces | text_evidence_matched |
| M-K-03-2110 | 复数的模 | 71 | 71 | introduces | needs_review |
| M-K-03-2111 | 共轭复数 | 72 | 72 | introduces | text_evidence_matched |
| M-K-03-212 | 复数 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-213 | 实部 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-214 | 虚部 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-215 | 虚数 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-216 | 纯虚数 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-217 | 复数相等 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-218 | 复数集 | 69 | 69 | introduces | text_evidence_matched |
| M-K-03-219 | 复平面 | 70 | 70 | introduces | text_evidence_matched |
| M-K-03-2212 | 复数的加法 | 75 | 75 | introduces | text_evidence_matched |
| M-K-03-2213 | 复数的减法 | 77 | 76 | introduces | text_evidence_matched |
| M-K-03-2214 | 复数的乘法 | 78 | 77, 78 | introduces | text_evidence_matched |
| M-K-03-2215 | 复数的除法 | 80 | 78 | introduces | text_evidence_matched |
| M-K-03-2216 | 代数基本定理 | 81 | 81, 82 | introduces | text_evidence_matched |
| M-K-03-2217 | 韦达定理 | 82 | 82 | explains | text_evidence_matched |
| M-K-03-2316 | 复数的三角表示式 | 84 | 84 | introduces | text_evidence_matched |
| M-K-03-2317 | 辐角 | 84 | 84 | introduces | text_evidence_matched |
| M-K-03-2318 | 辐角的主值 | 85 | 84 | introduces | text_evidence_matched |
| M-K-03-2319 | 复数乘法的三角表示 | 86 | 86, 87 | introduces | text_evidence_matched |
| M-K-03-2320 | 复数除法的三角表示 | 88 | 88 | introduces | text_evidence_matched |
| M-K-03-2321 | 棣莫弗定理 | 91 | 91 | introduces | text_evidence_matched |
| M-K-03-2322 | 1的n次方根 | 91 | 92 | explains | needs_review |
| M-K-03-311 | 多面体 | 97 | 97, 98 | introduces | text_evidence_matched |
| M-K-03-3110 | 棱台 | 100 | 100 | introduces | text_evidence_matched |
| M-K-03-3111 | 圆柱 | 101 | 101 | introduces | text_evidence_matched |
| M-K-03-3112 | 圆锥 | 102 | 102 | introduces | text_evidence_matched |
| M-K-03-3113 | 圆台 | 102 | 102 | introduces | text_evidence_matched |
| M-K-03-3114 | 球 | 102 | 102 | introduces | text_evidence_matched |
| M-K-03-3115 | 简单组合体 | 103 | 103 | introduces | text_evidence_matched |
| M-K-03-312 | 旋转体 | 98 | 98 | introduces | text_evidence_matched |
| M-K-03-313 | 棱柱 | 98 | 98 | introduces | text_evidence_matched |
| M-K-03-314 | 直棱柱 | 99 | 99 | introduces | text_evidence_matched |
| M-K-03-315 | 斜棱柱 | 99 | 99 | introduces | text_evidence_matched |
| M-K-03-316 | 正棱柱 | 99 | 99 | introduces | text_evidence_matched |
| M-K-03-317 | 平行六面体 | 99 | 99 | introduces | text_evidence_matched |
| M-K-03-318 | 棱锥 | 99 | 99, 100 | introduces | text_evidence_matched |
| M-K-03-319 | 正棱锥 | 100 | 100 | introduces | text_evidence_matched |
| M-K-03-3216 | 斜二测画法 | 108 | 107, 108 | introduces | text_evidence_matched |
| M-K-03-3217 | 棱柱的体积 | 114 | 114 | introduces | text_evidence_matched |
| M-K-03-3218 | 棱锥的体积 | 115 | 114, 115 | introduces | text_evidence_matched |
| M-K-03-3219 | 棱台的体积 | 115 | 115 | introduces | text_evidence_matched |
| M-K-03-3220 | 圆柱的表面积 | 116 | 116 | introduces | text_evidence_matched |
| M-K-03-3221 | 圆锥的表面积 | 116 | 116 | introduces | text_evidence_matched |
| M-K-03-3222 | 圆台的表面积 | 116 | 116 | introduces | text_evidence_matched |
| M-K-03-3223 | 圆柱的体积 | 117 | 117 | introduces | text_evidence_matched |
| M-K-03-3224 | 圆锥的体积 | 117 | 117 | introduces | text_evidence_matched |
| M-K-03-3225 | 圆台的体积 | 117 | 117 | introduces | text_evidence_matched |
| M-K-03-3226 | 球的表面积 | 118 | 117 | introduces | text_evidence_matched |
| M-K-03-3227 | 球的体积 | 119 | 118 | introduces | text_evidence_matched |
| M-K-03-3228 | 祖暅原理 | 121 | 121 | explains | text_evidence_matched |
| M-K-03-3229 | 锥体的体积 | 117 | 117 | explains | text_evidence_matched |
| M-K-03-3230 | 台体的体积 | 117 | 117 | explains | text_evidence_matched |
| M-K-03-3231 | 柱体的体积 | 117 | 117 | explains | text_evidence_matched |
| M-K-03-3331 | 异面直线 | 131 | 129 | introduces | text_evidence_matched |
| M-K-03-3432 | 平行线的传递性 | 135 | 133 | introduces | text_evidence_matched |
| M-K-03-3433 | 等角定理 | 137 | 135 | introduces | text_evidence_matched |
| M-K-03-3434 | 直线与平面平行的判定定理 | 140 | 136 | introduces | text_evidence_matched |
| M-K-03-3435 | 直线与平面平行的性质定理 | 143 | 138 | introduces | text_evidence_matched |
| M-K-03-3436 | 平面与平面平行的判定定理 | 146 | 140 | introduces | text_evidence_matched |
| M-K-03-3437 | 平面与平面平行的性质定理 | 148 | 141 | introduces | text_evidence_matched |
| M-K-03-3538 | 异面直线所成的角 | 147 | 146, 147 | introduces | needs_review |
| M-K-03-3539 | 直线与平面垂直的定义 | 150 | 149 | introduces | text_evidence_matched |
| M-K-03-3540 | 直线与平面垂直的判定定理 | 153 | 150 | introduces | text_evidence_matched |
| M-K-03-3541 | 直线与平面所成的角 | 154 | 151, 152 | introduces | text_evidence_matched |
| M-K-03-3542 | 直线与平面垂直的性质定理 | 155 | 154 | introduces | text_evidence_matched |
| M-K-03-3543 | 点到平面的距离 | 151 | 150 | introduces | text_evidence_matched |
| M-K-03-3544 | 二面角 | 156 | 156 | introduces | text_evidence_matched |
| M-K-03-3545 | 二面角的平面角 | 157 | 156 | introduces | text_evidence_matched |
| M-K-03-3546 | 平面与平面垂直的判定定理 | 159 | 157 | introduces | text_evidence_matched |
| M-K-03-3547 | 平面与平面垂直的性质定理 | 161 | 160 | introduces | text_evidence_matched |
| M-K-04-111 | 总体 | 173 | 173 | introduces | text_evidence_matched |
| M-K-04-1110 | 样本均值 | 180 | 178, 221 | introduces | text_evidence_matched |
| M-K-04-1111 | 样本容量 | 174 | 173 | introduces | text_evidence_matched |
| M-K-04-1112 | 分层随机抽样 | 186 | 182, 220 | introduces | text_evidence_matched |
| M-K-04-1113 | 比例分配 | 186 | 182, 220 | introduces | text_evidence_matched |
| M-K-04-112 | 个体 | 173 | 173 | introduces | text_evidence_matched |
| M-K-04-113 | 全面调查 | 173 | 173 | introduces | text_evidence_matched |
| M-K-04-114 | 抽样调查 | 174 | 173 | introduces | text_evidence_matched |
| M-K-04-115 | 样本 | 174 | 173 | introduces | text_evidence_matched |
| M-K-04-116 | 简单随机抽样 | 175 | 174, 175 | introduces | text_evidence_matched |
| M-K-04-117 | 抽签法 | 176 | 175 | explains | text_evidence_matched |
| M-K-04-118 | 随机数法 | 176 | 175 | explains | text_evidence_matched |
| M-K-04-119 | 总体均值 | 180 | 178 | introduces | text_evidence_matched |
| M-K-04-1214 | 频率分布表 | 195 | 195 | explains | text_evidence_matched |
| M-K-04-1215 | 频率分布直方图 | 195 | 196 | explains | text_evidence_matched |
| M-K-04-1216 | 极差 | 196 | 194 | introduces | text_evidence_matched |
| M-K-04-1217 | 众数 | 205 | 206, 207 | explains | text_evidence_matched |
| M-K-04-1218 | 中位数 | 205 | 205 | explains | text_evidence_matched |
| M-K-04-1219 | 平均数 | 206 | 205 | explains | text_evidence_matched |
| M-K-04-1220 | 方差 | 209 | 212, 221 | introduces | text_evidence_matched |
| M-K-04-1221 | 标准差 | 209 | 212 | introduces | text_evidence_matched |
| M-K-04-1222 | 百分位数 | 202 | 203 | introduces | text_evidence_matched |
| M-K-04-1223 | 四分位数 | 203 | 203 | introduces | text_evidence_matched |
| M-K-04-211 | 样本点 | 229 | 228 | introduces | text_evidence_matched |
| M-K-04-2110 | 互斥事件 | 233 | 233 | introduces | text_evidence_matched |
| M-K-04-2111 | 对立事件 | 233 | 233 | introduces | text_evidence_matched |
| M-K-04-2112 | 古典概型 | 236 | 236 | introduces | text_evidence_matched |
| M-K-04-2113 | 古典概型的概率公式 | 237 | 236 | introduces | text_evidence_matched |
| M-K-04-2115 | 频率的稳定性 | 254 | 256 | introduces | text_evidence_matched |
| M-K-04-2116 | 随机模拟 | 263 | 258, 259 | explains | text_evidence_matched |
| M-K-04-2117 | 概率的非负性 | 250 | 241 | explains | text_evidence_matched |
| M-K-04-2118 | 概率的规范性 | 250 | 241 | explains | text_evidence_matched |
| M-K-04-2119 | 互斥事件的概率加法公式 | 250 | 242 | explains | text_evidence_matched |
| M-K-04-212 | 有限样本空间 | 229 | 228 | introduces | text_evidence_matched |
| M-K-04-2120 | 概率的单调性 | 250 | 243 | explains | text_evidence_matched |
| M-K-04-2121 | 对立事件的概率 | 250 | 242 | explains | text_evidence_matched |
| M-K-04-2122 | 概率的一般加法公式 | 250 | 243 | explains | text_evidence_matched |
| M-K-04-213 | 随机事件 | 229 | 229 | introduces | text_evidence_matched |
| M-K-04-214 | 基本事件 | 229 | 229 | introduces | text_evidence_matched |
| M-K-04-215 | 必然事件 | 230 | 230 | introduces | text_evidence_matched |
| M-K-04-216 | 不可能事件 | 230 | 230 | introduces | text_evidence_matched |
| M-K-04-217 | 事件的包含与相等 | 231 | 232 | introduces | text_evidence_matched |
| M-K-04-218 | 并事件 | 232 | 232 | introduces | text_evidence_matched |
| M-K-04-219 | 交事件 | 232 | 232 | introduces | text_evidence_matched |
| M-K-04-2217 | 事件的相互独立性 | 249 | 250 | introduces | text_evidence_matched |

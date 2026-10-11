# 必修第一册：知识点正文证据映射

日期：2026-10-11。覆盖旧知识目录中属于必修第一册的 **103 个叶节点**，逐项比较 definition 与当前本地教材正文；不修改原 UID、知识树或总映射。

教材：人教 A 版《普通高中教科书·数学 必修第一册》，源 SHA-256 `1cfc10b863905134d839262b44053b06e659875e082105272f151d09782eb340`。当前电子书版次年份未确认，未沿用旧库年份推定。PDF 物理页比印刷页多 7 页。

结果：`text_evidence_matched` 97 条；`needs_review` 6 条。旧页码不在本次正文证据页中的节点 41 条。

`text_evidence_matched` 仅表示正文语义证据已定位：不是教师审核通过，不表示学生已经学过，也不直接放宽选题边界。公式/图表仍受 OCR 未人工复核限制。引用保存原 OCR 连续短摘、正文 SHA-256 与物理/印刷页，判断说明独立于原文。

## 需要复核的定义与证据边界

- **M-K-01-1214 容斥原理**（印刷 15、16 页）：旧定义同时包含二集合与三集合容斥公式；不能把三集合探究题当作教材已经给出的完整公式。需决定保留为推导拓展还是拆分映射。
- **M-K-02-217 指数衰减**（印刷 113、109 页）：旧定义概括 y=N(1-p)^x 趋于 0，需显式 N>0、0<p<1；所选正文叙述为碳 14 正质量实例，不能据此把无限制一般式确认无误。
- **M-K-02-2213 三种函数增长的差异**（印刷 137、138 页）：旧末句“最终增长速度恒有”易混淆函数值大小与变化速度，且一次函数正系数条件未写明；需澄清后才能确认完整定义。
- **M-K-02-316 弧长公式**（印刷 174 页）：该页例 6 的明确前提为 0<α<2π；旧定义放宽到 α>0，超过一周时“弧长”的含义需补充累计转过弧长约定，不能静默扩大教材结论。
- **M-K-02-3211 三角函数的符号**（印刷 180 页）：旧定义罗列三个函数的全部象限符号，当前文字只有填写任务和第三象限例证；需原图与学科复核后确认完整符号表，不能把空表当答案。
- **M-K-02-3326 辅助角公式**（印刷 227 页）：旧定义公式括号排版损坏；仅写 tanφ=b/a 既漏 a=0 情况，也不足以确定正确象限；还须 a²+b²>0 及 sinφ、cosφ 的系数关系。源例 9 给出具体正系数情形，不能替旧定义自动补全。

## 3.4 节后续应用补充

已阅读全文印刷 93—102 页，新增 11 个已有 UID 的 18 处真实应用证据。其中 3.4 主体和本节习题关联 6 个 UID、8 处证据，其余为章末复习。原条目主 relation 保留首次定义/解释，新增 evidence 单独记 relation=applies。练习题干证明其调用某知识，不代表本批已经解答或教师复核。

范围区分：93—95 页为 3.4 主体例题与练习，96 页为习题 3.4，分别标 section_body / section_exercise 且有真实 sectionId；97—98 页为文献写作活动，99—102 页为第三章小结与复习参考题，分别标 chapter_enrichment / chapter_review，仅有 chapterId。章末材料不计作 3.4 节正文覆盖。

| UID | 知识点 | 新应用印刷页 | 内容 |
| --- | --- | --- | --- |
| M-K-02-111 | 函数 | 95 | 3.4 例题/练习 |
| M-K-02-112 | 定义域 | 95、100 | 3.4 例题/练习；章末复习题 |
| M-K-02-113 | 值域 | 101 | 章末复习题 |
| M-K-02-114 | 区间 | 95 | 3.4 例题/练习 |
| M-K-02-116 | 分段函数 | 93、95 | 3.4 例题/练习 |
| M-K-02-117 | 函数的表示法 | 94、96、102 | 3.4 例题/练习；章末复习题 |
| M-K-02-1210 | 偶函数 | 101 | 章末复习题 |
| M-K-02-1211 | 奇函数 | 101 | 章末复习题 |
| M-K-02-127 | 函数的单调性 | 100、101 | 章末复习题 |
| M-K-02-128 | 函数的最大值 | 95、101、102 | 3.4 例题/练习；章末复习题 |
| M-K-02-1312 | 幂函数 | 100 | 章末复习题 |

### 尚不能由已有本册叶节点完整覆盖的内容

- **利用函数模型解决实际问题的过程与方法**（catalog_gap）：本节通过个税与汽车实例训练从现实关系建立解析式、计算并解释结果。已有函数/表示法/分段函数节点覆盖组成知识，但 103 叶目录没有函数建模过程的独立节点；不据此伪造教材给出的统一步骤标准。
- **从观测数据猜想近似函数模型**（catalog_gap）：弹簧数据题要求寻找“基本反映”变化的解析式，销售数据题要求由点猜想函数关系。表示法节点能覆盖数据表示与转换，但不等于覆盖模型选择、近似误差或检验；教材此处未指定最小二乘等拟合算法。
- **一次/二次函数的现实模型（初中前置知识）**（prerequisite_catalog_gap）：正文和练习真实使用一次、二次函数模型；旧库仅有“一元二次函数、方程和不等式”分组，没有一次函数/二次函数独立叶 UID。一般 y=ax² 模型不可直接等同于纯幂函数 y=x^α 的完整定义。需要后续补基础知识映射，不能制造已有 UID。
- **通过中间变量组合两个函数关系**（cross_book_candidate）：个税例题将 t=g(x) 代入 y=f(t) 得到收入到税额的关系。全库有复合函数 UID M-K-02-528，但标属选择性必修第二册，不在本册 103 叶中。此处是早期操作实例，不据此确认已正式学习复合函数或求导。供 root 后续跨册关系核对。
- **函数历史文献阅读、资料整理与综述写作活动**（enrichment_not_in_math_leaf_catalog）：印刷 97—98 页为章末文献阅读与数学写作活动，目录区间被包含在 3.4 后部，但不是函数知识的新定义。数学叶目录无文献检索、资料归纳、综述结构节点，保留活动覆盖缺口而不强挂到函数 UID 冒充完整映射。

## 完整逐 UID 索引

| UID | 知识点 | 关系 | 旧印刷页 | 本次印刷页（PDF 页） | 状态 |
| --- | --- | --- | --- | --- | --- |
| M-K-01-111 | 元素 | introduces | 2 | 2（9） | text_evidence_matched |
| M-K-01-112 | 集合 | introduces | 2 | 2（9） | text_evidence_matched |
| M-K-01-113 | 属于 | introduces | 2 | 2（9）、3（10） | text_evidence_matched |
| M-K-01-114 | 列举法 | introduces | 3 | 3（10） | text_evidence_matched |
| M-K-01-115 | 描述法 | introduces | 4 | 4（11） | text_evidence_matched |
| M-K-01-116 | 常用数集及其记法 | introduces | 2 | 3（10） | text_evidence_matched |
| M-K-01-117 | 有限集与无限集 | explains | 2 | 15（22）、16（23） | text_evidence_matched |
| M-K-01-1210 | 并集 | introduces | 10 | 10（17） | text_evidence_matched |
| M-K-01-1211 | 交集 | introduces | 11 | 11（18） | text_evidence_matched |
| M-K-01-1212 | 全集 | introduces | 12 | 12（19） | text_evidence_matched |
| M-K-01-1213 | 补集 | introduces | 12 | 13（20） | text_evidence_matched |
| M-K-01-1214 | 容斥原理 | related | 15 | 15（22）、16（23） | needs_review |
| M-K-01-126 | 子集 | introduces | 7 | 7（14） | text_evidence_matched |
| M-K-01-127 | 真子集 | introduces | 7 | 8（15） | text_evidence_matched |
| M-K-01-128 | 集合相等 | introduces | 7 | 7（14）、8（15） | text_evidence_matched |
| M-K-01-129 | 空集 | introduces | 8 | 8（15） | text_evidence_matched |
| M-K-01-1314 | 命题 | introduces | 17 | 17（24） | text_evidence_matched |
| M-K-01-1315 | 充分条件 | introduces | 18 | 17（24） | text_evidence_matched |
| M-K-01-1316 | 必要条件 | introduces | 18 | 17（24） | text_evidence_matched |
| M-K-01-1317 | 充要条件 | introduces | 20 | 20（27）、21（28） | text_evidence_matched |
| M-K-01-1318 | 全称量词 | introduces | 26 | 26（33） | text_evidence_matched |
| M-K-01-1319 | 存在量词 | introduces | 27 | 27（34） | text_evidence_matched |
| M-K-01-1320 | 全称量词命题 | introduces | 26 | 26（33） | text_evidence_matched |
| M-K-01-1321 | 存在量词命题 | introduces | 27 | 27（34） | text_evidence_matched |
| M-K-01-1322 | 全称量词命题的否定 | explains | 28 | 29（36） | text_evidence_matched |
| M-K-01-1323 | 存在量词命题的否定 | explains | 29 | 30（37） | text_evidence_matched |
| M-K-01-211 | 等式的性质 | explains | 41 | 40（47） | text_evidence_matched |
| M-K-01-212 | 实数的大小比较 | explains | 39 | 38（45） | text_evidence_matched |
| M-K-01-213 | 不等式的性质 | explains | 40 | 41（48）、42（49） | text_evidence_matched |
| M-K-01-224 | 基本不等式 | introduces | 44 | 44（51） | text_evidence_matched |
| M-K-01-235 | 一元二次不等式 | introduces | 50 | 50（57） | text_evidence_matched |
| M-K-02-111 | 函数 | introduces | 62 | 62（69）、95（102） | text_evidence_matched |
| M-K-02-112 | 定义域 | introduces | 62 | 62（69）、65（72）、95（102）、100（107） | text_evidence_matched |
| M-K-02-113 | 值域 | introduces | 62 | 62（69）、101（108） | text_evidence_matched |
| M-K-02-114 | 区间 | introduces | 63 | 64（71）、95（102） | text_evidence_matched |
| M-K-02-115 | 同一个函数 | explains | 64 | 66（73） | text_evidence_matched |
| M-K-02-116 | 分段函数 | introduces | 68 | 68（75）、93（100）、95（102） | text_evidence_matched |
| M-K-02-117 | 函数的表示法 | explains | 67 | 67（74）、94（101）、96（103）、102（109） | text_evidence_matched |
| M-K-02-1210 | 偶函数 | introduces | 83 | 83（90）、101（108） | text_evidence_matched |
| M-K-02-1211 | 奇函数 | introduces | 84 | 84（91）、101（108） | text_evidence_matched |
| M-K-02-127 | 函数的单调性 | introduces | 77 | 77（84）、100（107）、101（108） | text_evidence_matched |
| M-K-02-128 | 函数的最大值 | introduces | 80 | 80（87）、95（102）、101（108）、102（109） | text_evidence_matched |
| M-K-02-129 | 函数的最小值 | explains | 80 | 80（87）、81（88） | text_evidence_matched |
| M-K-02-1312 | 幂函数 | introduces | 89 | 89（96）、90（97）、100（107） | text_evidence_matched |
| M-K-02-1313 | 对勾函数 | explains | 92 | 92（99）、84（91） | text_evidence_matched |
| M-K-02-211 | n次方根 | introduces | 104 | 104（111） | text_evidence_matched |
| M-K-02-212 | 根式 | introduces | 105 | 104（111）、105（112） | text_evidence_matched |
| M-K-02-213 | 分数指数幂 | introduces | 106 | 106（113） | text_evidence_matched |
| M-K-02-214 | 无理数指数幂 | introduces | 108 | 108（115） | text_evidence_matched |
| M-K-02-215 | 指数函数 | introduces | 113 | 113（120） | text_evidence_matched |
| M-K-02-216 | 指数增长 | explains | 112 | 112（119）、114（121） | text_evidence_matched |
| M-K-02-217 | 指数衰减 | explains | 113 | 113（120）、109（116） | needs_review |
| M-K-02-2210 | 半衰期与倍增期 | explains | 115 | 115（122） | text_evidence_matched |
| M-K-02-2211 | 对数函数 | introduces | 130 | 130（137） | text_evidence_matched |
| M-K-02-2212 | 反函数 | explains | 134 | 135（142） | text_evidence_matched |
| M-K-02-2213 | 三种函数增长的差异 | explains | 136 | 137（144）、138（145） | needs_review |
| M-K-02-2214 | 对数换底公式 | explains | 126 | 125（132） | text_evidence_matched |
| M-K-02-226 | 对数 | introduces | 122 | 122（129）、122（129） | text_evidence_matched |
| M-K-02-227 | 常用对数 | introduces | 122 | 122（129） | text_evidence_matched |
| M-K-02-228 | 自然对数 | introduces | 122 | 122（129） | text_evidence_matched |
| M-K-02-229 | 对数的运算性质 | explains | 125 | 124（131） | text_evidence_matched |
| M-K-02-2313 | 函数的零点 | introduces | 142 | 142（149） | text_evidence_matched |
| M-K-02-2314 | 函数零点存在定理 | introduces | 143 | 143（150） | text_evidence_matched |
| M-K-02-2315 | 二分法 | introduces | 146 | 145（152） | text_evidence_matched |
| M-K-02-311 | 任意角 | introduces | 168 | 168（175）、169（176） | text_evidence_matched |
| M-K-02-312 | 象限角 | introduces | 169 | 169（176） | text_evidence_matched |
| M-K-02-313 | 终边相同的角 | explains | 169 | 170（177） | text_evidence_matched |
| M-K-02-314 | 弧度制 | introduces | 172 | 172（179）、173（180） | text_evidence_matched |
| M-K-02-315 | 弧度与角度的换算 | explains | 173 | 173（180） | text_evidence_matched |
| M-K-02-316 | 弧长公式 | explains | 174 | 174（181） | needs_review |
| M-K-02-317 | 扇形面积公式 | explains | 174 | 174（181） | text_evidence_matched |
| M-K-02-3210 | 正切函数 | introduces | 179 | 178（185） | text_evidence_matched |
| M-K-02-3211 | 三角函数的符号 | explains | 180 | 180（187） | needs_review |
| M-K-02-3212 | 同角三角函数平方关系 | explains | 183 | 183（190） | text_evidence_matched |
| M-K-02-3213 | 同角三角函数商数关系 | explains | 183 | 183（190） | text_evidence_matched |
| M-K-02-328 | 正弦函数 | introduces | 178 | 177（184）、178（185） | text_evidence_matched |
| M-K-02-329 | 余弦函数 | introduces | 178 | 177（184）、178（185） | text_evidence_matched |
| M-K-02-3314 | 公式一 | explains | 188 | 180（187） | text_evidence_matched |
| M-K-02-3315 | 公式二 | explains | 189 | 189（196） | text_evidence_matched |
| M-K-02-3316 | 公式三 | explains | 189 | 189（196） | text_evidence_matched |
| M-K-02-3317 | 公式四 | explains | 190 | 189（196） | text_evidence_matched |
| M-K-02-3318 | 公式五 | explains | 191 | 192（199） | text_evidence_matched |
| M-K-02-3319 | 公式六 | explains | 192 | 192（199） | text_evidence_matched |
| M-K-02-3320 | 两角差的余弦公式 | explains | 215 | 216（223） | text_evidence_matched |
| M-K-02-3321 | 两角和的余弦公式 | explains | 217 | 217（224） | text_evidence_matched |
| M-K-02-3322 | 两角和的正弦公式 | explains | 219 | 218（225） | text_evidence_matched |
| M-K-02-3323 | 两角差的正弦公式 | explains | 219 | 218（225） | text_evidence_matched |
| M-K-02-3324 | 两角和的正切公式 | explains | 220 | 218（225） | text_evidence_matched |
| M-K-02-3325 | 两角差的正切公式 | explains | 220 | 218（225） | text_evidence_matched |
| M-K-02-3326 | 辅助角公式 | applies | 223 | 227（234） | needs_review |
| M-K-02-3327 | 降幂公式 | explains | 221 | 225（232） | text_evidence_matched |
| M-K-02-3328 | 二倍角的正弦公式 | explains | 220 | 221（228） | text_evidence_matched |
| M-K-02-3329 | 二倍角的余弦公式 | explains | 220 | 221（228） | text_evidence_matched |
| M-K-02-3330 | 二倍角的正切公式 | explains | 220 | 221（228） | text_evidence_matched |
| M-K-02-3418 | 正弦函数的图象 | explains | 196 | 197（204）、198（205） | text_evidence_matched |
| M-K-02-3419 | 余弦函数的图象 | explains | 198 | 198（205） | text_evidence_matched |
| M-K-02-3420 | 正切函数的图象 | explains | 207 | 211（218） | text_evidence_matched |
| M-K-02-3421 | 周期函数 | introduces | 200 | 201（208） | text_evidence_matched |
| M-K-02-3422 | 三角函数y=Asin(ωx+φ)的图象变换 | explains | 231 | 236（243）、235（242）、243（250） | text_evidence_matched |
| M-K-02-3423 | 简谐运动 | introduces | 242 | 243（250） | text_evidence_matched |
| M-K-02-3424 | 振幅 | introduces | 244 | 243（250） | text_evidence_matched |
| M-K-02-3425 | 周期与频率 | introduces | 244 | 243（250） | text_evidence_matched |
| M-K-02-3426 | 相位与初相 | introduces | 244 | 243（250） | text_evidence_matched |

## 特殊处理与验证

- 有限/无限集合依据 15—16 页“元素个数”阅读材料；对勾函数依据 84、92 页解析式与性质，未要求教材必须出现旧专名。
- 容斥三集合公式仅有探究任务，不将问题当已给出结论；辅助角公式中的相位条件未由旧 tanφ=b/a 完整规定。
- 最小值采用教材的类比定义任务及 81 页取值例题；降幂公式采用 225 页半角平方公式的等价代换，明确属于解释而非逐字复制。
- 反函数采用 135 页清晰的一般结论，未引用 134 页损坏的 OCR 例题底数；图象变换的周期采用 243 页清晰公式，未引用 234 页错误 OCR。
- 生成时校验 103 个 UID 与原目录集合完全相等、无重复；全部证据引用为真实连续子串，逐页正文 SHA-256 与 textbooks.json 一致；旧映射仍保留 unverified。

# 教材与知识点

本目录保存旧知识点迁移依据、五册教材处理结果和正文映射核对说明。当前主数据在 `data/curriculum/`；`inventory.json` 是迁移开始时的只读历史快照，不代表后续教材处理进度。

```mermaid
flowchart LR
    B[五册教材及文件哈希] --> P[逐页正文及文本哈希]
    K[旧知识树 509 UID] --> L[423 叶知识点及原定义]
    P --> E[原文片段与实际页码]
    L --> M[知识点—教材正文映射]
    E --> M
    M --> I[章节位置候选反向索引]
    M --> R[定义差异与待复核项]
```

## 当前产物

| 文件 | 用途 |
| --- | --- |
| `data/curriculum/textbooks.json` | 五册教材文件身份、18 章、73 节、974 个物理页及逐页文本哈希 |
| `data/curriculum/knowledge-points.json` | 原样迁移 509 个旧 UID：423 个叶知识点、86 个分组；保留名称、定义、父子关系和旧元数据 |
| `data/curriculum/textbook-knowledge-map.json` | 旧页码与目录定位候选、589 条旧映射证据、当前 45 道就绪题的主题 → UID 建议 |
| `data/curriculum/textbook-body-knowledge-map.json` | 逐知识点正文证据、实际物理页/印刷页、关系、语义核对理由、页码差异及待复核项；含章节 → UID 位置候选索引及旧知识关系 |
| `body-map-compulsory-1.md`、`body-map-compulsory-2.md`、`body-map-selective.md` | 分册核对说明及疑点 |
| [正文核对结果](body-mapping-results.md) | 全量覆盖统计、30 项待核验清单及已发现的旧知识树内容缺口 |

本轮 423 个叶节点均有正文记录：393 项语义匹配、30 项待核验、0 项完全未找到；73 个教材节均有正文位置候选关联。这里的匹配不等于教师已审核，具体疑点与版本以生成报告及 JSON 为准。

## 使用边界

教材正文提取已经覆盖五册；扫描 OCR 仍可能损伤公式。正文片段、来源文件哈希、逐页文本哈希共同构成映射依据，不根据册名相同就断言不同版本内容完全等价。

正文映射的 `text_evidence_matched` 表示本轮已对照知识定义与实际正文语义；`needs_review` 表示有相关内容但存在范围、公式或版本问题；`not_found` 表示本轮未找到足够依据。三者均保留知识点 UID，均不冒充教师已审核。分组节点汇总后代叶知识点，不另造覆盖证据。

旧页码只用于寻找正文，出现偏差时保留旧值并另记实际页；旧知识定义也不被静默改写。旧 `mastery_requirement` 继续作为历史知识元数据保存，不能直接当作课标认知等级、题目难度或学生掌握程度。

旧知识关系也完整保留并规范化：283 条 `prerequisites`、155 条 `related_to`，共 438 条；目标 UID 全部存在，前置关系没有发现环。它们仍为 `legacy_unverified`，不能因迁移成功就自动作为本次组卷的允许前提。

组卷时可用这些映射确认知识身份、教材位置和范围；一题是否允许选入，仍须根据本次已学边界、显式前提及完整允许解法判断。题目能力、素养、认知要求要有题目活动证据，不能从教材知识点名称自动继承。

## 重建与检查

```powershell
node scripts/check-curriculum-map.mjs --write
node scripts/check-curriculum-map.mjs
node scripts/check-curriculum-body-map.mjs --write
node scripts/check-curriculum-body-map.mjs
node --test tests/curriculum-map.test.mjs tests/curriculum-body-map.test.mjs
```

默认检查只读，输入变更后显式重建。正文校验会逐条检查 UID、册别、页码、文本哈希以及摘录是否确为该页原文，拒绝缺叶、重复 UID、过期证据或自动提升为教师审核。语义判断由逐项核对记录承担，脚本通过不代替学科审核。

原始教材、OCR 下载及逐页文本保存在本机 `.tutor/curriculum/` 等位置并被 Git 忽略；映射文件保留必要原文片段和哈希。其他机器复核全文须准备清单中的原 PDF，并重建对应文本，不能用缺失的本机缓存冒充已经复查。

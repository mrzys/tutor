# 教材与已有知识点完整迁移映射

本轮建立可追溯的全量迁移关系，不修改旧数据库、现有题包或 `course-context.json`。映射的“完整”指所有旧知识点均保留、所有叶节点均有明确关系或待核验记录；不把覆盖率宣称为正文验收率。

本文说明旧数据迁移层。随后逐项正文核对的结果单独保存在 `data/curriculum/textbook-body-knowledge-map.json`，入口见 [教材与知识点](README.md)。迁移层保留原有 `unverified` 身份，不因新增正文证据而改写旧记录的审核历史；当前正文匹配与疑点以正文映射文件为准。

## 数据文件

- `data/curriculum/knowledge-points.json`：原样保留旧数据库 **509 个 UID、名称、parent_uid、is_leaf、definition、metadata_json、updated_at**。423 个叶、86 个分组；按知识行的规范 JSON hash 形成 `catalogVersion`，同时保存实际库存文件 SHA-256。
- `data/curriculum/textbook-knowledge-map.json`：423 个叶节点每项都有教材关系、原页码值和原文本、保守解析页码、目录定位候选、待核验原因、旧映射证据引用；另含逐题 `primaryTopics` → UID 建议及明确待确认状态。
- `docs/curriculum/inventory.json`：只读采集证据，保留 SQL、观察时点、509 个知识点、旧教材节点、映射和 V2 来源证据。
- `data/curriculum/textbooks.json`：独立教材处理产物；迁移器在其就绪后自动接入五册实际目录及 PDF hash。

知识树的根节点名字全部带“必修”，但其下包含选择性必修内容。册别由每叶 `metadata_json.source_textbook` 确定：必修一 103、必修二 152、选必一 90、选必二 38、选必三 40。映射到 `rja-compulsory-1/2` 和 `rja-selective-1/2/3`，不重编号或强行调整旧树。

已接入五册实际目录（18 章、73 节）；423/423 叶的旧页码均可定位到一个目录节候选，没有因缺少定位而丢弃。**423 条语义覆盖关系仍全部为 unverified**：目录定位覆盖完整，不等于正文内容与知识覆盖已经全部核验。

## 证据与状态

旧 public **63 条**章节关系和 V2 **526 条**块关系分别存为 `evidenceRecords`，共 589 条独立身份。每条保留原记录、原状态、记录 hash、来源 query/hash，以及旧章节点/版次或 V2 revision/hash、块 hash、原文引用、页码与 bbox。它们不会改写 `knowledgePoints` 原档案。

423 个叶关系的 `evidenceRefs` 只引用同 UID 的直接旧关系。分组 UID 的旧映射也完整保留，但不把父节点关系自动复制成每个叶的已确认关系。

| 状态 | 含义 |
| --- | --- |
| `legacy_metadata_only` | 仅有旧知识元数据册名/页码，当前没有接入的目录定位或直接旧映射 |
| `unverified` | 有旧映射证据或目录页码定位候选，但版本与正文知识覆盖尚未核验 |
| `confirmed` | 仅为未来已完成指定版本正文及映射核验保留；本轮校验拒绝自动使用此状态 |
| `pending_uid_mapping` | 题包本地 `primaryTopics` 描述尚待核验为正式 UID；附带的 UID 是内部迁移建议 |

页码解析保留 `originalValue` 的原类型及 `originalText`；支持明确整数、有限升序区间及顿号/逗号列表，反向区间、任意文字或超大区间保持 unparsed。目录区间的推导只产生定位候选，不证明知识点在该节被介绍、讲解或练习；旧元数据缺少其他四册具体版次身份，不能因册名/页码相符自动确认。

旧知识的 `mastery_requirement`（了解/理解/掌握）保留在原元数据中，不能自动转为正式课标等级、题目认知要求或学生掌握状态。能力、核心素养及题目认知要求没有从知识树推断；仍需各自活动证据。

## 题包描述迁移

迁移器按当前就绪台账读取题包，逐题保留 `questionId/contentVersion/teacherVersion` 和全部 `primaryTopics` 文本。首轮 45 题有 51 项 primaryTopics，31 个不同字符串。

已对当前 31 类描述提供显式 UID 建议（例如“集合的确定性”建议 `M-K-01-112`“集合”）；复合描述可建议多个 UID，未认识的新描述保持空建议与 pending。它们是供复核的交叉表，不用于自动覆盖题包、现有范围证据或蓝图筛选；不能把本地细粒度描述压缩到较粗知识点后称为完全等价。

## 执行与校验

```powershell
# 明确重建当前教材/题包版本对应的数据文件
node scripts/check-curriculum-map.mjs --write

# 默认只读完整性检查，不自动改数据
node scripts/check-curriculum-map.mjs

# 完整性负例与语义边界测试
node --test tests/curriculum-map.test.mjs
```

校验覆盖：509 UID 唯一、父节点存在且无环；423 叶映射唯一且不遗漏；五册关系及原页码不丢失；源知识行 hash、库存文件 hash、教材文件 hash；589 旧证据数量/原记录/hash/核验状态；同 UID 证据引用完整；题包版本及 primaryTopics 全量保存；摘要统计与实际关系一致。

教材目录文件或题库版本更新后，默认检查会指出过期关系，须显式重建，不能静默把旧结论当新版本证据。每次的实际数量、各册定位数、待核验数均由命令输出的 `summary` 取得；不能仅依据文档内首轮数字判断当前进度。

本轮 7 项测试通过，包括缺叶/重复 UID/悬空父节点/环、册别误判、原页码类型丢失、旧记录改名、证据升级、题包版本过期等负例。没有提交 Git。

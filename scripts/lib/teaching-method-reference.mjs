import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sections = Object.freeze({
  algebra: '1. 代数与不等式', sequences: '2. 数列', functions: '3. 函数与导数',
  analytic_geometry: '4. 解析几何', trigonometry: '5. 三角', vectors_geometry: '6. 向量与立体几何',
  probability_statistics: '7. 概率统计与计数', sets_logic_complex: '8. 集合、逻辑与复数',
});
const fail = code => Object.assign(new Error(code), { code });

// Explicit caller selection only. This module does not inspect a question or
// infer a teaching category from tags, keywords or model text.
export async function loadTeachingMethodReferences(ids = []) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !Object.hasOwn(sections, id))
    || new Set(ids).size !== ids.length) throw fail('invalid_method_reference_ids');
  if (!ids.length) return [];
  const document = await readFile(new URL('../../docs/design/math-teaching-method-hints.md', import.meta.url), 'utf8');
  const sourceSha256 = createHash('sha256').update(document).digest('hex');
  return ids.map(id => {
    const heading = `### ${sections[id]}`;
    const matches = document.split(/\r?\n/u).filter(line => line === heading);
    if (matches.length !== 1) throw fail('method_reference_section_not_unique');
    const section = document.split(heading)[1].split(/\r?\n### /u)[0];
    const blocks = [...section.matchAll(/```text\s*([\s\S]*?)\s*```/gu)];
    if (blocks.length !== 1 || !blocks[0][1].trim()) throw fail('invalid_method_reference_section');
    return { id, label: sections[id].replace(/^\d+\. /u, ''), text: blocks[0][1].trim(), sourceSha256 };
  });
}

export function appendTeachingMethodReferences(prompt, references) {
  if (typeof prompt !== 'string' || !prompt.trim() || !Array.isArray(references)
    || references.some(ref => !ref || !Object.hasOwn(sections, ref.id)
      || typeof ref.text !== 'string' || !ref.text.trim() || typeof ref.label !== 'string' || !ref.label.trim())
    || new Set(references.map(ref => ref.id)).size !== references.length) throw fail('invalid_method_reference_prompt');
  if (!references.length) return prompt;
  return `${prompt}\n\n【本次附加的方法参考】\n以下是解法选择参考，须核对原题关系与适用条件，不强制套用；正确性与完整性优先。\n${references.map(ref => `【${ref.label}】\n${ref.text}`).join('\n\n')}`;
}

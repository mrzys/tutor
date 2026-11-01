const codeMessages: Record<string, string> = {
  literal_newline_escape: "解析中存在未正确处理的换行符，需修复排版",
  control_character: "解析中存在异常控制字符，需修复排版",
  unpaired_math_delimiter: "解析中的公式标记未成对，需修复公式排版",
  mixed_math_delimiter: "解析中的公式标记混用，需统一公式排版",
  incomplete_teaching_draft: "解析内容不完整，需补充后重新核对",
  teaching_generation_pending: "课堂教学稿尚未生成",
  source_changed: "原题已修改，解析需重新核对",
  generation_interrupted: "解析生成已中断，已有内容已保留",
  review_interrupted: "解析复核已中断，初稿已保留待核对",
  model_request_timeout: "解析处理超时，已有内容已保留，请重试",
  teaching_review_failed_retained_initial: "复核未完成，初稿已保留待核对",
  teaching_classroom_rewrite_required: "极限论证尚未改为高中课堂讲解，初稿已保留待核对",
};

const text = (value: unknown) => typeof value === "string" ? value : "";
const enumCode = (value: string) => /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(value);

/** Display only. Keep the original finding, code and issue text for version
 * binding, acknowledgements and backend eligibility decisions. */
export function teachingFindingMessage(finding: any): string {
  if (finding?.type === "term") return `仍含需复核术语“${text(finding.term)}”`;
  const code = text(finding?.code);
  const detail = [finding?.message, finding?.issue].map(text).find(Boolean) || "";
  if (detail && detail !== code && !enumCode(detail)) return detail;
  const known = codeMessages[code || detail];
  if (typeof known === "string") return known;
  if (!code && !detail) return "";
  switch (finding?.type) {
    case "display": return "解析中存在排版异常，请核对并修复";
    case "format": return "解析结构不符合要求，请检查内容是否完整";
    case "incomplete": return "解析内容不完整，请补充后重新核对";
    case "technical": return "解析处理未完成，已有内容已保留，请查看详情后重试";
    default: return "解析仍有未完成的核对项，请核对相关内容";
  }
}

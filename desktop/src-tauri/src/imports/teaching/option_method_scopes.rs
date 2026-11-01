//! Exact option headings are display identities, never mathematical classifiers.
//! Missing/ambiguous headings leave sentence permissions unchanged.
use super::*;

fn escaped(text: &str, at: usize) -> bool {
    text.as_bytes()[..at].iter().rev().take_while(|v| **v == b'\\').count() % 2 == 1
}

/// Only positions outside balanced supported math can be structural headings.
fn outside_math(text: &str) -> Option<HashSet<usize>> {
    let mut safe = HashSet::new();
    let mut at = 0;
    let mut close: Option<&str> = None;
    while at < text.len() {
        if !escaped(text, at) {
            if let Some(end) = close {
                if text[at..].starts_with(end) {
                    at += end.len();
                    close = None;
                    continue;
                }
            } else {
                let opened = [("$$", "$$"), ("$", "$"), ("\\(", "\\)"), ("\\[", "\\]")]
                    .into_iter().find(|(start, _)| text[at..].starts_with(start));
                if let Some((start, end)) = opened {
                    close = Some(end);
                    at += start.len();
                    continue;
                }
            }
        }
        if close.is_none() { safe.insert(at); }
        at += text[at..].chars().next()?.len_utf8();
    }
    if close.is_some() { return None; }
    safe.insert(text.len());
    Some(safe)
}

pub(super) fn parts(q: &Value, text: &str) -> Vec<(usize, usize, String)> {
    let options = rows(&q["options"]);
    if !(2..=26).contains(&options.len()) || text.contains("```") || text.contains("<pre") || text.contains("<code") {
        return vec![];
    }
    let labels = options.iter().map(|o| s(o, "label")).collect::<Vec<_>>();
    let mut seen = HashSet::new();
    if labels.iter().any(|label| label.len() != 1 || !label.as_bytes()[0].is_ascii_uppercase() || !seen.insert(*label)) {
        return vec![];
    }
    let Some(safe) = outside_math(text) else { return vec![]; };
    // Colon or dot is compulsory, so an isolated variable is never a heading.
    let heading = Regex::new(r"(?m)^[ \t]*(?:\*\*)?([A-Z])(?:\*\*)?[：:．.]([ \t]|[^A-Za-z0-9\r\n])").unwrap();
    let found = heading.captures_iter(text).filter_map(|m| {
        let start = m.get(0)?.start();
        safe.contains(&start).then(|| (start, m[1].to_owned()))
    }).collect::<Vec<_>>();
    if found.len() != labels.len() || found.iter().zip(&labels).any(|((_, got), label)| got != label) {
        return vec![];
    }
    // An explicitly labeled summary is not part of the last option proof.
    let tail = Regex::new(r"(?m)^[ \t]*(?:\*\*)?(?:答案|结论|答案汇总)(?:\*\*)?[：:]").unwrap();
    let summary = tail.find_iter(text).filter(|m| safe.contains(&m.start())).map(|m| m.start()).collect::<Vec<_>>();
    if summary.len() > 1 || summary.first().is_some_and(|at| *at <= found.last().unwrap().0) { return vec![]; }
    let last_end = summary.first().copied().unwrap_or(text.len());
    found.iter().enumerate().map(|(i, (start, label))| {
        let end = found.get(i + 1).map_or(last_end, |next| next.0);
        (text[..*start].chars().count(), text[..end].chars().count(),
            format!("选项{label}的完整相关证明段；共同推导、其他选项及未授权答案保持原样"))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn q() -> Value { json!({"questionType":"multiple_choice","options":[{"label":"A"},{"label":"B"},{"label":"C"},{"label":"D"}]}) }
    #[test]
    fn simulated_exact_options_preserve_common_proof_and_summary() {
        let text="共同推导保持。\nA：正确。\nB：用$\\lim_{x\\to0}h(x)$。\nC：错误。\nD：正确。\n答案：AD。";
        let spans=parts(&q(),text);assert_eq!(spans.len(),4);
        let (_,end,_)=&spans[3];assert_eq!(*end,text[..text.find("答案：").unwrap()].chars().count());
        assert_eq!(text.chars().skip(spans[1].0).take(spans[1].1-spans[1].0).collect::<String>(),"B：用$\\lim_{x\\to0}h(x)$。\n");
        assert!(spans[0].0>0);
    }
    #[test]
    fn simulated_ambiguous_or_incomplete_options_never_grant_whole_proof() {
        for text in ["A：正确。\nB：错误。\nC：正确。", "A：正确。\nB：错误。\nA：重复。\nC：正确。\nD：正确。", "B：错误。\nA：正确。\nC：正确。\nD：正确。", "只写一条正确路线。", "A：正确。\nB：错误。\nC：正确。\nD：$未闭合"] {
            assert!(parts(&q(),text).is_empty(),"{text}");
        }
        let mut source=q();source["options"][1]["label"]=json!("A");
        assert!(parts(&source,"A：正确。\nB：错误。\nC：正确。\nD：正确。").is_empty());
    }
    #[test]
    fn simulated_formula_labels_are_not_option_boundaries() {
        let text="共同公式\n$$\nA：x\nB：y\nC：z\nD：w\n$$\nA：正确。\nB：错误。\nC：正确。\nD：错误。";
        let spans=parts(&q(),text);assert_eq!(spans.len(),4);
        assert_eq!(spans[0].0,text[..text.rfind("A：").unwrap()].chars().count());
        let only_math="$$\nA：x\nB：y\nC：z\nD：w\n$$";
        assert!(parts(&q(),only_math).is_empty());
        assert!(parts(&q(),"\\[\nA：x\nB：y\nC：z\nD：w\n\\]").is_empty());
    }
}

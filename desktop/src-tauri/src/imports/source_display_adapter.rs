//! Explicit, source-preserving rendering compatibility only. Never changes math.
use super::*;

fn invalid() -> AppError {
    err(
        "source_display_adapter_invalid",
        "显示适配须为配对定界及明确允许的完整数列记号，不能修改数学内容。",
    )
}
#[derive(Clone, Copy, PartialEq)]
enum Math {
    Dollar,
    DoubleDollar,
    Parenthesis,
    Bracket,
}
fn escaped(text: &[u8], i: usize) -> bool {
    let mut at = i;
    while at > 0 && text[at - 1] == b'\\' {
        at -= 1;
    }
    (i - at) % 2 == 1
}
fn valid_token(token: &str) -> bool {
    if token.len() > 80 || !token.is_ascii() || !token.starts_with("\\{") || !token.ends_with("\\}")
    {
        return false;
    }
    let body = &token[2..token.len() - 2];
    let mut parts = body.split('_');
    let name = parts.next().unwrap_or("");
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    if let Some(index) = parts.next() {
        let index = if index.starts_with('{') && index.ends_with('}') {
            &index[1..index.len() - 1]
        } else {
            index
        };
        if index.is_empty() || !index.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return false;
        }
    }
    parts.next().is_none()
}
fn text(value: &str, tokens: &[String]) -> AppResult<String> {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    let mut mode = None;
    while i < bytes.len() {
        if !escaped(bytes, i) {
            let tail = &value[i..];
            if tail.starts_with("\\(") || tail.starts_with("\\[") {
                if mode.is_some() {
                    return Err(invalid());
                }
                let display = tail.starts_with("\\[");
                mode = Some(if display {
                    Math::Bracket
                } else {
                    Math::Parenthesis
                });
                out.push_str(if display { "$$" } else { "$" });
                i += 2;
                continue;
            }
            if tail.starts_with("\\)") || tail.starts_with("\\]") {
                let display = tail.starts_with("\\]");
                if mode
                    != Some(if display {
                        Math::Bracket
                    } else {
                        Math::Parenthesis
                    })
                {
                    return Err(invalid());
                }
                out.push_str(if display { "$$" } else { "$" });
                mode = None;
                i += 2;
                continue;
            }
            if bytes[i] == b'$' {
                let double = tail.starts_with("$$");
                let kind = if double {
                    Math::DoubleDollar
                } else {
                    Math::Dollar
                };
                if mode == Some(kind) {
                    mode = None;
                } else if mode.is_none() {
                    mode = Some(kind);
                } else {
                    return Err(invalid());
                }
                out.push_str(if double { "$$" } else { "$" });
                i += if double { 2 } else { 1 };
                continue;
            }
            if mode.is_none() {
                if let Some(token) = tokens.iter().find(|t| tail.starts_with(t.as_str())) {
                    out.push('$');
                    out.push_str(token);
                    out.push('$');
                    i += token.len();
                    continue;
                }
            }
        }
        let ch = value[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    if mode.is_some() {
        return Err(invalid());
    }
    Ok(out)
}
pub(super) fn adapt(raw: &Value, spec: &Value) -> AppResult<Value> {
    if !spec.as_object().is_some_and(|o| {
        o.len() == 2 && o.contains_key("pairedMathDelimiters") && o.contains_key("wrapInlineTokens")
    }) || spec["pairedMathDelimiters"] != true
    {
        return Err(invalid());
    }
    let tokens = spec["wrapInlineTokens"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(invalid)?;
    if tokens.iter().any(|t| !valid_token(t))
        || tokens
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != tokens.len()
    {
        return Err(invalid());
    }
    let mut copy = raw.clone();
    copy["stem"] = json!(text(raw["stem"].as_str().ok_or_else(invalid)?, &tokens)?);
    for field in ["options", "parts"] {
        let expected = if field == "options" { 2 } else { 4 };
        let rows = copy[field].as_array_mut().ok_or_else(invalid)?;
        for row in rows {
            let values = row
                .as_array_mut()
                .filter(|v| v.len() == expected && v.iter().all(Value::is_string))
                .ok_or_else(invalid)?;
            values[1] = json!(text(values[1].as_str().unwrap(), &tokens)?);
        }
    }
    Ok(copy)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw(stem: &str) -> Value {
        json!({"sourceLabel":"13","sourceBlockIds":["p1-b1"],"stem":stem,"options":[["A","\\(x_1\\)"]],"parts":[["(1)","\\[x^2+1\\]","原答案不改","原解析不改"]],"answer":"a","solution":"s"})
    }
    fn spec() -> Value {
        json!({"pairedMathDelimiters":true,"wrapInlineTokens":[]})
    }
    #[test]
    fn paired_delimiters_only_preserve_formula_identity_and_other_fields() {
        let r = raw("已知\\(a_n=\\frac{1}{2}\\)，求\\[S_n\\]");
        let q = adapt(&r, &spec()).unwrap();
        assert_eq!(q["stem"], "已知$a_n=\\frac{1}{2}$，求$$S_n$$");
        assert_eq!(q["options"][0][1], "$x_1$");
        assert_eq!(q["parts"][0][1], "$$x^2+1$$");
        for k in ["sourceLabel", "sourceBlockIds", "answer", "solution"] {
            assert_eq!(q[k], r[k]);
        }
        assert_eq!(q["parts"][0][2], r["parts"][0][2]);
    }
    #[test]
    fn existing_dollars_and_escaped_commands_are_unchanged() {
        let r = raw(r"原式 $x_1+\\alpha$ 与 $$y=2$$，字面\\(不是定界\\)及\$5");
        let q = adapt(&r, &spec()).unwrap();
        assert_eq!(q["stem"], r["stem"]);
    }
    #[test]
    fn incomplete_and_mixed_delimiters_fail_closed() {
        for bad in [r"\(x", r"x\)", r"\(x\]", r"$x\(y\)$", r"\[x$y$\]", r"$x$$"] {
            assert!(adapt(&raw(bad), &spec()).is_err(), "{bad}");
        }
    }
    #[test]
    fn explicit_sequence_token_only_outside_existing_math() {
        let s = json!({"pairedMathDelimiters":true,"wrapInlineTokens":["\\{a_n\\}"]});
        let r = raw(r"数列\{a_n\}，原式$\{a_n\}$和\(\{a_n\}\)，别的\{b_n\}不包裹");
        let q = adapt(&r, &s).unwrap();
        assert_eq!(
            q["stem"],
            r"数列$\{a_n\}$，原式$\{a_n\}$和$\{a_n\}$，别的\{b_n\}不包裹"
        );
    }
    #[test]
    fn token_cannot_inject_words_operators_or_commands() {
        for token in [
            "word",
            "\\{a_n+1\\}",
            "\\{a\\frac{1}{2}\\}",
            "\\{中文\\}",
            "\\{a_n\\}$bad",
        ] {
            assert!(adapt(
                &raw("x"),
                &json!({"pairedMathDelimiters":true,"wrapInlineTokens":[token]})
            )
            .is_err());
        }
    }
}

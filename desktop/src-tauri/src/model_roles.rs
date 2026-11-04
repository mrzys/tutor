//! Explicit import purposes. New verification roles never use a legacy fallback.
use super::*;
const LEGACY_ROLE_KEYS: [&str; 3] = ["sourceParsing", "teachingGeneration", "teachingReview"];
const ACCURACY_ROLE_KEYS: [&str; 4] = [
    "sourceVerification",
    "independentSolve",
    "mathVerification",
    "teachingVerification",
];
const ROLE_KEYS: [&str; 7] = [
    "sourceParsing",
    "teachingGeneration",
    "teachingReview",
    "sourceVerification",
    "independentSolve",
    "mathVerification",
    "teachingVerification",
];
const INDEX_THINKING: &str = "sourceIndexing";

fn valid_role_shape(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        LEGACY_ROLE_KEYS.iter().all(|k| o.contains_key(*k))
            && o.keys().all(|k| ROLE_KEYS.contains(&k.as_str()))
    })
}
fn preserve_missing_accuracy_fields(value: &Value, previous: Option<Value>) -> Value {
    let mut next = value.clone();
    if let (Some(input), Some(old)) = (
        next.as_object_mut(),
        previous.as_ref().and_then(Value::as_object),
    ) {
        for key in ACCURACY_ROLE_KEYS {
            if !input.contains_key(key) {
                if let Some(saved) = old.get(key) {
                    input.insert(key.into(), saved.clone());
                }
            }
        }
    }
    next
}
fn role_label(role: &str) -> AppResult<&'static str> {
    match role {
        "sourceParsing" => Ok("拆题"),
        "teachingGeneration" => Ok("解析生成"),
        "teachingReview" => Ok("解析复核"),
        "sourceVerification" => Ok("来源核验"),
        "independentSolve" => Ok("独立求解"),
        "mathVerification" => Ok("数学核验"),
        "teachingVerification" => Ok("教学核验"),
        _ => Err(input_error("导入模型用途无效。")),
    }
}
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportRoles {
    pub source_parsing: Option<String>,
    pub teaching_generation: Option<String>,
    pub teaching_review: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_verification: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independent_solve: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub math_verification: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teaching_verification: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RoleThinkingOverride {
    pub profile_id: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportRoleThinking {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_indexing: Option<RoleThinkingOverride>,
    pub source_parsing: Option<RoleThinkingOverride>,
    pub teaching_generation: Option<RoleThinkingOverride>,
    pub teaching_review: Option<RoleThinkingOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_verification: Option<RoleThinkingOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independent_solve: Option<RoleThinkingOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub math_verification: Option<RoleThinkingOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teaching_verification: Option<RoleThinkingOverride>,
}

impl ImportRoleThinking {
    pub(super) fn parse(
        value: &Value,
        roles: Option<&ImportRoles>,
        profiles: &[ModelProfile],
    ) -> AppResult<Option<Self>> {
        if value.is_null() {
            return Ok(None);
        }
        let mut role_shape = value.clone();
        if let Some(object) = role_shape.as_object_mut() { object.remove(INDEX_THINKING); }
        if !valid_role_shape(&role_shape) {
            return Err(input_error(
                "用途思考设置须包含拆题、解析生成和解析复核三项。",
            ));
        }
        let thinking: Self = serde_json::from_value(value.clone())
            .map_err(|_| input_error("用途思考设置格式无效。"))?;
        for role in ROLE_KEYS.into_iter().chain([INDEX_THINKING]) {
            if let Some(setting) = thinking.setting(role) {
                setting.validate(role, roles, profiles)?;
            }
        }
        Ok(Some(thinking))
    }

    /// Clients which only know the original purposes cannot erase newer bindings.
    pub(super) fn parse_updated(
        value: &Value,
        previous: Option<&Self>,
        roles: Option<&ImportRoles>,
        profiles: &[ModelProfile],
    ) -> AppResult<Option<Self>> {
        let previous = previous
            .and_then(|p| p.retain_matching(roles, profiles))
            .map(|p| serde_json::to_value(p))
            .transpose()?;
        let mut updated = preserve_missing_accuracy_fields(value, previous.clone());
        if let Some(input) = updated.as_object_mut() {
            if !input.contains_key(INDEX_THINKING) {
                if let Some(saved) = previous.as_ref().and_then(|p| p.get(INDEX_THINKING)) {
                    input.insert(INDEX_THINKING.into(), saved.clone());
                }
            }
        }
        Self::parse(&updated, roles, profiles)
    }

    fn setting(&self, role: &str) -> Option<&RoleThinkingOverride> {
        match role {
            "sourceIndexing" => self.source_indexing.as_ref(),
            "sourceParsing" => self.source_parsing.as_ref(),
            "teachingGeneration" => self.teaching_generation.as_ref(),
            "teachingReview" => self.teaching_review.as_ref(),
            "sourceVerification" => self.source_verification.as_ref(),
            "independentSolve" => self.independent_solve.as_ref(),
            "mathVerification" => self.math_verification.as_ref(),
            "teachingVerification" => self.teaching_verification.as_ref(),
            _ => None,
        }
    }

    /// A saved old client may change its profile or role without knowing about
    /// overrides. Clear only bindings invalidated by that explicit save.
    pub(super) fn retain_matching(
        &self,
        roles: Option<&ImportRoles>,
        profiles: &[ModelProfile],
    ) -> Option<Self> {
        let roles = roles?;
        let valid = |role: &str, setting: &Option<RoleThinkingOverride>| {
            setting
                .as_ref()
                .filter(|setting| setting.validate(role, Some(roles), profiles).is_ok())
                .cloned()
        };
        Some(Self {
            source_indexing: valid(INDEX_THINKING, &self.source_indexing),
            source_parsing: valid("sourceParsing", &self.source_parsing),
            teaching_generation: valid("teachingGeneration", &self.teaching_generation),
            teaching_review: valid("teachingReview", &self.teaching_review),
            source_verification: valid("sourceVerification", &self.source_verification),
            independent_solve: valid("independentSolve", &self.independent_solve),
            math_verification: valid("mathVerification", &self.math_verification),
            teaching_verification: valid("teachingVerification", &self.teaching_verification),
        })
    }
}

impl RoleThinkingOverride {
    fn validate(
        &self,
        role: &str,
        roles: Option<&ImportRoles>,
        profiles: &[ModelProfile],
    ) -> AppResult<()> {
        let profile = roles
            .and_then(|roles| roles.id(if role == INDEX_THINKING { "sourceParsing" } else { role }).ok().flatten())
            .and_then(|id| profiles.iter().find(|profile| profile.id == id))
            .ok_or_else(|| input_error("请先为对应用途选择模型配置，再设置思考强度。"))?;
        if self.profile_id != profile.id
            || self.provider != model_provider(&profile.base_url).unwrap_or("")
            || self.model != profile.model
        {
            return Err(input_error(
                "用途思考设置与所选模型配置不匹配，请重新选择思考设置。",
            ));
        }
        validate_reasoning_effort(&profile.base_url, &profile.model, &self.reasoning_effort)
    }
}
impl ImportRoles {
    pub(super) fn parse(value: &Value, profiles: &[ModelProfile]) -> AppResult<Option<Self>> {
        if value.is_null() {
            return Ok(None);
        }
        if !valid_role_shape(value) {
            return Err(input_error(
                "导入模型用途须同时包含拆题、教学解析和复核三项，值为配置标识或空。",
            ));
        }
        let roles: Self = serde_json::from_value(value.clone())
            .map_err(|_| input_error("导入模型用途格式无效。"))?;
        for id in ROLE_KEYS
            .into_iter()
            .filter_map(|role| roles.id(role).ok().flatten())
        {
            if id.is_empty()
                || id.len() > 120
                || id != id.trim()
                || id.chars().any(char::is_control)
                || !profiles.iter().any(|p| p.id == id)
            {
                return Err(input_error(
                    "导入模型用途引用了不存在的配置；删除前请同时清空或改选相关用途。",
                ));
            }
        }
        Ok(Some(roles))
    }
    pub(super) fn parse_updated(
        value: &Value,
        previous: Option<&Self>,
        profiles: &[ModelProfile],
    ) -> AppResult<Option<Self>> {
        let previous = previous.map(serde_json::to_value).transpose()?;
        Self::parse(&preserve_missing_accuracy_fields(value, previous), profiles)
    }
    fn id(&self, role: &str) -> AppResult<Option<&str>> {
        match role {
            "sourceParsing" => Ok(self.source_parsing.as_deref()),
            "teachingGeneration" => Ok(self.teaching_generation.as_deref()),
            "teachingReview" => Ok(self.teaching_review.as_deref()),
            "sourceVerification" => Ok(self.source_verification.as_deref()),
            "independentSolve" => Ok(self.independent_solve.as_deref()),
            "mathVerification" => Ok(self.math_verification.as_deref()),
            "teachingVerification" => Ok(self.teaching_verification.as_deref()),
            _ => Err(input_error("导入模型用途无效。")),
        }
    }
}
impl ModelClient {
    pub(super) fn explicit_import_model(&self, role: &str) -> AppResult<Option<Self>> {
        let label = role_label(role)?;
        let Some(roles) = &self.import_roles else {
            return Ok(None);
        };
        let id = roles.id(role)?.ok_or_else(|| {
            AppError::new(
                "import_model_not_configured",
                format!("请为{label}明确选择一套模型配置。"),
            )
        })?;
        let profile = self
            .profiles
            .iter()
            .find(|p| p.id == id)
            .filter(|p| p.configured())
            .ok_or_else(|| {
                AppError::new(
                    "import_model_not_configured",
                    format!("{label}的模型配置不可用，请检查对应配置和密钥。"),
                )
            })?;
        let mut selected = self.clone();
        selected.active_profile_id = Some(profile.id.clone());
        selected.sync_active();
        if let Some(thinking) = self
            .import_role_thinking
            .as_ref()
            .and_then(|thinking| thinking.setting(role))
        {
            thinking.validate(role, Some(roles), &self.profiles)?;
            selected.reasoning_effort = Some(thinking.reasoning_effort.clone());
        }
        // A purpose override never mutates the saved profile or the general model.
        Ok(Some(selected))
    }
    pub(crate) fn import_source_model(&self) -> AppResult<Self> {
        if let Some(selected) = self.explicit_import_model("sourceParsing")? {
            return Ok(selected);
        }
        self.import_role("deepseek", "deepseek-flash", "low")
    }
    /// The index is a thinking override of the processing profile, not a third
    /// model assignment. Missing old settings retain the source purpose exactly.
    pub(crate) fn import_source_index_model(&self) -> AppResult<Self> {
        let mut selected = self.import_source_model()?;
        if self.accuracy_binding.as_ref().is_some_and(|b| b["sourceIndexingEnabled"] != true) {
            return Ok(selected);
        }
        if let Some(thinking) = self.import_role_thinking.as_ref().and_then(|t| t.source_indexing.as_ref()) {
            thinking.validate(INDEX_THINKING, self.import_roles.as_ref(), &self.profiles)?;
            selected.reasoning_effort = Some(thinking.reasoning_effort.clone());
        }
        Ok(selected)
    }
    pub(crate) fn source_index_thinking_explicit(&self) -> bool {
        self.import_role_thinking.as_ref().is_some_and(|t| t.source_indexing.is_some())
    }
    pub(crate) fn source_index_thinking_enabled(&self) -> bool {
        self.source_index_thinking_explicit()
            && !self.accuracy_binding.as_ref().is_some_and(|b| b["sourceIndexingEnabled"] != true)
    }
    pub(crate) fn without_source_index_thinking(&self) -> Self {
        let mut selected = self.clone();
        if let Some(thinking) = selected.import_role_thinking.as_mut() { thinking.source_indexing = None; }
        selected
    }
    pub(crate) fn import_source_role_explicit(&self) -> bool {
        self.import_roles.is_some()
    }
    /// New stages require their own saved purpose, even for legacy-mode profiles.
    pub(crate) fn import_accuracy_model(&self, role: &str) -> AppResult<Self> {
        if !ACCURACY_ROLE_KEYS.contains(&role) {
            return Err(input_error("准确性核验模型用途无效。"));
        }
        self.explicit_import_model(role)?.ok_or_else(|| {
            AppError::new(
                "import_model_not_configured",
                format!(
                    "请为{}明确选择一套模型配置。",
                    role_label(role).unwrap_or("核验")
                ),
            )
        })
    }
    pub(super) fn effective_import_roles(&self) -> Value {
        let summarize = |role: &str, result: AppResult<Self>| {
            let explicit = self.import_roles.is_some() || ACCURACY_ROLE_KEYS.contains(&role);
            match result {
                Ok(client) => {
                    let overridden = self
                        .import_role_thinking
                        .as_ref()
                        .and_then(|thinking| thinking.setting(role))
                        .is_some();
                    json!({"strategy":if explicit{"explicit"}else{"legacy"},"profileId":client.active_profile_id,"provider":model_provider(&client.base_url),"model":client.model,"reasoningEffort":client.reasoning_effort,"reasoningSource":if !explicit{"legacy"}else if overridden{"purpose"}else{"profile"},"configured":client.configured()})
                }
                Err(error) => {
                    json!({"strategy":if explicit{"explicit"}else{"legacy"},"profileId":null,"configured":false,"error":error})
                }
            }
        };
        let mut result = json!({"sourceParsing":summarize("sourceParsing",self.import_source_model()),"teachingGeneration":summarize("teachingGeneration",self.import_generator()),"teachingReview":summarize("teachingReview",self.import_teaching_reviewer())});
        if self.source_index_thinking_explicit() {
            result[INDEX_THINKING] = summarize(INDEX_THINKING, self.import_source_index_model());
        }
        for role in ACCURACY_ROLE_KEYS {
            result[role] = summarize(role, self.import_accuracy_model(role));
        }
        result
    }
}
#[cfg(test)]
#[path = "model_roles/tests.rs"]
mod tests;

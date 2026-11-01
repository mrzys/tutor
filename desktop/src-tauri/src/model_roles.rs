//! Three explicitly selected import purposes, independent of the general model.
use super::*;
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportRoles {
    pub source_parsing: Option<String>,
    pub teaching_generation: Option<String>,
    pub teaching_review: Option<String>,
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
    pub source_parsing: Option<RoleThinkingOverride>,
    pub teaching_generation: Option<RoleThinkingOverride>,
    pub teaching_review: Option<RoleThinkingOverride>,
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
        const KEYS: [&str; 3] = ["sourceParsing", "teachingGeneration", "teachingReview"];
        if !value
            .as_object()
            .is_some_and(|o| o.len() == 3 && KEYS.iter().all(|k| o.contains_key(*k)))
        {
            return Err(input_error(
                "用途思考设置须包含拆题、解析生成和解析复核三项。",
            ));
        }
        let thinking: Self = serde_json::from_value(value.clone())
            .map_err(|_| input_error("用途思考设置格式无效。"))?;
        for role in KEYS {
            if let Some(setting) = thinking.setting(role) {
                setting.validate(role, roles, profiles)?;
            }
        }
        Ok(Some(thinking))
    }

    fn setting(&self, role: &str) -> Option<&RoleThinkingOverride> {
        match role {
            "sourceParsing" => self.source_parsing.as_ref(),
            "teachingGeneration" => self.teaching_generation.as_ref(),
            "teachingReview" => self.teaching_review.as_ref(),
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
            source_parsing: valid("sourceParsing", &self.source_parsing),
            teaching_generation: valid("teachingGeneration", &self.teaching_generation),
            teaching_review: valid("teachingReview", &self.teaching_review),
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
            .and_then(|roles| roles.id(role).ok().flatten())
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
        const KEYS: [&str; 3] = ["sourceParsing", "teachingGeneration", "teachingReview"];
        if !value
            .as_object()
            .is_some_and(|o| o.len() == 3 && KEYS.iter().all(|k| o.contains_key(*k)))
        {
            return Err(input_error(
                "导入模型用途须同时包含拆题、教学解析和复核三项，值为配置标识或空。",
            ));
        }
        let roles: Self = serde_json::from_value(value.clone())
            .map_err(|_| input_error("导入模型用途格式无效。"))?;
        for id in [
            &roles.source_parsing,
            &roles.teaching_generation,
            &roles.teaching_review,
        ]
        .into_iter()
        .flatten()
        {
            if id.is_empty()
                || id.len() > 120
                || id != id.trim()
                || id.chars().any(char::is_control)
                || !profiles.iter().any(|p| p.id == *id)
            {
                return Err(input_error(
                    "导入模型用途引用了不存在的配置；删除前请同时清空或改选相关用途。",
                ));
            }
        }
        Ok(Some(roles))
    }
    fn id(&self, role: &str) -> AppResult<Option<&str>> {
        match role {
            "sourceParsing" => Ok(self.source_parsing.as_deref()),
            "teachingGeneration" => Ok(self.teaching_generation.as_deref()),
            "teachingReview" => Ok(self.teaching_review.as_deref()),
            _ => Err(input_error("导入模型用途无效。")),
        }
    }
}
impl ModelClient {
    pub(super) fn explicit_import_model(&self, role: &str) -> AppResult<Option<Self>> {
        let Some(roles) = &self.import_roles else {
            return Ok(None);
        };
        let label = match role {
            "sourceParsing" => "拆题",
            "teachingGeneration" => "解析生成",
            "teachingReview" => "解析复核",
            _ => return Err(input_error("导入模型用途无效。")),
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
    pub(crate) fn import_source_role_explicit(&self) -> bool {
        self.import_roles.is_some()
    }
    pub(super) fn effective_import_roles(&self) -> Value {
        let summarize = |role: &str, result: AppResult<Self>| match result {
            Ok(client) => {
                let overridden = self
                    .import_role_thinking
                    .as_ref()
                    .and_then(|thinking| thinking.setting(role))
                    .is_some();
                json!({"strategy":if self.import_roles.is_some(){"explicit"}else{"legacy"},"profileId":client.active_profile_id,"provider":model_provider(&client.base_url),"model":client.model,"reasoningEffort":client.reasoning_effort,"reasoningSource":if self.import_roles.is_none(){"legacy"}else if overridden{"purpose"}else{"profile"},"configured":client.configured()})
            }
            Err(error) => {
                json!({"strategy":if self.import_roles.is_some(){"explicit"}else{"legacy"},"profileId":null,"configured":false,"error":error})
            }
        };
        json!({"sourceParsing":summarize("sourceParsing",self.import_source_model()),"teachingGeneration":summarize("teachingGeneration",self.import_generator()),"teachingReview":summarize("teachingReview",self.import_teaching_reviewer())})
    }
}
#[cfg(test)]
#[path = "model_roles/tests.rs"]
mod tests;

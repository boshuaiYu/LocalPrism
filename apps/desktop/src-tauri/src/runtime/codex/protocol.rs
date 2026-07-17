use crate::runtime::{RuntimeAccount, RuntimeCapabilities, RuntimeKind, RuntimeModel};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializeParams {
    client_info: ClientInfo,
    capabilities: InitializeCapabilities,
}

impl InitializeParams {
    pub(crate) fn new(version: &str) -> Self {
        Self {
            client_info: ClientInfo {
                name: "claude-prism",
                title: "ClaudePrism",
                version: version.to_owned(),
            },
            capabilities: InitializeCapabilities {
                experimental_api: true,
            },
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    name: &'static str,
    title: &'static str,
    version: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeCapabilities {
    experimental_api: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Account {
    ApiKey,
    Chatgpt {
        email: Option<String>,
        #[serde(rename = "planType")]
        plan_type: String,
    },
    AmazonBedrock {
        #[serde(default, rename = "credentialSource")]
        credential_source: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(serde::Serialize)]
#[serde(transparent)]
pub(crate) struct LoginAccountParams(LoginAccountRequest);

#[derive(serde::Serialize)]
#[serde(tag = "type")]
enum LoginAccountRequest {
    #[serde(rename = "chatgpt")]
    Chatgpt {
        #[serde(rename = "codexStreamlinedLogin")]
        codex_streamlined_login: bool,
    },
    #[serde(rename = "chatgptDeviceCode")]
    ChatgptDeviceCode,
    #[serde(rename = "apiKey")]
    ApiKey {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
}

impl LoginAccountParams {
    pub(crate) fn chatgpt() -> Self {
        Self(LoginAccountRequest::Chatgpt {
            codex_streamlined_login: true,
        })
    }

    pub(crate) fn chatgpt_device_code() -> Self {
        Self(LoginAccountRequest::ChatgptDeviceCode)
    }

    pub(crate) fn api_key(api_key: String) -> Self {
        Self(LoginAccountRequest::ApiKey { api_key })
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetAccountParams {
    #[serde(default)]
    pub(crate) refresh_token: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetAccountResponse {
    pub(crate) account: Option<Account>,
    pub(crate) requires_openai_auth: bool,
}

impl GetAccountResponse {
    pub(crate) fn into_runtime_account(
        self,
        installed: bool,
        version: Option<String>,
    ) -> RuntimeAccount {
        let authenticated = self.account.is_some() || !self.requires_openai_auth;
        let (account_label, auth_mode) = match self.account {
            Some(Account::ApiKey) => (None, Some("apiKey".to_string())),
            Some(Account::Chatgpt { email, .. }) => (email, Some("chatgpt".to_string())),
            Some(Account::AmazonBedrock { .. }) => (None, Some("amazonBedrock".to_string())),
            Some(Account::Unknown) => (None, Some("unknown".to_string())),
            None => (None, None),
        };

        RuntimeAccount {
            runtime: RuntimeKind::Codex,
            installed,
            authenticated,
            version,
            account_label,
            auth_mode,
            capabilities: RuntimeCapabilities {
                models: true,
                skills: true,
                custom_agents: true,
                subagents: true,
                approvals: true,
            },
            error: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub(crate) enum LoginAccountResponse {
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "chatgpt")]
    Chatgpt {
        #[serde(rename = "authUrl")]
        auth_url: String,
        #[serde(rename = "loginId")]
        login_id: String,
    },
    #[serde(rename = "chatgptDeviceCode")]
    ChatgptDeviceCode {
        #[serde(rename = "verificationUrl")]
        verification_url: String,
        #[serde(rename = "userCode")]
        user_code: String,
        #[serde(rename = "loginId")]
        login_id: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelLoginAccountParams {
    pub(crate) login_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CancelLoginAccountStatus {
    Canceled,
    NotFound,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelLoginAccountResponse {
    pub(crate) status: CancelLoginAccountStatus,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
pub(crate) struct LogoutAccountResponse {}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountLoginCompletedNotification {
    pub(crate) login_id: Option<String>,
    pub(crate) success: bool,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountUpdatedNotification {
    pub(crate) auth_mode: Option<String>,
    pub(crate) plan_type: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) include_hidden: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReasoningEffortOption {
    pub(crate) reasoning_effort: String,
    pub(crate) description: String,
}

fn default_input_modalities() -> Vec<String> {
    vec!["text".to_string(), "image".to_string()]
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    pub(crate) id: String,
    pub(crate) model: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) hidden: bool,
    pub(crate) supported_reasoning_efforts: Vec<ReasoningEffortOption>,
    pub(crate) default_reasoning_effort: String,
    #[serde(default = "default_input_modalities")]
    pub(crate) input_modalities: Vec<String>,
    pub(crate) is_default: bool,
}

impl Model {
    pub(crate) fn into_runtime_model(self) -> RuntimeModel {
        RuntimeModel {
            runtime: RuntimeKind::Codex,
            id: self.model,
            display_name: self.display_name,
            description: Some(self.description),
            reasoning_efforts: self
                .supported_reasoning_efforts
                .into_iter()
                .map(|option| option.reasoning_effort)
                .collect(),
            default_reasoning_effort: Some(self.default_reasoning_effort),
            input_modalities: self.input_modalities,
            is_default: self.is_default,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelListResponse {
    pub(crate) data: Vec<Model>,
    pub(crate) next_cursor: Option<String>,
}

impl ModelListResponse {
    pub(crate) fn into_visible_runtime_models(self) -> Vec<RuntimeModel> {
        self.data
            .into_iter()
            .filter(|model| !model.hidden)
            .map(Model::into_runtime_model)
            .collect()
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadStartParams {
    cwd: String,
    model: String,
    approval_policy: &'static str,
    sandbox: &'static str,
    thread_source: &'static str,
}

impl ThreadStartParams {
    pub(crate) fn new(cwd: String, model: String) -> Self {
        Self {
            cwd,
            model,
            approval_policy: "on-request",
            sandbox: "workspace-write",
            thread_source: "user",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadResumeParams {
    thread_id: String,
}

impl ThreadResumeParams {
    pub(crate) fn new(thread_id: String) -> Self {
        Self { thread_id }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
enum UserInput {
    Text { text: String },
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnStartParams {
    thread_id: String,
    input: Vec<UserInput>,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
}

impl TurnStartParams {
    pub(crate) fn new(
        thread_id: String,
        prompt: String,
        model: String,
        effort: Option<String>,
    ) -> Self {
        Self {
            thread_id,
            input: vec![UserInput::Text { text: prompt }],
            model,
            effort,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnInterruptParams {
    thread_id: String,
    turn_id: String,
}

impl TurnInterruptParams {
    pub(crate) fn new(thread_id: String, turn_id: String) -> Self {
        Self { thread_id, turn_id }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadReadParams {
    thread_id: String,
    include_turns: bool,
}

impl ThreadReadParams {
    pub(crate) fn new(thread_id: String, include_turns: bool) -> Self {
        Self {
            thread_id,
            include_turns,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadArchiveParams {
    thread_id: String,
}

impl ThreadArchiveParams {
    pub(crate) fn new(thread_id: String) -> Self {
        Self { thread_id }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadListParams {
    archived: bool,
    cwd: String,
    limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

impl ThreadListParams {
    pub(crate) fn new(cwd: String, cursor: Option<String>) -> Self {
        Self {
            archived: false,
            cwd,
            limit: 100,
            cursor,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct ThreadStatus {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Thread {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) preview: String,
    pub(crate) cwd: String,
    pub(crate) updated_at: i64,
    pub(crate) status: ThreadStatus,
    #[serde(default)]
    pub(crate) turns: Vec<Turn>,
}

impl Thread {
    pub(crate) fn status_name(&self) -> &str {
        &self.status.kind
    }
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Turn {
    pub(crate) id: String,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) items: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) error: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub(crate) struct ThreadStartResponse {
    pub(crate) thread: Thread,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub(crate) struct ThreadResumeResponse {
    pub(crate) thread: Thread,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub(crate) struct TurnStartResponse {
    pub(crate) turn: Turn,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadListResponse {
    pub(crate) data: Vec<Thread>,
    #[serde(default)]
    pub(crate) next_cursor: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub(crate) struct ThreadReadResponse {
    pub(crate) thread: Thread,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq, Default)]
pub(crate) struct TurnInterruptResponse {}

#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq, Default)]
pub(crate) struct ThreadArchiveResponse {}

#[cfg(test)]
mod tests {
    use super::{
        Account, AccountLoginCompletedNotification, AccountUpdatedNotification,
        CancelLoginAccountParams, CancelLoginAccountResponse, CancelLoginAccountStatus,
        GetAccountParams, GetAccountResponse, InitializeParams, LoginAccountParams,
        LoginAccountResponse, LogoutAccountResponse, ModelListParams, ModelListResponse,
        ThreadArchiveParams, ThreadArchiveResponse, ThreadListParams, ThreadListResponse,
        ThreadReadParams, ThreadReadResponse, ThreadResumeParams, ThreadResumeResponse,
        ThreadStartParams, ThreadStartResponse, TurnInterruptParams, TurnInterruptResponse,
        TurnStartParams, TurnStartResponse,
    };
    use crate::runtime::{RuntimeCapabilities, RuntimeKind};
    use serde_json::json;

    #[test]
    fn initialize_params_use_the_required_client_identity_and_experimental_api_capability(
    ) -> Result<(), serde_json::Error> {
        let value = serde_json::to_value(InitializeParams::new("1.3.0"))?;

        assert_eq!(
            value,
            json!({
                "clientInfo": {
                    "name": "claude-prism",
                    "title": "ClaudePrism",
                    "version": "1.3.0"
                },
                "capabilities": {
                    "experimentalApi": true
                }
            })
        );
        Ok(())
    }

    #[test]
    fn account_and_models_account_states_convert_without_auth_fallbacks(
    ) -> Result<(), serde_json::Error> {
        let chatgpt: GetAccountResponse = serde_json::from_value(json!({
            "account": {
                "type": "chatgpt",
                "email": "person@example.com",
                "planType": "plus"
            },
            "requiresOpenaiAuth": true
        }))?;
        let chatgpt = chatgpt.into_runtime_account(true, Some("0.135.0".into()));
        assert_eq!(chatgpt.runtime, RuntimeKind::Codex);
        assert!(chatgpt.installed);
        assert!(chatgpt.authenticated);
        assert_eq!(chatgpt.version.as_deref(), Some("0.135.0"));
        assert_eq!(chatgpt.account_label.as_deref(), Some("person@example.com"));
        assert_eq!(chatgpt.auth_mode.as_deref(), Some("chatgpt"));
        assert_eq!(
            chatgpt.capabilities,
            RuntimeCapabilities {
                models: true,
                skills: true,
                custom_agents: true,
                subagents: true,
                approvals: true,
            }
        );
        assert_eq!(chatgpt.error, None);

        let api_key: GetAccountResponse = serde_json::from_value(json!({
            "account": { "type": "apiKey" },
            "requiresOpenaiAuth": true
        }))?;
        let api_key = api_key.into_runtime_account(true, None);
        assert!(api_key.authenticated);
        assert_eq!(api_key.account_label, None);
        assert_eq!(api_key.auth_mode.as_deref(), Some("apiKey"));

        let logged_out: GetAccountResponse = serde_json::from_value(json!({
            "account": null,
            "requiresOpenaiAuth": true
        }))?;
        let logged_out = logged_out.into_runtime_account(true, None);
        assert!(!logged_out.authenticated);
        assert_eq!(logged_out.auth_mode, None);

        let no_auth_required: GetAccountResponse = serde_json::from_value(json!({
            "account": null,
            "requiresOpenaiAuth": false
        }))?;
        let no_auth_required = no_auth_required.into_runtime_account(true, None);
        assert!(no_auth_required.authenticated);
        assert_eq!(no_auth_required.auth_mode, None);

        let bedrock: GetAccountResponse = serde_json::from_value(json!({
            "account": {
                "type": "amazonBedrock",
                "credentialSource": "codexManaged"
            },
            "requiresOpenaiAuth": false
        }))?;
        let bedrock = bedrock.into_runtime_account(true, None);
        assert!(bedrock.authenticated);
        assert_eq!(bedrock.auth_mode.as_deref(), Some("amazonBedrock"));

        let unknown: GetAccountResponse = serde_json::from_value(json!({
            "account": {
                "type": "futureManagedAuth",
                "opaqueFutureField": { "nested": true }
            },
            "requiresOpenaiAuth": true
        }))?;
        assert!(matches!(unknown.account.as_ref(), Some(Account::Unknown)));
        let unknown = unknown.into_runtime_account(true, None);
        assert!(unknown.authenticated);
        assert_eq!(unknown.auth_mode.as_deref(), Some("unknown"));

        Ok(())
    }

    #[test]
    fn account_and_models_login_requests_have_exact_secret_minimal_wire_shapes(
    ) -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_value(LoginAccountParams::chatgpt())?,
            json!({
                "type": "chatgpt",
                "codexStreamlinedLogin": true
            })
        );
        assert_eq!(
            serde_json::to_value(LoginAccountParams::chatgpt_device_code())?,
            json!({ "type": "chatgptDeviceCode" })
        );

        // This is a non-secret sentinel. LoginAccountParams deliberately has no Debug impl,
        // so callers cannot accidentally include the actual request credential in debug logs.
        assert_eq!(
            serde_json::to_value(LoginAccountParams::api_key("<api-key>".into()))?,
            json!({
                "type": "apiKey",
                "apiKey": "<api-key>"
            })
        );

        Ok(())
    }

    #[test]
    fn account_and_models_login_responses_cancel_logout_and_notifications_parse(
    ) -> Result<(), serde_json::Error> {
        let browser: LoginAccountResponse = serde_json::from_value(json!({
            "type": "chatgpt",
            "authUrl": "https://chatgpt.example/authorize",
            "loginId": "login-browser"
        }))?;
        assert!(matches!(
            browser,
            LoginAccountResponse::Chatgpt {
                ref auth_url,
                ref login_id
            } if auth_url == "https://chatgpt.example/authorize" && login_id == "login-browser"
        ));

        let device: LoginAccountResponse = serde_json::from_value(json!({
            "type": "chatgptDeviceCode",
            "verificationUrl": "https://auth.example/device",
            "userCode": "ABCD-EFGH",
            "loginId": "login-device"
        }))?;
        assert!(matches!(
            device,
            LoginAccountResponse::ChatgptDeviceCode {
                ref verification_url,
                ref user_code,
                ref login_id
            } if verification_url == "https://auth.example/device"
                && user_code == "ABCD-EFGH"
                && login_id == "login-device"
        ));

        let api_key: LoginAccountResponse = serde_json::from_value(json!({ "type": "apiKey" }))?;
        assert!(matches!(api_key, LoginAccountResponse::ApiKey));

        assert_eq!(
            serde_json::to_value(GetAccountParams {
                refresh_token: false,
            })?,
            json!({ "refreshToken": false })
        );
        assert_eq!(
            serde_json::to_value(CancelLoginAccountParams {
                login_id: "login-device".into(),
            })?,
            json!({ "loginId": "login-device" })
        );
        let canceled: CancelLoginAccountResponse =
            serde_json::from_value(json!({ "status": "canceled" }))?;
        assert_eq!(canceled.status, CancelLoginAccountStatus::Canceled);
        let missing: CancelLoginAccountResponse =
            serde_json::from_value(json!({ "status": "notFound" }))?;
        assert_eq!(missing.status, CancelLoginAccountStatus::NotFound);

        let _: LogoutAccountResponse = serde_json::from_value(json!({}))?;

        let completed: AccountLoginCompletedNotification = serde_json::from_value(json!({
            "loginId": "login-browser",
            "success": true,
            "error": null
        }))?;
        assert_eq!(completed.login_id.as_deref(), Some("login-browser"));
        assert!(completed.success);
        assert_eq!(completed.error, None);

        let updated: AccountUpdatedNotification = serde_json::from_value(json!({
            "authMode": "chatgpt",
            "planType": "plus"
        }))?;
        assert_eq!(updated.auth_mode.as_deref(), Some("chatgpt"));
        assert_eq!(updated.plan_type.as_deref(), Some("plus"));

        let logged_out: AccountUpdatedNotification = serde_json::from_value(json!({
            "authMode": null,
            "planType": null
        }))?;
        assert_eq!(logged_out.auth_mode, None);
        assert_eq!(logged_out.plan_type, None);

        Ok(())
    }

    #[test]
    fn account_and_models_paginated_catalog_preserves_order_filters_hidden_and_has_no_fallback(
    ) -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_value(ModelListParams {
                cursor: Some("cursor-2".into()),
                limit: Some(2),
                include_hidden: Some(false),
            })?,
            json!({
                "cursor": "cursor-2",
                "limit": 2,
                "includeHidden": false
            })
        );

        let page_one: ModelListResponse = serde_json::from_value(json!({
            "data": [
                {
                    "id": "catalog-row-main",
                    "model": "gpt-main-wire-id",
                    "displayName": "GPT Main",
                    "description": "Primary model",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "none", "description": "No reasoning" },
                        { "reasoningEffort": "minimal", "description": "Minimal reasoning" },
                        { "reasoningEffort": "low", "description": "Low reasoning" },
                        { "reasoningEffort": "medium", "description": "Medium reasoning" },
                        { "reasoningEffort": "high", "description": "High reasoning" },
                        { "reasoningEffort": "xhigh", "description": "Extra high reasoning" }
                    ],
                    "defaultReasoningEffort": "medium",
                    "inputModalities": ["text", "image"],
                    "isDefault": true
                },
                {
                    "id": "catalog-row-hidden",
                    "model": "gpt-hidden-wire-id",
                    "displayName": "Hidden",
                    "description": "Not picker-visible",
                    "hidden": true,
                    "supportedReasoningEfforts": [],
                    "defaultReasoningEffort": "medium",
                    "inputModalities": ["text"],
                    "isDefault": false
                }
            ],
            "nextCursor": "cursor-2"
        }))?;
        let page_two: ModelListResponse = serde_json::from_value(json!({
            "data": [
                {
                    "id": "catalog-row-secondary",
                    "model": "gpt-secondary-wire-id",
                    "displayName": "GPT Secondary",
                    "description": "Second page model",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Low reasoning" },
                        { "reasoningEffort": "high", "description": "High reasoning" }
                    ],
                    "defaultReasoningEffort": "high",
                    "inputModalities": ["text"],
                    "isDefault": false
                }
            ],
            "nextCursor": null
        }))?;

        assert_eq!(page_one.next_cursor.as_deref(), Some("cursor-2"));
        assert_eq!(page_two.next_cursor, None);
        assert_eq!(
            page_one.data[0]
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.reasoning_effort.as_str())
                .collect::<Vec<_>>(),
            vec!["none", "minimal", "low", "medium", "high", "xhigh"]
        );

        let mut models = page_one.into_visible_runtime_models();
        models.extend(page_two.into_visible_runtime_models());
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].runtime, RuntimeKind::Codex);
        assert_eq!(models[0].id, "gpt-main-wire-id");
        assert_eq!(models[0].display_name, "GPT Main");
        assert_eq!(models[0].description.as_deref(), Some("Primary model"));
        assert_eq!(
            models[0].reasoning_efforts,
            vec!["none", "minimal", "low", "medium", "high", "xhigh"]
        );
        assert_eq!(
            models[0].default_reasoning_effort.as_deref(),
            Some("medium")
        );
        assert_eq!(models[0].input_modalities, vec!["text", "image"]);
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "gpt-secondary-wire-id");

        let empty: ModelListResponse = serde_json::from_value(json!({
            "data": [],
            "nextCursor": null
        }))?;
        assert!(empty.into_visible_runtime_models().is_empty());

        Ok(())
    }

    #[test]
    fn account_and_models_model_defaults_missing_input_modalities_to_text_and_image(
    ) -> Result<(), serde_json::Error> {
        let response: ModelListResponse = serde_json::from_value(json!({
            "data": [{
                "id": "catalog-default-modalities",
                "model": "gpt-default-modalities",
                "displayName": "GPT Default Modalities",
                "description": "Uses the Codex schema default",
                "hidden": false,
                "supportedReasoningEfforts": [],
                "defaultReasoningEffort": "medium",
                "isDefault": false
            }],
            "nextCursor": null
        }))?;

        let models = response.into_visible_runtime_models();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].input_modalities, ["text", "image"]);

        Ok(())
    }

    #[test]
    fn codex_turn_payload_builders_use_exact_minimal_app_server_shapes(
    ) -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_value(ThreadStartParams::new(
                r"C:\work\paper".into(),
                "gpt-5.4".into(),
            ))?,
            json!({
                "cwd": r"C:\work\paper",
                "model": "gpt-5.4",
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "threadSource": "user"
            })
        );
        assert_eq!(
            serde_json::to_value(ThreadResumeParams::new("thread-7".into()))?,
            json!({ "threadId": "thread-7" })
        );
        assert_eq!(
            serde_json::to_value(TurnStartParams::new(
                "thread-7".into(),
                "Inspect the project".into(),
                "gpt-5.4".into(),
                Some("high".into()),
            ))?,
            json!({
                "threadId": "thread-7",
                "input": [{ "type": "text", "text": "Inspect the project" }],
                "model": "gpt-5.4",
                "effort": "high"
            })
        );
        assert_eq!(
            serde_json::to_value(TurnStartParams::new(
                "thread-7".into(),
                "Continue".into(),
                "gpt-5.4".into(),
                None,
            ))?,
            json!({
                "threadId": "thread-7",
                "input": [{ "type": "text", "text": "Continue" }],
                "model": "gpt-5.4"
            })
        );
        assert_eq!(
            serde_json::to_value(TurnInterruptParams::new("thread-7".into(), "turn-3".into(),))?,
            json!({ "threadId": "thread-7", "turnId": "turn-3" })
        );
        assert_eq!(
            serde_json::to_value(ThreadReadParams::new("thread-7".into(), true))?,
            json!({ "threadId": "thread-7", "includeTurns": true })
        );
        assert_eq!(
            serde_json::to_value(ThreadArchiveParams::new("thread-7".into()))?,
            json!({ "threadId": "thread-7" })
        );

        Ok(())
    }

    #[test]
    fn codex_turn_thread_and_turn_responses_preserve_routes_history_and_pagination(
    ) -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_value(ThreadListParams::new(r"C:\work\paper".into(), None,))?,
            json!({
                "archived": false,
                "cwd": r"C:\work\paper",
                "limit": 100
            })
        );
        assert_eq!(
            serde_json::to_value(ThreadListParams::new(
                r"C:\work\paper".into(),
                Some("cursor-2".into()),
            ))?,
            json!({
                "archived": false,
                "cursor": "cursor-2",
                "cwd": r"C:\work\paper",
                "limit": 100
            })
        );

        let thread = json!({
            "id": "thread-7",
            "preview": "Inspect the project",
            "cwd": r"C:\work\paper",
            "updatedAt": 1_721_000_123,
            "status": { "type": "idle" },
            "turns": [{
                "id": "turn-3",
                "status": "completed",
                "items": [
                    { "type": "userMessage", "id": "item-user", "content": [{"type":"text","text":"Hi"}] },
                    { "type": "agentMessage", "id": "item-agent", "text": "Hello" }
                ]
            }]
        });

        let started: ThreadStartResponse =
            serde_json::from_value(json!({ "thread": thread.clone() }))?;
        assert_eq!(started.thread.id, "thread-7");
        assert_eq!(started.thread.status_name(), "idle");

        let resumed: ThreadResumeResponse =
            serde_json::from_value(json!({ "thread": thread.clone() }))?;
        assert_eq!(resumed.thread.id, "thread-7");

        let started_turn: TurnStartResponse = serde_json::from_value(json!({
            "turn": thread["turns"][0].clone()
        }))?;
        assert_eq!(started_turn.turn.id, "turn-3");
        assert_eq!(started_turn.turn.items.len(), 2);

        let list: ThreadListResponse = serde_json::from_value(json!({
            "data": [thread.clone()],
            "nextCursor": "cursor-2",
            "backwardsCursor": null
        }))?;
        assert_eq!(list.data.len(), 1);
        assert_eq!(list.next_cursor.as_deref(), Some("cursor-2"));

        let read: ThreadReadResponse = serde_json::from_value(json!({ "thread": thread }))?;
        assert_eq!(read.thread.turns[0].items.len(), 2);

        let _: TurnInterruptResponse = serde_json::from_value(json!({}))?;
        let _: ThreadArchiveResponse = serde_json::from_value(json!({}))?;

        Ok(())
    }
}

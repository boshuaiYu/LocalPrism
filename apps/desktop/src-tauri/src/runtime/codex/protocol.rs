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

#[cfg(test)]
mod tests {
    use super::InitializeParams;
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
}

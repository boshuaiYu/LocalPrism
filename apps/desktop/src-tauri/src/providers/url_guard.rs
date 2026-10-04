use std::net::Ipv6Addr;

/// Remote third-party origins must use HTTPS. Loopback HTTP stays available
/// for local model servers such as Ollama.
pub fn ensure_secure_provider_base_url(base_url: &str) -> Result<(), String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err("Base URL is required".into());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("Base URL cannot contain spaces or line breaks".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "Invalid provider base URL".to_string())?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if host_is_loopback(&parsed) => Ok(()),
        "http" => Err(
            "Remote provider base URLs must use HTTPS to avoid sending credentials over cleartext HTTP."
                .into(),
        ),
        _ => Err("Provider base URL must start with http:// or https://".into()),
    }
}

/// Loopback HTTP stays allowed for local models, but must not be sent through
/// `HTTP_PROXY` / `ALL_PROXY`. Remote HTTPS can still use the system proxy.
pub fn bypass_system_proxy_for_loopback(
    builder: reqwest::ClientBuilder,
    url: &str,
) -> reqwest::ClientBuilder {
    if url_targets_loopback(url) {
        builder.no_proxy()
    } else {
        builder
    }
}

pub fn url_targets_loopback(url: &str) -> bool {
    url::Url::parse(url.trim())
        .ok()
        .is_some_and(|parsed| host_is_loopback(&parsed))
}

fn host_is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            domain.trim_end_matches('.').eq_ignore_ascii_case("localhost")
        }
        Some(url::Host::Ipv4(addr)) => addr.is_loopback(),
        Some(url::Host::Ipv6(addr)) => ipv6_is_loopback(addr),
        None => false,
    }
}

fn ipv6_is_loopback(addr: Ipv6Addr) -> bool {
    addr.is_loopback()
        || addr
            .to_ipv4_mapped()
            .is_some_and(|mapped| mapped.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::{ensure_secure_provider_base_url, url_targets_loopback};

    #[test]
    fn accepts_https_remote_origins() {
        assert!(ensure_secure_provider_base_url("https://api.deepseek.com/anthropic").is_ok());
        assert!(ensure_secure_provider_base_url("https://api.openai.com/v1").is_ok());
    }

    #[test]
    fn accepts_loopback_http_for_local_models() {
        assert!(ensure_secure_provider_base_url("http://localhost:11434/v1").is_ok());
        assert!(ensure_secure_provider_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(ensure_secure_provider_base_url("http://[::1]:11434/v1").is_ok());
        assert!(ensure_secure_provider_base_url("http://127.1.2.3:9000").is_ok());
        assert!(ensure_secure_provider_base_url("http://[::ffff:127.0.0.1]:11434/v1").is_ok());
        assert!(ensure_secure_provider_base_url("http://evil.localhost/v1").is_err());
        assert!(url_targets_loopback("http://127.0.0.1:11434/v1"));
        assert!(url_targets_loopback("http://[::ffff:127.0.0.1]/v1"));
        assert!(!url_targets_loopback("https://api.openai.com/v1"));
        assert!(!url_targets_loopback("http://evil.localhost/v1"));
    }

    #[test]
    fn rejects_remote_cleartext_http() {
        for url in [
            "http://api.deepseek.com/anthropic",
            "http://evil.example/v1",
            "http://192.168.1.10:11434/v1",
            "http://10.0.0.5/v1",
            "http://[2001:db8::1]/v1",
        ] {
            let error = ensure_secure_provider_base_url(url).expect_err(url);
            assert!(
                error.contains("HTTPS"),
                "expected HTTPS rejection for {url}, got {error}"
            );
        }
    }

    #[test]
    fn rejects_invalid_or_non_http_urls() {
        assert!(ensure_secure_provider_base_url("").is_err());
        assert!(ensure_secure_provider_base_url("ftp://localhost/v1").is_err());
        assert!(ensure_secure_provider_base_url("not a url").is_err());
        assert!(ensure_secure_provider_base_url("https://api.example.com/ path").is_err());
    }
}

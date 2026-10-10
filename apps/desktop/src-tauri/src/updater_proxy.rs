//! Proxy selection for the updater's own reqwest 0.13 client.
//!
//! Discovery already uses the app's reqwest 0.12 client, which has the
//! `system-proxy` feature. tauri-plugin-updater 2.10.1 builds a separate
//! client with default features disabled. Enabling `system-proxy` and `socks`
//! on `updater-reqwest` turns those features on for that client too.
//!
//! This module additionally installs an explicit proxy when one is configured,
//! so compact-tag loopback manifests stay direct and desktop proxies that
//! reqwest does not read (GNOME, KDE, per-scheme Windows settings) still apply
//! to the signed package download. When nothing is configured the builder is
//! left alone, so a direct connection does not gain a proxy.

use std::net::IpAddr;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProxyEnv {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    no_proxy: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SystemProxy {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    bypass: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ResolvedProxy {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    bypass: Vec<String>,
}

impl ProxyEnv {
    fn has_proxy(&self) -> bool {
        self.http.is_some() || self.https.is_some() || self.all.is_some()
    }
}

impl ResolvedProxy {
    fn is_direct(&self) -> bool {
        self.http.is_none() && self.https.is_none() && self.all.is_none()
    }
}

/// Environment variables win over the operating system, matching reqwest:
/// `HTTP_PROXY` is not copied onto HTTPS, and `ALL_PROXY` fills only the
/// slots that a more specific variable left empty. An empty proxy list falls
/// through to the OS settings. A set `NO_PROXY` is kept either way.
fn select_proxy(env: ProxyEnv, system: SystemProxy) -> ResolvedProxy {
    if env.has_proxy() {
        return ResolvedProxy {
            http: env.http,
            https: env.https,
            all: env.all,
            bypass: env.no_proxy,
        };
    }
    let bypass = if env.no_proxy.is_empty() {
        system.bypass
    } else {
        env.no_proxy
    };
    ResolvedProxy {
        http: system.http,
        https: system.https,
        all: system.all,
        bypass,
    }
}

fn proxy_for_target(resolved: &ResolvedProxy, scheme: &str, host: &str) -> Option<String> {
    if is_loopback_host(host) || host_bypassed(host, &resolved.bypass) {
        return None;
    }
    let specific = match scheme {
        "https" => resolved.https.as_deref(),
        "http" => resolved.http.as_deref(),
        _ => None,
    };
    specific.or(resolved.all.as_deref()).map(str::to_string)
}

pub(crate) fn current() -> ResolvedProxy {
    let env = read_env();
    let system = if env.has_proxy() {
        SystemProxy::default()
    } else {
        read_system()
    };
    select_proxy(env, system)
}

pub(crate) fn install_on_updater_client(
    builder: updater_reqwest::ClientBuilder,
    resolved: ResolvedProxy,
) -> updater_reqwest::ClientBuilder {
    if resolved.is_direct() {
        return builder;
    }
    eprintln!("[updater] using proxy {}", describe_proxy(&resolved));
    let proxy = updater_reqwest::Proxy::custom(move |url| {
        let host = url.host_str()?;
        proxy_for_target(&resolved, url.scheme(), host)
    });
    builder.proxy(proxy)
}

/// Same proxy choice as the updater, for the app's reqwest 0.12 client.
/// A direct connection is left alone so reqwest's `system-proxy` feature
/// does not gain a proxy that was not configured.
pub(crate) fn install_on_download_client(
    builder: reqwest::ClientBuilder,
    resolved: ResolvedProxy,
) -> reqwest::ClientBuilder {
    if resolved.is_direct() {
        return builder;
    }
    eprintln!("[download] using proxy {}", describe_proxy(&resolved));
    let proxy = reqwest::Proxy::custom(move |url| {
        let host = url.host_str()?;
        proxy_for_target(&resolved, url.scheme(), host)
    });
    builder.proxy(proxy)
}

fn describe_proxy(resolved: &ResolvedProxy) -> String {
    let mut parts = Vec::new();
    if let Some(http) = &resolved.http {
        parts.push(format!("http={}", redacted_proxy_url(http)));
    }
    if let Some(https) = &resolved.https {
        parts.push(format!("https={}", redacted_proxy_url(https)));
    }
    if let Some(all) = &resolved.all {
        parts.push(format!("all={}", redacted_proxy_url(all)));
    }
    parts.join(" ")
}

fn redacted_proxy_url(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return "<invalid proxy URL>".to_string();
    };
    if !parsed.username().is_empty() {
        let _ = parsed.set_username("***");
        if parsed.password().is_some() {
            let _ = parsed.set_password(Some("***"));
        }
    }
    parsed.to_string()
}

fn read_env() -> ProxyEnv {
    ProxyEnv {
        http: first_env(&["HTTP_PROXY", "http_proxy"])
            .and_then(|value| normalize_proxy_url(&value, "http")),
        https: first_env(&["HTTPS_PROXY", "https_proxy"])
            .and_then(|value| normalize_proxy_url(&value, "http")),
        all: first_env(&["ALL_PROXY", "all_proxy"])
            .and_then(|value| normalize_proxy_url(&value, "http")),
        no_proxy: first_env(&["NO_PROXY", "no_proxy"])
            .map(|value| parse_bypass_list(&value))
            .unwrap_or_default(),
    }
}

fn first_env(names: &[&str]) -> Option<String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            return Some(value);
        }
    }
    None
}

fn read_system() -> SystemProxy {
    #[cfg(target_os = "windows")]
    {
        return read_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return read_macos();
    }
    #[cfg(target_os = "linux")]
    {
        return read_linux();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        SystemProxy::default()
    }
}

fn normalize_proxy_url(raw: &str, default_scheme: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("{default_scheme}://{trimmed}")
    };
    let url = url::Url::parse(&candidate).ok()?;
    if !matches!(
        url.scheme(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return None;
    }
    if url.host_str().is_none() {
        return None;
    }
    Some(url.to_string())
}

fn parse_bypass_list(raw: &str) -> Vec<String> {
    raw.split([',', ';'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry
                .strip_prefix("*.")
                .map(|domain| format!(".{}", domain.trim_start_matches('.')))
                .unwrap_or_else(|| entry.to_string())
        })
        .collect()
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let bare = host.trim_matches(|ch| ch == '[' || ch == ']');
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_loopback())
        }
        Err(_) => false,
    }
}

fn is_simple_hostname(host: &str) -> bool {
    !host.is_empty()
        && !host.contains('.')
        && !host.contains(':')
        && host.parse::<IpAddr>().is_err()
}

fn host_bypassed(host: &str, rules: &[String]) -> bool {
    let bare = host.trim_matches(|ch| ch == '[' || ch == ']');
    for rule in rules {
        let rule = rule.trim();
        if rule.is_empty() {
            continue;
        }
        if rule == "*"
            || ((rule.eq_ignore_ascii_case("<local>") || rule.eq_ignore_ascii_case("<simple>"))
                && (is_loopback_host(host) || is_simple_hostname(bare)))
        {
            return true;
        }
        if rule.contains('/') {
            if let (Ok(ip), Ok(net)) = (bare.parse::<IpAddr>(), rule.parse::<ipnet::IpNet>()) {
                if net.contains(&ip) {
                    return true;
                }
            }
            continue;
        }
        if let Ok(rule_ip) = rule
            .trim_matches(|ch| ch == '[' || ch == ']')
            .parse::<IpAddr>()
        {
            if bare.parse::<IpAddr>().ok().as_ref() == Some(&rule_ip) {
                return true;
            }
            continue;
        }
        if domain_matches(bare, rule) {
            return true;
        }
    }
    false
}

fn domain_matches(domain: &str, rule: &str) -> bool {
    if rule.eq_ignore_ascii_case(domain) {
        return true;
    }
    if let Some(stripped) = rule.strip_prefix('.') {
        if stripped.eq_ignore_ascii_case(domain) {
            return true;
        }
    }
    let domain_len = domain.len();
    let rule_len = rule.len();
    if domain_len > rule_len {
        if let Some(suffix) = domain.get(domain_len - rule_len..) {
            if suffix.eq_ignore_ascii_case(rule) {
                if rule.starts_with('.') {
                    return true;
                }
                if domain.as_bytes().get(domain_len - rule_len - 1) == Some(&b'.') {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn fill_https_from_http(proxy: &mut SystemProxy) {
    if proxy.https.is_none() {
        proxy.https = proxy.http.clone();
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_proxy_server(raw: &str) -> SystemProxy {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return SystemProxy::default();
    }
    if !trimmed.contains('=') {
        let Some(url) = normalize_proxy_url(trimmed, "http") else {
            return SystemProxy::default();
        };
        return SystemProxy {
            http: Some(url.clone()),
            https: Some(url),
            ..SystemProxy::default()
        };
    }

    let mut proxy = SystemProxy::default();
    for entry in trimmed.split(';') {
        let Some((scheme, value)) = entry.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => proxy.http = normalize_proxy_url(value, "http"),
            "https" => proxy.https = normalize_proxy_url(value, "http"),
            "socks" | "socks5" => proxy.all = normalize_proxy_url(value, "socks5"),
            "socks4" => proxy.all = normalize_proxy_url(value, "socks4"),
            _ => {}
        }
    }
    fill_https_from_http(&mut proxy);
    proxy
}

#[cfg(target_os = "windows")]
fn read_windows() -> SystemProxy {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(settings) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return SystemProxy::default();
    };
    if settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 0 {
        return SystemProxy::default();
    }
    let Ok(server) = settings.get_value::<String, _>("ProxyServer") else {
        return SystemProxy::default();
    };
    let mut proxy = parse_windows_proxy_server(&server);
    if let Ok(override_list) = settings.get_value::<String, _>("ProxyOverride") {
        proxy.bypass = parse_bypass_list(&override_list);
    }
    proxy
}

#[cfg(target_os = "macos")]
fn read_macos() -> SystemProxy {
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;
    use system_configuration::sys::schema_definitions::{
        kSCPropNetProxiesExcludeSimpleHostnames, kSCPropNetProxiesHTTPEnable,
        kSCPropNetProxiesHTTPPort, kSCPropNetProxiesHTTPProxy, kSCPropNetProxiesHTTPSEnable,
        kSCPropNetProxiesHTTPSPort, kSCPropNetProxiesHTTPSProxy, kSCPropNetProxiesSOCKSEnable,
        kSCPropNetProxiesSOCKSPort, kSCPropNetProxiesSOCKSProxy,
    };

    let Some(store) = SCDynamicStoreBuilder::new("localprism-updater").build() else {
        return SystemProxy::default();
    };
    let Some(proxies) = store.get_proxies() else {
        return SystemProxy::default();
    };

    let mut system = SystemProxy::default();
    system.http = macos_proxy_endpoint(
        &proxies,
        unsafe { kSCPropNetProxiesHTTPEnable },
        unsafe { kSCPropNetProxiesHTTPProxy },
        unsafe { kSCPropNetProxiesHTTPPort },
        "http",
    );
    system.https = macos_proxy_endpoint(
        &proxies,
        unsafe { kSCPropNetProxiesHTTPSEnable },
        unsafe { kSCPropNetProxiesHTTPSProxy },
        unsafe { kSCPropNetProxiesHTTPSPort },
        "http",
    );
    system.all = macos_proxy_endpoint(
        &proxies,
        unsafe { kSCPropNetProxiesSOCKSEnable },
        unsafe { kSCPropNetProxiesSOCKSProxy },
        unsafe { kSCPropNetProxiesSOCKSPort },
        "socks5",
    );
    system.bypass = macos_exceptions(&proxies);
    if macos_flag(&proxies, unsafe { kSCPropNetProxiesExcludeSimpleHostnames }) {
        system.bypass.push("<simple>".to_string());
    }
    system
}

#[cfg(target_os = "macos")]
fn macos_flag(
    proxies: &system_configuration::core_foundation::dictionary::CFDictionary<
        system_configuration::core_foundation::string::CFString,
        system_configuration::core_foundation::base::CFType,
    >,
    key: system_configuration::core_foundation::string::CFStringRef,
) -> bool {
    macos_number(proxies, key) == Some(1)
}

#[cfg(target_os = "macos")]
fn macos_number(
    proxies: &system_configuration::core_foundation::dictionary::CFDictionary<
        system_configuration::core_foundation::string::CFString,
        system_configuration::core_foundation::base::CFType,
    >,
    key: system_configuration::core_foundation::string::CFStringRef,
) -> Option<i32> {
    use system_configuration::core_foundation::number::CFNumber;
    proxies
        .find(key)
        .and_then(|flag| flag.downcast::<CFNumber>())
        .and_then(|flag| flag.to_i32())
}

#[cfg(target_os = "macos")]
fn macos_proxy_endpoint(
    proxies: &system_configuration::core_foundation::dictionary::CFDictionary<
        system_configuration::core_foundation::string::CFString,
        system_configuration::core_foundation::base::CFType,
    >,
    enabled_key: system_configuration::core_foundation::string::CFStringRef,
    host_key: system_configuration::core_foundation::string::CFStringRef,
    port_key: system_configuration::core_foundation::string::CFStringRef,
    scheme: &str,
) -> Option<String> {
    use system_configuration::core_foundation::string::CFString;
    if !macos_flag(proxies, enabled_key) {
        return None;
    }
    let host = proxies
        .find(host_key)
        .and_then(|host| host.downcast::<CFString>())
        .map(|host| host.to_string())?;
    let raw = match macos_number(proxies, port_key) {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    normalize_proxy_url(&raw, scheme)
}

#[cfg(target_os = "macos")]
fn macos_exceptions(
    proxies: &system_configuration::core_foundation::dictionary::CFDictionary<
        system_configuration::core_foundation::string::CFString,
        system_configuration::core_foundation::base::CFType,
    >,
) -> Vec<String> {
    use system_configuration::core_foundation::array::CFArray;
    use system_configuration::core_foundation::base::{CFType, CFTypeRef, TCFType};
    use system_configuration::core_foundation::string::CFString;
    use system_configuration::sys::schema_definitions::kSCPropNetProxiesExceptionsList;

    let Some(array) = proxies
        .find(unsafe { kSCPropNetProxiesExceptionsList })
        .and_then(|value| value.downcast::<CFArray>())
    else {
        return Vec::new();
    };
    let mut bypass = Vec::new();
    for ptr in array.get_all_values() {
        if ptr.is_null() {
            continue;
        }
        let value = unsafe { CFType::wrap_under_get_rule(ptr as CFTypeRef) };
        let Some(text) = value.downcast::<CFString>() else {
            continue;
        };
        let text = text.to_string();
        if !text.trim().is_empty() {
            bypass.extend(parse_bypass_list(text.trim()));
        }
    }
    bypass
}

#[cfg(target_os = "linux")]
fn read_linux() -> SystemProxy {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let desktop = desktop.to_ascii_lowercase();
    let prefer_kde = desktop
        .split([':', ';'])
        .any(|part| part.contains("kde") || part.contains("lxqt"));
    if prefer_kde {
        return desktop_proxy_or_direct(read_kioslaverc_file());
    }
    match read_gnome_settings() {
        DesktopProxy::Manual(proxy) => proxy,
        DesktopProxy::Unavailable => desktop_proxy_or_direct(read_kioslaverc_file()),
        DesktopProxy::NoManual => SystemProxy::default(),
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug)]
enum DesktopProxy {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Unavailable,
    NoManual,
    Manual(SystemProxy),
}

#[cfg(any(target_os = "linux", test))]
fn parse_kioslaverc(text: &str) -> DesktopProxy {
    let mut in_section = false;
    let mut proxy_type = None;
    let mut http = None;
    let mut https = None;
    let mut socks = None;
    let mut no_proxy = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line.eq_ignore_ascii_case("[Proxy Settings]");
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "ProxyType" => proxy_type = value.trim().parse::<i32>().ok(),
            "httpProxy" => http = Some(value.trim().to_string()),
            "httpsProxy" => https = Some(value.trim().to_string()),
            "socksProxy" => socks = Some(value.trim().to_string()),
            "NoProxyFor" => no_proxy = Some(value.trim().to_string()),
            _ => {}
        }
    }
    if proxy_type != Some(1) {
        return DesktopProxy::NoManual;
    }
    let mut proxy = SystemProxy {
        http: http
            .as_deref()
            .and_then(|value| parse_kde_proxy(value, "http")),
        https: https
            .as_deref()
            .and_then(|value| parse_kde_proxy(value, "http")),
        all: socks
            .as_deref()
            .and_then(|value| parse_kde_proxy(value, "socks5")),
        bypass: no_proxy
            .as_deref()
            .map(parse_bypass_list)
            .unwrap_or_default(),
    };
    fill_https_from_http(&mut proxy);
    if proxy.http.is_none() && proxy.https.is_none() && proxy.all.is_none() {
        DesktopProxy::NoManual
    } else {
        DesktopProxy::Manual(proxy)
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_kde_proxy(raw: &str, default_scheme: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains("://") {
        return normalize_proxy_url(raw, default_scheme);
    }
    if let Some((host, port)) = raw.split_once(|ch: char| ch.is_whitespace()) {
        let host = host.trim();
        let port = port.trim();
        if !host.is_empty() && !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            return normalize_proxy_url(&format!("{host}:{port}"), default_scheme);
        }
    }
    normalize_proxy_url(raw, default_scheme)
}

#[cfg(any(target_os = "linux", test))]
fn parse_gnome_recursive(text: &str) -> DesktopProxy {
    let mut mode = String::new();
    let mut http_host = None;
    let mut http_port = None;
    let mut https_host = None;
    let mut https_port = None;
    let mut socks_host = None;
    let mut socks_port = None;
    let mut bypass = Vec::new();
    for line in text.lines() {
        let Some((schema, key, value)) = parse_gnome_line(line) else {
            continue;
        };
        match (schema, key) {
            ("", "mode") => mode = parse_gsettings_string(value).unwrap_or_default(),
            ("http", "host") => http_host = parse_gsettings_string(value),
            ("http", "port") => http_port = parse_gsettings_port(value),
            ("https", "host") => https_host = parse_gsettings_string(value),
            ("https", "port") => https_port = parse_gsettings_port(value),
            ("socks", "host") => socks_host = parse_gsettings_string(value),
            ("socks", "port") => socks_port = parse_gsettings_port(value),
            ("", "ignore-hosts") => bypass = parse_gsettings_array(value),
            _ => {}
        }
    }
    if mode != "manual" {
        return DesktopProxy::NoManual;
    }
    let mut proxy = SystemProxy {
        http: join_host_port(http_host, http_port, "http"),
        https: join_host_port(https_host, https_port, "http"),
        all: join_host_port(socks_host, socks_port, "socks5"),
        bypass,
    };
    fill_https_from_http(&mut proxy);
    if proxy.http.is_none() && proxy.https.is_none() && proxy.all.is_none() {
        DesktopProxy::NoManual
    } else {
        DesktopProxy::Manual(proxy)
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_gnome_line(line: &str) -> Option<(&str, &str, &str)> {
    const PREFIX: &str = "org.gnome.system.proxy";
    let rest = line.trim().strip_prefix(PREFIX)?.trim_start();
    let (schema, rest) = if let Some(rest) = rest.strip_prefix('.') {
        let (schema, rest) = rest.split_once(' ')?;
        (schema, rest.trim_start())
    } else {
        ("", rest)
    };
    let (key, value) = rest.split_once(' ')?;
    Some((schema, key, value.trim()))
}

#[cfg(any(target_os = "linux", test))]
fn parse_gsettings_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed == "''"
        || trimmed == "\"\""
        || trimmed == "nothing"
        || trimmed == "@ms nothing"
    {
        return None;
    }
    let inner = trimmed
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .or_else(|| {
            trimmed
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
        })
        .unwrap_or(trimmed);
    let inner = inner.trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_gsettings_port(raw: &str) -> Option<u16> {
    let token = raw.split_whitespace().next_back()?.trim();
    let port = token.parse::<u16>().ok()?;
    if port == 0 {
        None
    } else {
        Some(port)
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_gsettings_array(raw: &str) -> Vec<String> {
    let trimmed = raw.trim().strip_prefix("@as").unwrap_or(raw.trim()).trim();
    let Some(inner) = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    else {
        return parse_gsettings_string(trimmed).into_iter().collect();
    };
    inner
        .split(',')
        .filter_map(parse_gsettings_string)
        .flat_map(|entry| parse_bypass_list(&entry))
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn join_host_port(host: Option<String>, port: Option<u16>, scheme: &str) -> Option<String> {
    let host = host?;
    match port {
        Some(port) => normalize_proxy_url(&format!("{host}:{port}"), scheme),
        None => normalize_proxy_url(&host, scheme),
    }
}

#[cfg(target_os = "linux")]
fn desktop_proxy_or_direct(proxy: DesktopProxy) -> SystemProxy {
    match proxy {
        DesktopProxy::Manual(proxy) => proxy,
        DesktopProxy::NoManual | DesktopProxy::Unavailable => SystemProxy::default(),
    }
}

#[cfg(target_os = "linux")]
fn read_gnome_settings() -> DesktopProxy {
    match command_output("gsettings", &["list-recursively", "org.gnome.system.proxy"]) {
        CommandRead::Missing => DesktopProxy::Unavailable,
        CommandRead::Failed => DesktopProxy::NoManual,
        CommandRead::Value(text) => parse_gnome_recursive(&text),
    }
}

#[cfg(target_os = "linux")]
fn read_kioslaverc_file() -> DesktopProxy {
    let Some(dir) = dirs::config_dir() else {
        return DesktopProxy::NoManual;
    };
    let Some(text) = read_limited(&dir.join("kioslaverc"), 64 * 1024) else {
        return DesktopProxy::NoManual;
    };
    parse_kioslaverc(&text)
}

#[cfg(target_os = "linux")]
fn read_limited(path: &std::path::Path, max: u64) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut limited = file.take(max);
    let mut buf = String::new();
    limited.read_to_string(&mut buf).ok()?;
    Some(buf)
}

#[cfg(target_os = "linux")]
enum CommandRead {
    Missing,
    Failed,
    Value(String),
}

#[cfg(target_os = "linux")]
fn command_output(program: &str, args: &[&str]) -> CommandRead {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return CommandRead::Missing,
        Err(_) => return CommandRead::Failed,
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CommandRead::Failed;
    };
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let mut limited = stdout.take(64 * 1024);
        let _ = limited.read_to_string(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                if status.success() {
                    return CommandRead::Value(text);
                }
                return CommandRead::Failed;
            }
            Ok(None) if started.elapsed() > Duration::from_millis(800) => {
                let _ = child.kill();
                let _ = child.wait();
                return CommandRead::Failed;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return CommandRead::Failed;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy_for(resolved: &ResolvedProxy, target: &str) -> Option<String> {
        let url = url::Url::parse(target).expect("target url");
        let host = url.host_str().expect("host");
        proxy_for_target(resolved, url.scheme(), host)
    }

    fn https_env(url: &str) -> ProxyEnv {
        ProxyEnv {
            https: Some(url.to_string()),
            ..ProxyEnv::default()
        }
    }

    #[test]
    fn http_proxy_does_not_proxy_https_targets() {
        let resolved = select_proxy(
            ProxyEnv {
                http: Some("http://env:8080/".to_string()),
                ..ProxyEnv::default()
            },
            SystemProxy {
                https: Some("http://system:9/".to_string()),
                ..SystemProxy::default()
            },
        );
        assert_eq!(proxy_for(&resolved, "https://github.com/pkg"), None);
        assert_eq!(
            proxy_for(&resolved, "http://github.com/pkg").as_deref(),
            Some("http://env:8080/")
        );
    }

    #[test]
    fn https_proxy_and_all_proxy_keep_reqwest_precedence() {
        let resolved = select_proxy(
            ProxyEnv {
                https: Some("http://secure:1/".to_string()),
                all: Some("socks5://all:1080/".to_string()),
                ..ProxyEnv::default()
            },
            SystemProxy::default(),
        );
        assert_eq!(
            proxy_for(&resolved, "https://github.com/pkg").as_deref(),
            Some("http://secure:1/")
        );
        assert_eq!(
            proxy_for(&resolved, "http://github.com/pkg").as_deref(),
            Some("socks5://all:1080/")
        );
    }

    #[test]
    fn all_proxy_covers_https_when_https_proxy_is_unset() {
        let resolved = select_proxy(
            ProxyEnv {
                all: Some("socks5://all:1080/".to_string()),
                ..ProxyEnv::default()
            },
            SystemProxy::default(),
        );
        assert_eq!(
            proxy_for(&resolved, "https://github.com/pkg").as_deref(),
            Some("socks5://all:1080/")
        );
    }

    #[test]
    fn env_no_proxy_applies_to_a_system_proxy() {
        let resolved = select_proxy(
            ProxyEnv {
                no_proxy: vec!["example.com".to_string()],
                ..ProxyEnv::default()
            },
            SystemProxy {
                https: Some("http://sys:8080/".to_string()),
                bypass: vec!["ignored.test".to_string()],
                ..SystemProxy::default()
            },
        );
        assert_eq!(proxy_for(&resolved, "https://example.com/pkg"), None);
        assert_eq!(proxy_for(&resolved, "https://www.example.com/pkg"), None);
        assert_eq!(
            proxy_for(&resolved, "https://github.com/pkg").as_deref(),
            Some("http://sys:8080/")
        );
        assert_eq!(
            proxy_for(&resolved, "https://ignored.test/pkg").as_deref(),
            Some("http://sys:8080/")
        );
    }

    #[test]
    fn loopback_never_uses_a_configured_proxy() {
        let resolved = select_proxy(https_env("http://proxy:8080/"), SystemProxy::default());
        assert_eq!(proxy_for(&resolved, "https://127.0.0.1/latest.json"), None);
        assert_eq!(proxy_for(&resolved, "https://127.1.2.3/latest.json"), None);
        assert_eq!(proxy_for(&resolved, "http://localhost/latest.json"), None);
        assert_eq!(proxy_for(&resolved, "https://[::1]/latest.json"), None);
        assert_eq!(
            proxy_for(&resolved, "https://[::ffff:127.0.0.1]/latest.json"),
            None
        );
        assert_eq!(
            proxy_for(&resolved, "https://github.com/pkg").as_deref(),
            Some("http://proxy:8080/")
        );
    }

    #[test]
    fn bypass_matches_local_simple_names_cidr_and_domains() {
        let resolved = ResolvedProxy {
            https: Some("http://proxy:8080/".to_string()),
            bypass: parse_bypass_list("<local>;*.corp.example;10.0.0.0/8,files.example"),
            ..ResolvedProxy::default()
        };
        assert_eq!(proxy_for(&resolved, "https://printer/pkg"), None);
        assert_eq!(proxy_for(&resolved, "https://10.1.2.3/pkg"), None);
        assert_eq!(
            proxy_for(&resolved, "https://builds.corp.example/pkg"),
            None
        );
        assert_eq!(proxy_for(&resolved, "https://corp.example/pkg"), None);
        assert_eq!(proxy_for(&resolved, "https://files.example/pkg"), None);
        assert_eq!(
            proxy_for(&resolved, "https://notfiles.example/pkg").as_deref(),
            Some("http://proxy:8080/")
        );
        assert_eq!(
            proxy_for(&resolved, "https://11.0.0.1/pkg").as_deref(),
            Some("http://proxy:8080/")
        );
    }

    #[test]
    fn star_bypass_matches_every_host() {
        let resolved = ResolvedProxy {
            https: Some("http://proxy:8080/".to_string()),
            bypass: vec!["*".to_string()],
            ..ResolvedProxy::default()
        };
        assert_eq!(proxy_for(&resolved, "https://github.com/pkg"), None);
    }

    #[test]
    fn windows_proxy_server_parses_per_scheme_and_falls_back() {
        let single = parse_windows_proxy_server("10.1.1.1:8888");
        assert_eq!(single.http.as_deref(), Some("http://10.1.1.1:8888/"));
        assert_eq!(single.https.as_deref(), Some("http://10.1.1.1:8888/"));

        let split = parse_windows_proxy_server("http=10.0.0.1:8080;https=10.0.0.2:8443");
        assert_eq!(split.http.as_deref(), Some("http://10.0.0.1:8080/"));
        assert_eq!(split.https.as_deref(), Some("http://10.0.0.2:8443/"));

        let http_only = parse_windows_proxy_server("http=10.0.0.1:8080");
        assert_eq!(http_only.https.as_deref(), Some("http://10.0.0.1:8080/"));

        let socks = parse_windows_proxy_server("socks=10.0.0.1:1080");
        assert_eq!(socks.https, None);
        assert_eq!(socks.all.as_deref(), Some("socks5://10.0.0.1:1080"));
        let resolved = select_proxy(ProxyEnv::default(), socks);
        assert_eq!(
            proxy_for(&resolved, "https://github.com/pkg").as_deref(),
            Some("socks5://10.0.0.1:1080")
        );
    }

    #[test]
    fn windows_override_keeps_local_and_domain_suffixes() {
        assert_eq!(
            parse_bypass_list("<local>;*.corp.example;10.0.0.0/8"),
            vec![
                "<local>".to_string(),
                ".corp.example".to_string(),
                "10.0.0.0/8".to_string()
            ]
        );
    }

    #[test]
    fn gnome_manual_proxy_fills_https_and_keeps_ignore_hosts() {
        let text = "\
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '*.internal']
org.gnome.system.proxy.http host '10.1.1.1'
org.gnome.system.proxy.http port 8080
org.gnome.system.proxy.https host ''
org.gnome.system.proxy.https port 0
org.gnome.system.proxy.socks host '10.9.9.9'
org.gnome.system.proxy.socks port uint32 1080
";
        let DesktopProxy::Manual(proxy) = parse_gnome_recursive(text) else {
            panic!("expected a manual gnome proxy");
        };
        assert_eq!(proxy.http.as_deref(), Some("http://10.1.1.1:8080/"));
        assert_eq!(proxy.https.as_deref(), Some("http://10.1.1.1:8080/"));
        assert_eq!(proxy.all.as_deref(), Some("socks5://10.9.9.9:1080"));
        assert!(proxy.bypass.iter().any(|rule| rule == ".internal"));
        assert!(matches!(
            parse_gnome_recursive("org.gnome.system.proxy mode 'none'\n"),
            DesktopProxy::NoManual
        ));
        assert!(matches!(
            parse_gnome_recursive("org.gnome.system.proxy mode 'auto'\n"),
            DesktopProxy::NoManual
        ));
    }

    #[test]
    fn kioslaverc_manual_proxy_is_used_and_other_modes_are_not() {
        let manual = "\
[Proxy Settings]
ProxyType=1
httpProxy=10.2.2.2 9090
httpsProxy=https://user:secret@10.3.3.3:9443
NoProxyFor=<local>,example.com
";
        let DesktopProxy::Manual(proxy) = parse_kioslaverc(manual) else {
            panic!("expected a manual kde proxy");
        };
        assert_eq!(proxy.http.as_deref(), Some("http://10.2.2.2:9090/"));
        assert_eq!(
            proxy.https.as_deref(),
            Some("https://user:secret@10.3.3.3:9443/")
        );
        assert_eq!(
            proxy.bypass,
            vec!["<local>".to_string(), "example.com".to_string()]
        );
        assert!(matches!(
            parse_kioslaverc("[Proxy Settings]\nProxyType=0\nhttpProxy=10.2.2.2 9090\n"),
            DesktopProxy::NoManual
        ));
    }

    #[test]
    fn redacted_proxy_url_hides_userinfo() {
        assert_eq!(
            redacted_proxy_url("https://user:secret@10.3.3.3:9443/"),
            "https://***:***@10.3.3.3:9443/"
        );
    }

    fn install_updater_tls_provider() {
        // Same provider tauri-plugin-updater installs before check/download.
        // `rustls-no-provider` refuses to build a client until one is present.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn direct_resolution_leaves_the_client_builder_usable() {
        install_updater_tls_provider();
        let client = install_on_updater_client(
            updater_reqwest::ClientBuilder::new(),
            ResolvedProxy::default(),
        )
        .build();
        assert!(client.is_ok());
    }

    #[test]
    fn updater_reqwest_enables_system_proxy_and_socks() {
        let cargo = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"));
        let start = cargo
            .find("updater-reqwest")
            .expect("updater-reqwest dependency");
        let window = &cargo[start..start.saturating_add(500)];
        assert!(window.contains("0.13.4"), "{window}");
        assert!(window.contains("system-proxy"), "{window}");
        assert!(window.contains("socks"), "{window}");
    }

    #[test]
    fn manifest_download_keeps_signature_verification_and_loopback_proxy_bypass() {
        let source = include_str!("lib.rs");
        let start = source
            .find("async fn download_manifest_update")
            .expect("download_manifest_update");
        let end = source[start..]
            .find("struct GatedBetaManifest")
            .expect("following type");
        let body = &source[start..start + end];
        assert!(body.contains("updater_proxy::current()"));
        assert!(body.contains("updater_proxy::install_on_updater_client"));
        assert!(body.contains(".download("));
        assert!(body.contains("verify_artifact_bytes"));
        assert!(!body.contains(".no_proxy("));
        assert!(
            !body.contains(".proxy("),
            "UpdaterBuilder::proxy would send the loopback manifest through the proxy"
        );
        assert!(source.contains("plan_appimage_install"));
        assert!(source.contains("replace_appimage_file"));
    }

    #[tokio::test]
    async fn configured_proxy_is_bypassed_for_loopback_and_used_for_other_hosts() {
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        async fn read_until_headers(stream: &mut tokio::net::TcpStream) -> String {
            let mut buf = Vec::new();
            let mut tmp = [0u8; 512];
            while !buf.windows(4).any(|window| window == b"\r\n\r\n") && buf.len() < 8192 {
                let read = stream.read(&mut tmp).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..read]);
            }
            String::from_utf8_lossy(&buf).into_owned()
        }

        let origin = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("origin");
        let origin_addr = origin.local_addr().expect("origin addr");
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("proxy");
        let proxy_addr = proxy.local_addr().expect("proxy addr");
        install_updater_tls_provider();
        let hits = Arc::new(Mutex::new(Vec::<String>::new()));

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = origin.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let _ = read_until_headers(&mut stream).await;
                    let body =
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
                    let _ = stream.write_all(body).await;
                });
            }
        });
        let hits_proxy = Arc::clone(&hits);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = proxy.accept().await else {
                    break;
                };
                let hits_proxy = Arc::clone(&hits_proxy);
                tokio::spawn(async move {
                    let head = read_until_headers(&mut stream).await;
                    if let Ok(mut guard) = hits_proxy.lock() {
                        guard.push(head);
                    }
                    let body = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(body).await;
                });
            }
        });

        let resolved = ResolvedProxy {
            http: Some(format!("http://{proxy_addr}/")),
            https: Some(format!("http://{proxy_addr}/")),
            ..ResolvedProxy::default()
        };
        let client = install_on_updater_client(
            updater_reqwest::ClientBuilder::new().timeout(std::time::Duration::from_secs(3)),
            resolved,
        )
        .build()
        .expect("client");

        let direct = client
            .get(format!("http://{origin_addr}/manifest"))
            .send()
            .await
            .expect("loopback get");
        assert_eq!(direct.status(), updater_reqwest::StatusCode::OK);
        assert!(
            hits.lock().expect("hits").is_empty(),
            "loopback must not reach the proxy"
        );

        let proxied = client
            .get("http://example.com/pkg")
            .send()
            .await
            .expect("proxied get");
        assert_eq!(proxied.status(), updater_reqwest::StatusCode::BAD_GATEWAY);
        let seen = hits.lock().expect("hits").clone();
        assert!(
            seen.iter().any(|line| line.contains("example.com")),
            "{seen:?}"
        );
    }
}

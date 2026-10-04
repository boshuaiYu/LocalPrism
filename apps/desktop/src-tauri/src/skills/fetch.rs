use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;

/// Official scientific-agent-skills archive is ~234 MiB compressed / ~277 MiB
/// uncompressed today. These caps leave growth room without allowing a hostile
/// body to fill memory or disk.
pub(crate) const MAX_SKILL_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_SKILL_MARKDOWN_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_SKILL_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_SKILL_ARCHIVE_ENTRIES: usize = 25_000;
pub(crate) const MAX_SKILL_ARCHIVE_DEPTH: usize = 20;
pub(crate) const MAX_SKILL_COMPRESSION_RATIO: u64 = 200;
pub(crate) const SKILL_RATIO_FLOOR_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_REDIRECTS: usize = 5;

#[derive(Clone, Copy, Debug)]
pub(crate) struct ExtractLimits {
    pub max_bytes: u64,
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_ratio: u64,
    pub ratio_floor: u64,
}

impl Default for ExtractLimits {
    fn default() -> Self {
        Self {
            max_bytes: MAX_SKILL_EXTRACTED_BYTES,
            max_entries: MAX_SKILL_ARCHIVE_ENTRIES,
            max_depth: MAX_SKILL_ARCHIVE_DEPTH,
            max_ratio: MAX_SKILL_COMPRESSION_RATIO,
            ratio_floor: SKILL_RATIO_FLOOR_BYTES,
        }
    }
}

pub(crate) struct BudgetReader<R> {
    inner: R,
    read_bytes: u64,
    limits: ExtractLimits,
    archive_len: u64,
}

impl<R> BudgetReader<R> {
    pub(crate) fn new(inner: R, archive_len: u64, limits: ExtractLimits) -> Self {
        Self {
            inner,
            read_bytes: 0,
            limits,
            archive_len,
        }
    }
}

impl<R: Read> Read for BudgetReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n == 0 {
            return Ok(0);
        }
        self.read_bytes = self.read_bytes.saturating_add(n as u64);
        if self.read_bytes > self.limits.max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "Archive extraction exceeded the {} byte limit",
                    self.limits.max_bytes
                ),
            ));
        }
        if self.read_bytes > self.limits.ratio_floor {
            if let Some(max_uncompressed) = self.archive_len.checked_mul(self.limits.max_ratio) {
                if self.read_bytes > max_uncompressed {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "Archive extraction exceeded the {}:1 compression ratio limit",
                            self.limits.max_ratio
                        ),
                    ));
                }
            }
        }
        Ok(n)
    }
}

pub(crate) fn is_extract_budget_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::InvalidData
        && error
            .to_string()
            .contains("Archive extraction exceeded the")
}

pub(crate) fn append_download_chunk(
    bytes: &mut Vec<u8>,
    chunk: &[u8],
    limit: u64,
) -> Result<(), String> {
    let new_len = (bytes.len() as u64).saturating_add(chunk.len() as u64);
    if new_len > limit {
        return Err(format!("Skill download exceeded the {limit} byte limit"));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

pub(crate) fn reject_download_length(
    content_length: Option<u64>,
    limit: u64,
) -> Result<(), String> {
    if let Some(total) = content_length {
        if total > limit {
            return Err(format!("Skill download exceeded the {limit} byte limit"));
        }
    }
    Ok(())
}

pub(crate) fn skill_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_SKILL_REDIRECTS {
            return attempt.error("too many redirects");
        }
        match validate_skill_fetch_url(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(error) => attempt.error(error),
        }
    })
}

pub(crate) struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            if is_blocked_skill_hostname(&host) {
                return Err(blocked_destination_error());
            }
            let looked_up = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
            let addrs: Vec<SocketAddr> = looked_up.collect();
            if addrs.is_empty() {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("Failed to resolve skill host {host}"),
                )));
            }
            if addrs.iter().any(|addr| is_blocked_skill_ip(addr.ip())) {
                return Err(blocked_destination_error());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn blocked_destination_error() -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(io::Error::new(
        io::ErrorKind::PermissionDenied,
        blocked_destination_message(),
    ))
}

fn blocked_destination_message() -> &'static str {
    "Refusing to fetch skill from a private, loopback, or metadata address"
}

pub(crate) fn public_only_resolver() -> Arc<PublicOnlyResolver> {
    Arc::new(PublicOnlyResolver)
}

pub(crate) fn validate_skill_fetch_url(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Skill URL must use http or https".into());
    }
    let Some(host) = url.host() else {
        return Err("Skill URL is missing a host".into());
    };
    match host {
        url::Host::Ipv4(ip) => reject_blocked_skill_ip(IpAddr::V4(ip)),
        url::Host::Ipv6(ip) => reject_blocked_skill_ip(IpAddr::V6(ip)),
        url::Host::Domain(domain) => {
            if is_blocked_skill_hostname(domain) {
                return Err(blocked_destination_message().into());
            }
            if let Ok(ip) = domain.parse::<IpAddr>() {
                return reject_blocked_skill_ip(ip);
            }
            let port = url.port_or_known_default().unwrap_or(80);
            validate_resolved_skill_host(domain, port)
        }
    }
}

fn reject_blocked_skill_ip(ip: IpAddr) -> Result<(), String> {
    if is_blocked_skill_ip(ip) {
        Err(blocked_destination_message().into())
    } else {
        Ok(())
    }
}

fn validate_resolved_skill_host(host: &str, port: u16) -> Result<(), String> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Failed to resolve skill host {host}: {error}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(format!("Failed to resolve skill host {host}"));
    }
    if addrs.iter().any(|addr| is_blocked_skill_ip(addr.ip())) {
        return Err(blocked_destination_message().into());
    }
    Ok(())
}

pub(crate) fn is_blocked_skill_hostname(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return true;
    }
    matches!(
        host.as_str(),
        "localhost"
            | "localhost.localdomain"
            | "metadata"
            | "metadata.google.internal"
            | "metadata.goog"
            | "metadata.internal"
            | "internal"
            | "local"
    ) || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".localdomain")
}

pub(crate) fn is_blocked_skill_ip(ip: IpAddr) -> bool {
    match canonicalize_skill_ip(ip) {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn canonicalize_skill_ip(ip: IpAddr) -> IpAddr {
    let IpAddr::V6(v6) = ip else {
        return ip;
    };
    if let Some(v4) = v6.to_ipv4_mapped() {
        return IpAddr::V4(v4);
    }
    if let Some(v4) = v6.to_ipv4() {
        if !v6.is_loopback() && !v6.is_unspecified() {
            return IpAddr::V4(v4);
        }
    }
    let segments = v6.segments();
    if segments[0] == 0x64
        && segments[1] == 0xff9b
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0
    {
        return IpAddr::V4(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        ));
    }
    ip
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0xdb8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_url(raw: &str) -> reqwest::Url {
        raw.parse().unwrap_or_else(|error| panic!("{raw}: {error}"))
    }

    #[test]
    fn skill_fetch_url_blocks_loopback_private_and_metadata() {
        for url in [
            "http://127.0.0.1/skill.md",
            "https://127.1.2.3/x",
            "http://[::1]/x",
            "http://[::ffff:127.0.0.1]/x",
            "http://[::ffff:10.1.2.3]/x",
            "http://10.0.0.5/x",
            "http://192.168.1.10/x",
            "http://172.16.4.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://169.254.1.1/x",
            "http://[fe80::1]/x",
            "http://[fd00:ec2::254]/x",
            "http://[fd12:3456:789a::1]/x",
            "http://[64:ff9b::7f00:1]/x",
            "http://100.64.0.1/x",
            "http://100.100.100.200/x",
            "http://0.0.0.0/x",
            "http://255.255.255.255/x",
            "http://localhost/x",
            "http://localhost.localdomain/x",
            "http://metadata.google.internal/x",
            "http://metadata.goog/x",
            "https://metadata/x",
            "http://foo.localhost/x",
            "http://svc.internal/x",
            "http://printer.local/x",
            "file:///etc/passwd",
            "gopher://example.com/x",
        ] {
            let error = validate_skill_fetch_url(&parse_url(url)).expect_err(url);
            assert!(!error.is_empty(), "{url}");
        }
    }

    #[test]
    fn skill_fetch_url_allows_public_ip_literals() {
        validate_skill_fetch_url(&parse_url("https://1.1.1.1/skill.md")).unwrap();
        validate_skill_fetch_url(&parse_url("https://8.8.8.8/x")).unwrap();
        validate_skill_fetch_url(&parse_url("http://[2001:4860:4860::8888]/x")).unwrap();
        validate_skill_fetch_url(&parse_url("https://172.15.255.1/x")).unwrap();
    }

    #[test]
    fn skill_fetch_url_allows_github_hosts_when_resolvable() {
        for url in [
            "https://github.com/K-Dense-AI/scientific-agent-skills",
            "https://codeload.github.com/K-Dense-AI/scientific-agent-skills/tar.gz/main",
            "https://raw.githubusercontent.com/K-Dense-AI/scientific-agent-skills/main/skills/scanpy/SKILL.md",
        ] {
            match validate_skill_fetch_url(&parse_url(url)) {
                Ok(()) => {}
                Err(error) if error.contains("Failed to resolve") => return,
                Err(error) => panic!("blocked public GitHub URL {url}: {error}"),
            }
        }
    }

    #[test]
    fn localhost_hostname_is_blocked_without_treating_public_lookalikes() {
        assert!(is_blocked_skill_hostname("localhost"));
        assert!(is_blocked_skill_hostname("LOCALHOST."));
        assert!(is_blocked_skill_hostname("metadata.google.internal"));
        assert!(!is_blocked_skill_hostname("localhost.com"));
        assert!(!is_blocked_skill_hostname("github.com"));
        assert!(!is_blocked_skill_hostname("raw.githubusercontent.com"));
    }

    #[test]
    fn mapped_and_nat64_loopback_ips_are_blocked() {
        assert!(is_blocked_skill_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_blocked_skill_ip(
            "::ffff:169.254.169.254".parse().unwrap()
        ));
        assert!(is_blocked_skill_ip("64:ff9b::7f00:1".parse().unwrap()));
        assert!(!is_blocked_skill_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_blocked_skill_ip(
            "2001:4860:4860::8888".parse().unwrap()
        ));
    }

    #[test]
    fn append_download_chunk_enforces_byte_budget() {
        let mut bytes = Vec::new();
        append_download_chunk(&mut bytes, b"hello", 8).unwrap();
        append_download_chunk(&mut bytes, b"!!!", 8).unwrap();
        let error = append_download_chunk(&mut bytes, b"x", 8).unwrap_err();
        assert!(error.contains("8 byte limit"));
        assert_eq!(bytes, b"hello!!!");
        assert!(reject_download_length(Some(9), 8).is_err());
        assert!(reject_download_length(Some(8), 8).is_ok());
        assert!(reject_download_length(None, 8).is_ok());
    }

    #[test]
    fn budget_reader_enforces_bytes_and_ratio() {
        let limits = ExtractLimits {
            max_bytes: 32,
            max_ratio: 2,
            ratio_floor: 4,
            ..ExtractLimits::default()
        };
        let mut limited = BudgetReader::new(&b"abcdefghijklmnopqrstuvwxyz"[..], 5, limits);
        let mut buf = [0u8; 8];
        assert_eq!(limited.read(&mut buf).unwrap(), 8);
        let error = limited.read(&mut buf).unwrap_err();
        assert!(is_extract_budget_error(&error));
        assert!(error.to_string().contains("ratio"));

        let mut size_limited = BudgetReader::new(
            &b"abcdefghijklmnopqrstuvwxyz"[..],
            100,
            ExtractLimits {
                max_bytes: 10,
                ..ExtractLimits::default()
            },
        );
        let error = size_limited.read(&mut [0u8; 16]).unwrap_err();
        assert!(error.to_string().contains("byte limit"));
    }
}

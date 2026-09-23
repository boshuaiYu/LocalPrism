use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow};

pub mod domain;
pub mod import;
pub mod manifest;
pub mod paperspine;
pub mod paths;

const TARBALL_URLS: &[&str] = &[
    "https://github.com/K-Dense-AI/scientific-agent-skills/archive/refs/heads/main.tar.gz",
    "https://codeload.github.com/K-Dense-AI/scientific-agent-skills/tar.gz/refs/heads/main",
    "https://github.com/K-Dense-AI/claude-scientific-skills/archive/refs/heads/main.tar.gz",
];
const SKILLS_DOWNLOAD_ATTEMPTS: usize = 3;
const SKILLS_DOWNLOAD_TIMEOUT_SECS: u64 = 240;
const SKILLS_CONNECT_TIMEOUT_SECS: u64 = 20;
const SKILLS_INSTALL_TIMEOUT_SECS: u64 = 420;
const SKILL_CONTENT_TIMEOUT_SECS: u64 = 45;
const RAW_SKILL_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/K-Dense-AI/scientific-agent-skills/main/skills",
    "https://raw.githubusercontent.com/K-Dense-AI/claude-scientific-skills/main/scientific-skills",
];
const SKILLS_SUBFOLDERS: &[&str] = &["skills", "scientific-skills"];

// ─── Data Types ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub description: String,
    pub folder: String,
}

#[derive(Debug, Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub skills_installed: usize,
    pub target_dir: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct SkillsStatus {
    pub installed: bool,
    pub skill_count: usize,
    pub location: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillCategory {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub skill_count: usize,
    pub skills: Vec<SkillEntry>,
}

// ─── Skill Categories Data ───

/// Returns the known scientific skill categories with metadata.
fn skill_categories() -> Vec<SkillCategory> {
    fn s(name: &str, folder: &str) -> SkillEntry {
        SkillEntry {
            name: name.into(),
            folder: folder.into(),
        }
    }

    let mut cats = vec![
        SkillCategory {
            id: "bioinformatics".into(),
            name: "Bioinformatics & Genomics".into(),
            icon: "dna".into(),
            skill_count: 0,
            skills: vec![
                s("Scanpy (scRNA-seq)", "scanpy"),
                s("BioPython", "biopython"),
                s("PyDESeq2", "pydeseq2"),
                s("PySAM", "pysam"),
                s("gget", "gget"),
                s("scikit-bio", "scikit-bio"),
                s("DeepTools", "deeptools"),
                s("CELLxGENE Census", "cellxgene-census"),
                s("AnnData", "anndata"),
                s("GTARS", "gtars"),
                s("ETE Toolkit", "etetoolkit"),
                s("TileDB-VCF", "tiledbvcf"),
                s("FlowIO", "flowio"),
                s("GenIML", "geniml"),
                s("Ensembl Database", "ensembl-database"),
                s("Gene Database", "gene-database"),
            ],
        },
        SkillCategory {
            id: "cheminformatics".into(),
            name: "Cheminformatics & Drug Discovery".into(),
            icon: "flask-conical".into(),
            skill_count: 0,
            skills: vec![
                s("RDKit", "rdkit"),
                s("Datamol", "datamol"),
                s("MolFeat", "molfeat"),
                s("MedChem Filters", "medchem"),
                s("DeepChem", "deepchem"),
                s("PubChem Database", "pubchem-database"),
                s("ChEMBL Database", "chembl-database"),
                s("ZINC Database", "zinc-database"),
                s("TorchDrug", "torchdrug"),
                s("DiffDock", "diffdock"),
                s("Rowan", "rowan"),
            ],
        },
        SkillCategory {
            id: "clinical".into(),
            name: "Clinical Research".into(),
            icon: "heart-pulse".into(),
            skill_count: 0,
            skills: vec![
                s("ClinicalTrials.gov", "clinicaltrials-database"),
                s("ClinVar Database", "clinvar-database"),
                s("ClinPGx Database", "clinpgx-database"),
                s("Treatment Plans", "treatment-plans"),
                s("Clinical Reports", "clinical-reports"),
                s("Clinical Decision Support", "clinical-decision-support"),
                s("DrugBank Database", "drugbank-database"),
                s("FDA Database", "fda-database"),
                s("BRENDA Database", "brenda-database"),
                s("PyTDC", "pytdc"),
                s("ISO 13485 Certification", "iso-13485-certification"),
                s("COSMIC Database", "cosmic-database"),
            ],
        },
        SkillCategory {
            id: "data-analysis".into(),
            name: "Data Analysis & Visualization".into(),
            icon: "bar-chart-3".into(),
            skill_count: 0,
            skills: vec![
                s("Statistical Analysis", "statistical-analysis"),
                s("Exploratory Data Analysis", "exploratory-data-analysis"),
                s("Polars", "polars"),
                s("Dask", "dask"),
                s("Vaex", "vaex"),
                s("NetworkX", "networkx"),
                s("Seaborn", "seaborn"),
                s("Plotly", "plotly"),
                s("Matplotlib", "matplotlib"),
                s("Scientific Visualization", "scientific-visualization"),
                s("Zarr", "zarr-python"),
                s("Data Commons", "datacommons-client"),
                s("Aeon (Time Series ML)", "aeon"),
                s("TimesFM Forecasting", "timesfm-forecasting"),
            ],
        },
        SkillCategory {
            id: "ml-ai".into(),
            name: "Machine Learning & AI".into(),
            icon: "brain".into(),
            skill_count: 0,
            skills: vec![
                s("scikit-learn", "scikit-learn"),
                s("Transformers", "transformers"),
                s("PyTorch Lightning", "pytorch-lightning"),
                s("PyG (Graph Neural Nets)", "torch_geometric"),
                s("Stable Baselines3", "stable-baselines3"),
                s("PufferLib", "pufferlib"),
                s("SHAP", "shap"),
                s("UMAP", "umap-learn"),
                s("HypoGeniC", "hypogenic"),
                s("Hypothesis Generation", "hypothesis-generation"),
                s("Statsmodels", "statsmodels"),
                s("PyMC", "pymc"),
                s("PennyLane", "pennylane"),
                s("Qiskit", "qiskit"),
                s("Cirq", "cirq"),
            ],
        },
        SkillCategory {
            id: "scientific-communication".into(),
            name: "Scientific Communication".into(),
            icon: "book-open".into(),
            skill_count: 0,
            skills: vec![
                s("Scientific Writing", "scientific-writing"),
                s("Literature Review", "literature-review"),
                s("Peer Review", "peer-review"),
                s("Grant Writing", "research-grants"),
                s("Citation Management", "citation-management"),
                s("Scientific Slides", "scientific-slides"),
                s("LaTeX Posters", "latex-posters"),
                s("HTML/PPTX Posters", "pptx-posters"),
                s("Infographics", "infographics"),
                s("Scientific Schematics", "scientific-schematics"),
                s("Markdown & Mermaid", "markdown-mermaid-writing"),
                s("Scientific Brainstorming", "scientific-brainstorming"),
                s("Critical Thinking", "scientific-critical-thinking"),
                s("Scholar Evaluation", "scholar-evaluation"),
                s("Paper to Web", "paper-2-web"),
                s("Venue Templates", "venue-templates"),
                s("Market Research Reports", "market-research-reports"),
                s("Image Generation", "generate-image"),
                s("Open Notebook", "open-notebook"),
                s("MarkItDown", "markitdown"),
            ],
        },
        SkillCategory {
            id: "multi-omics".into(),
            name: "Multi-omics & Systems Biology".into(),
            icon: "microscope".into(),
            skill_count: 0,
            skills: vec![
                s("scvi-tools", "scvi-tools"),
                s("COBRApy", "cobrapy"),
                s("Bioservices", "bioservices"),
                s("Arboreto (GRN)", "arboreto"),
                s("Reactome Database", "reactome-database"),
            ],
        },
        SkillCategory {
            id: "engineering".into(),
            name: "Engineering & Simulation".into(),
            icon: "settings".into(),
            skill_count: 0,
            skills: vec![
                s("SimPy", "simpy"),
                s("pymoo", "pymoo"),
                s("FluidSim", "fluidsim"),
                s("MATLAB/Octave", "matlab"),
            ],
        },
        SkillCategory {
            id: "proteomics".into(),
            name: "Proteomics & Mass Spec".into(),
            icon: "atom".into(),
            skill_count: 0,
            skills: vec![
                s("PyOpenMS", "pyopenms"),
                s("matchms", "matchms"),
                s("ESM (Protein LM)", "esm"),
                s("PDB Database", "pdb-database"),
                s("UniProt Database", "uniprot-database"),
                s("HMDB Database", "hmdb-database"),
            ],
        },
        SkillCategory {
            id: "healthcare-ai".into(),
            name: "Healthcare AI & Clinical ML".into(),
            icon: "activity".into(),
            skill_count: 0,
            skills: vec![
                s("PyHealth", "pyhealth"),
                s("NeuroKit2", "neurokit2"),
                s("scikit-survival", "scikit-survival"),
                s("GWAS Catalog", "gwas-database"),
                s("OpenAlex Database", "openalex-database"),
                s("PubMed Database", "pubmed-database"),
                s("bioRxiv Database", "biorxiv-database"),
                s("GEO Database", "geo-database"),
            ],
        },
        SkillCategory {
            id: "medical-imaging".into(),
            name: "Medical Imaging".into(),
            icon: "scan".into(),
            skill_count: 0,
            skills: vec![
                s("pydicom", "pydicom"),
                s("HistoLab", "histolab"),
                s("PathML", "pathml"),
                s("Neuropixels Analysis", "neuropixels-analysis"),
                s("Imaging Data Commons", "imaging-data-commons"),
                s("GeoMaster", "geomaster"),
                s("GeoPandas", "geopandas"),
            ],
        },
        SkillCategory {
            id: "materials-science".into(),
            name: "Materials Science".into(),
            icon: "gem".into(),
            skill_count: 0,
            skills: vec![
                s("Pymatgen", "pymatgen"),
                s("QuTiP", "qutip"),
                s("SymPy", "sympy"),
                s("Astropy", "astropy"),
                s("Open Targets", "opentargets-database"),
            ],
        },
        SkillCategory {
            id: "physics-astronomy".into(),
            name: "Physics & Astronomy".into(),
            icon: "telescope".into(),
            skill_count: 0,
            skills: vec![
                s("Astropy", "astropy"),
                s("QuTiP", "qutip"),
                s("PennyLane", "pennylane"),
                s("SymPy", "sympy"),
            ],
        },
        SkillCategory {
            id: "lab-automation".into(),
            name: "Laboratory Automation".into(),
            icon: "pipette".into(),
            skill_count: 0,
            skills: vec![
                s("Opentrons", "opentrons-integration"),
                s("PyLabRobot", "pylabrobot"),
                s("Protocols.io", "protocolsio-integration"),
                s("LabArchive", "labarchive-integration"),
                s("Ginkgo Cloud Lab", "ginkgo-cloud-lab"),
            ],
        },
        SkillCategory {
            id: "protein-engineering".into(),
            name: "Protein Engineering".into(),
            icon: "helix".into(),
            skill_count: 0,
            skills: vec![
                s("AlphaFold Database", "alphafold-database"),
                s("ESM (Protein LM)", "esm"),
                s("DiffDock", "diffdock"),
                s("Adaptyv", "adaptyv"),
                s("STRING Database", "string-database"),
                s("LaminDB", "lamindb"),
            ],
        },
        SkillCategory {
            id: "research-methodology".into(),
            name: "Research Methodology".into(),
            icon: "lightbulb".into(),
            skill_count: 0,
            skills: vec![
                s("Hypothesis Generation", "hypothesis-generation"),
                s("Scientific Brainstorming", "scientific-brainstorming"),
                s("Critical Thinking", "scientific-critical-thinking"),
                s("Experimental Design", "hypothesis-generation"),
                s("Scholar Evaluation", "scholar-evaluation"),
                s("Peer Review", "peer-review"),
                s("Research Lookup", "research-lookup"),
                s("Denario", "denario"),
                s("bGPT Paper Search", "bgpt-paper-search"),
                s("Perplexity Search", "perplexity-search"),
            ],
        },
    ];

    for cat in &mut cats {
        cat.skill_count = cat.skills.len();
    }

    cats
}

// ─── Helpers ───

/// Resolve the target skills directory.
fn skills_dir(project_path: Option<&str>) -> Result<PathBuf, String> {
    let scope = if project_path.is_some() {
        domain::SkillScope::Project
    } else {
        domain::SkillScope::User
    };
    paths::resolve_skill_root(
        crate::runtime::RuntimeKind::Claude,
        scope,
        project_path.map(Path::new),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
fn skills_dir_with_home(
    home_dir: Option<&Path>,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    let scope = if project_path.is_some() {
        domain::SkillScope::Project
    } else {
        domain::SkillScope::User
    };
    paths::resolve_skill_root_with_home(
        home_dir,
        project_path.map(Path::new),
        domain::SkillTarget {
            runtime: crate::runtime::RuntimeKind::Claude,
            scope,
        },
    )
    .map_err(|error| error.to_string())
}

fn sanitize_skill_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn find_skill_md(skill_dir: &Path) -> Option<PathBuf> {
    for name in ["SKILL.md", "skill.md"] {
        let candidate = skill_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let entries = std::fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        {
            return Some(path);
        }
    }

    None
}

fn collect_skill_dirs(root: &Path, output: &mut Vec<PathBuf>) {
    if find_skill_md(root).is_some() {
        output.push(root.to_path_buf());
        return;
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        collect_skill_dirs(&entry.path(), output);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyKind {
    All,
    Http,
    Https,
}

struct ProxyRule {
    kind: ProxyKind,
    url: String,
    source: String,
}

fn first_env_value(names: &[&str]) -> Option<(String, String)> {
    for name in names {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(((*name).to_string(), trimmed.to_string()));
        }
    }

    None
}

fn normalize_proxy_url(raw: &str) -> Option<String> {
    normalize_proxy_url_with_default(raw, "http")
}

fn normalize_proxy_url_with_default(raw: &str, default_scheme: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("{}://{}", default_scheme, trimmed))
    }
}

fn explicit_env_proxy_rules() -> Vec<ProxyRule> {
    let mut rules = Vec::new();
    let mut has_https_proxy = false;
    let mut has_all_proxy = false;
    let mut http_proxy = None;

    if let Some((source, raw)) = first_env_value(&["HTTPS_PROXY", "https_proxy"]) {
        if let Some(url) = normalize_proxy_url(&raw) {
            rules.push(ProxyRule {
                kind: ProxyKind::Https,
                url,
                source,
            });
            has_https_proxy = true;
        }
    }

    if let Some((source, raw)) = first_env_value(&["HTTP_PROXY", "http_proxy"]) {
        if let Some(url) = normalize_proxy_url(&raw) {
            http_proxy = Some((source.clone(), url.clone()));
            rules.push(ProxyRule {
                kind: ProxyKind::Http,
                url,
                source,
            });
        }
    }

    if let Some((source, raw)) = first_env_value(&["ALL_PROXY", "all_proxy"]) {
        if let Some(url) = normalize_proxy_url(&raw) {
            rules.push(ProxyRule {
                kind: ProxyKind::All,
                url,
                source,
            });
            has_all_proxy = true;
        }
    }

    if !has_https_proxy && !has_all_proxy {
        if let Some((source, url)) = http_proxy {
            rules.insert(
                0,
                ProxyRule {
                    kind: ProxyKind::Https,
                    url,
                    source: format!("{} (HTTPS fallback)", source),
                },
            );
        }
    }

    rules
}

#[cfg(target_os = "windows")]
fn windows_proxy_override_to_no_proxy(raw: &str) -> Option<reqwest::NoProxy> {
    let entries = raw
        .split([';', ','])
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }

            if trimmed.eq_ignore_ascii_case("<local>") {
                return Some("localhost,127.0.0.1,::1".to_string());
            }

            if trimmed == "*" {
                return Some(trimmed.to_string());
            }

            if trimmed.contains('*') {
                return trimmed
                    .strip_prefix("*.")
                    .map(|domain| format!(".{}", domain.trim_start_matches('.')));
            }

            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>();

    if entries.is_empty() {
        None
    } else {
        reqwest::NoProxy::from_string(&entries.join(","))
    }
}

#[cfg(target_os = "windows")]
fn windows_system_no_proxy() -> Option<reqwest::NoProxy> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let raw = settings.get_value::<String, _>("ProxyOverride").ok()?;
    windows_proxy_override_to_no_proxy(&raw)
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(raw: &str) -> Vec<ProxyRule> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if !trimmed.contains('=') {
        return normalize_proxy_url(trimmed)
            .map(|url| {
                vec![ProxyRule {
                    kind: ProxyKind::All,
                    url,
                    source: "Windows system proxy".to_string(),
                }]
            })
            .unwrap_or_default();
    }

    let mut rules = Vec::new();
    for entry in trimmed.split(';') {
        let Some((scheme, value)) = entry.split_once('=') else {
            continue;
        };
        let scheme = scheme.trim();
        let (kind, default_proxy_scheme) = match scheme.to_ascii_lowercase().as_str() {
            "http" => (ProxyKind::Http, "http"),
            "https" => (ProxyKind::Https, "http"),
            "socks" | "socks5" => (ProxyKind::All, "socks5"),
            "socks4" => (ProxyKind::All, "socks4"),
            _ => continue,
        };
        let Some(url) = normalize_proxy_url_with_default(value, default_proxy_scheme) else {
            continue;
        };

        rules.push(ProxyRule {
            kind,
            url,
            source: format!("Windows system proxy ({})", scheme.trim()),
        });
    }

    rules
}

#[cfg(target_os = "windows")]
fn windows_system_proxy_rules() -> Vec<ProxyRule> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(settings) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return Vec::new();
    };

    let proxy_enabled = settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0;
    if !proxy_enabled {
        return Vec::new();
    }

    settings
        .get_value::<String, _>("ProxyServer")
        .map(|raw| parse_windows_proxy_server(&raw))
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn windows_system_proxy_rules() -> Vec<ProxyRule> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
fn windows_system_no_proxy() -> Option<reqwest::NoProxy> {
    None
}

fn redacted_proxy_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
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

fn add_proxy_rule(
    builder: reqwest::ClientBuilder,
    rule: &ProxyRule,
    no_proxy: Option<reqwest::NoProxy>,
) -> Result<reqwest::ClientBuilder, String> {
    let proxy = match rule.kind {
        ProxyKind::All => reqwest::Proxy::all(&rule.url),
        ProxyKind::Http => reqwest::Proxy::http(&rule.url),
        ProxyKind::Https => reqwest::Proxy::https(&rule.url),
    }
    .map_err(|e| {
        format!(
            "Invalid proxy from {} ({}): {}",
            rule.source,
            redacted_proxy_url(&rule.url),
            e
        )
    })?;

    let proxy = proxy.no_proxy(no_proxy);
    Ok(builder.proxy(proxy))
}

fn configure_proxy_for_client(
    mut builder: reqwest::ClientBuilder,
    window: Option<&WebviewWindow>,
) -> Result<reqwest::ClientBuilder, String> {
    let mut rules = explicit_env_proxy_rules();
    let mut no_proxy = reqwest::NoProxy::from_env();

    if rules.is_empty() {
        let windows_rules = windows_system_proxy_rules();
        if !windows_rules.is_empty() {
            rules = windows_rules;
            no_proxy = windows_system_no_proxy();
        }
    }

    if rules.is_empty() {
        if let Some(window) = window {
            emit_log(window, "Using system proxy settings when available");
        }
        return Ok(builder);
    }

    if let Some(window) = window {
        for rule in &rules {
            emit_log(
                window,
                &format!(
                    "Using proxy from {}: {}",
                    rule.source,
                    redacted_proxy_url(&rule.url)
                ),
            );
        }
    }

    for rule in &rules {
        builder = add_proxy_rule(builder, rule, no_proxy.clone())?;
    }

    Ok(builder)
}

fn build_skills_http_client(
    timeout_secs: u64,
    window: Option<&WebviewWindow>,
) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(SKILLS_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(timeout_secs));

    configure_proxy_for_client(builder, window)?
        .build()
        .map_err(|e| format!("Failed to create download client: {}", e))
}

fn tarball_source_label(url: &str) -> &'static str {
    if url.contains("codeload.github.com") {
        "GitHub codeload"
    } else if url.contains("claude-scientific-skills") {
        "legacy GitHub archive"
    } else {
        "GitHub archive"
    }
}

fn reset_download_workspace(tmp_dir: &Path) {
    let _ = std::fs::remove_dir_all(tmp_dir.join("repo"));
    let _ = std::fs::remove_dir_all(tmp_dir.join("repo-raw"));
    let _ = std::fs::remove_dir_all(tmp_dir.join("raw"));
}

fn find_extracted_repo_dir(raw_dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(raw_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            candidates.push(path);
        }
    }
    candidates.sort();

    for candidate in &candidates {
        if find_skills_source(candidate).is_some() {
            return Some(candidate.clone());
        }
    }

    candidates.into_iter().next()
}

fn short_skill_temp_dir(prefix: &str) -> PathBuf {
    let id = uuid::Uuid::new_v4().to_string();
    std::env::temp_dir()
        .join("lps")
        .join(format!("{prefix}-{}", &id[..8]))
}

fn unpack_tarball(bytes: &[u8], tmp_dir: &Path, subpath: Option<&str>) -> Result<(), String> {
    reset_download_workspace(tmp_dir);

    let raw_dir = tmp_dir.join("raw");
    std::fs::create_dir_all(&raw_dir)
        .map_err(|e| format!("Failed to create extraction dir: {}", e))?;

    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    archive.set_overwrite(true);
    archive.set_preserve_permissions(false);
    archive.set_preserve_mtime(false);

    let mut extracted_files = 0usize;
    let mut last_error: Option<String> = None;
    for entry in archive
        .entries()
        .map_err(|e| format!("Failed to read tarball: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Failed to read tarball entry: {e}"))?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
            || kind.is_gnu_longname()
            || kind.is_gnu_longlink()
            || kind.is_symlink()
            || kind.is_hard_link()
            || kind.is_fifo()
            || kind.is_block_special()
            || kind.is_character_special()
        {
            continue;
        }

        let Some(src_path) = entry.path().ok().map(|path| path.into_owned()) else {
            continue;
        };
        if !should_extract_tar_path(&src_path, &unpack_extract_prefixes(subpath)) {
            continue;
        }
        let Some(rel_path) = sanitize_tar_relpath(&src_path) else {
            continue;
        };
        if rel_path.as_os_str().is_empty() {
            continue;
        }

        let dest = raw_dir.join(&rel_path);
        if !dest.starts_with(&raw_dir) {
            continue;
        }
        let is_dir = kind.is_dir() || src_path.as_os_str().to_string_lossy().ends_with('/');
        if !is_dir && !(kind.is_file() || kind.is_contiguous() || kind.is_gnu_sparse()) {
            continue;
        }

        match extract_tar_entry(&mut entry, &dest, is_dir) {
            Ok(()) => {
                if !is_dir {
                    extracted_files += 1;
                }
            }
            Err(error) => {
                let message = format!("{} ({error})", dest.display());
                last_error = Some(message.clone());
                if is_required_skill_extract_path(&rel_path) {
                    return Err(format!("Failed to extract tarball: {message}"));
                }
            }
        }
    }

    if extracted_files == 0 {
        return Err(last_error
            .map(|error| format!("Failed to extract tarball: {error}"))
            .unwrap_or_else(|| {
                "Failed to extract tarball: archive had no usable files".into()
            }));
    }

    let repo_source = find_extracted_repo_dir(&raw_dir)
        .ok_or_else(|| "Downloaded tarball did not contain a repository directory".to_string())?;

    let dest = tmp_dir.join("repo");
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    if let Err(error) = std::fs::rename(&repo_source, &dest) {
        copy_dir_recursive(&repo_source, &dest).map_err(|copy_error| {
            format!("Failed to prepare extracted repo: {error}; {copy_error}")
        })?;
    }

    let _ = std::fs::remove_dir_all(&raw_dir);
    Ok(())
}

fn extract_tar_entry<R: Read>(
    entry: &mut tar::Entry<'_, R>,
    dest: &Path,
    is_dir: bool,
) -> std::io::Result<()> {
    if is_dir {
        return std::fs::create_dir_all(dest);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(dest)?;
    std::io::copy(entry, &mut file)?;
    Ok(())
}

fn unpack_extract_prefixes(subpath: Option<&str>) -> Vec<String> {
    let Some(path) = subpath.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let normalized = path.replace('\\', "/").trim_matches('/').to_string();
    let mut prefixes = vec![normalized.clone()];
    if normalized.eq_ignore_ascii_case("skills") {
        prefixes.push("commands".into());
    } else if let Some(parent) = normalized.strip_suffix("/skills") {
        prefixes.push(format!("{parent}/commands"));
    }
    prefixes
}

fn should_extract_tar_path(path: &Path, prefixes: &[String]) -> bool {
    if prefixes.is_empty() {
        return true;
    }
    let relative = tar_path_after_repo_root(path);
    if relative.as_os_str().is_empty() {
        return true;
    }
    prefixes.iter().any(|wanted| {
        let wanted_path = Path::new(wanted);
        relative == wanted_path
            || relative.starts_with(wanted_path)
            || wanted_path.starts_with(&relative)
    })
}

fn tar_path_after_repo_root(path: &Path) -> PathBuf {
    path.components().skip(1).collect()
}

fn safe_import_subpath(subpath: &str) -> Option<String> {
    let sanitized = sanitize_tar_relpath(Path::new(subpath))?;
    sanitized
        .to_str()
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn is_required_skill_extract_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("SKILL.md") || name.eq_ignore_ascii_case("AGENT.md")
        })
}

fn sanitize_tar_relpath(path: &Path) -> Option<PathBuf> {
    let mut sanitized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let cleaned = sanitize_tar_component(&name.to_string_lossy());
                if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
                    return None;
                }
                sanitized.push(cleaned);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(sanitized)
}

fn sanitize_tar_component(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    let trimmed = replaced.trim_end_matches([' ', '.']);
    if trimmed.is_empty() || trimmed.len() > 240 || trimmed == "." || trimmed == ".." {
        return String::new();
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

async fn download_tarball_once(
    client: &reqwest::Client,
    window: &WebviewWindow,
    tmp_dir: &Path,
    url: &str,
) -> Result<(), String> {
    reset_download_workspace(tmp_dir);

    let source_label = tarball_source_label(url);
    emit_log(window, &format!("Downloading from {}...", source_label));

    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "LocalPrism skills installer")
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let total_size = response.content_length();
    let mut bytes =
        Vec::with_capacity(total_size.unwrap_or_default().min(64 * 1024 * 1024) as usize);
    let mut downloaded = 0_u64;
    let mut last_emitted_percent = 0_u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read download bytes: {}", e))?
    {
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        if let Some(total) = total_size {
            if total > 0 {
                let percent = ((downloaded.saturating_mul(100)) / total).min(100);
                if percent >= last_emitted_percent + 5 || percent == 100 {
                    emit_log(window, &format!("Download progress {}%", percent));
                    last_emitted_percent = percent;
                }
            }
        } else if downloaded / (1024 * 1024) > last_emitted_percent {
            last_emitted_percent = downloaded / (1024 * 1024);
            emit_log(window, &format!("Downloaded {} MiB", last_emitted_percent));
        }
    }

    unpack_tarball(&bytes, tmp_dir, None)
}

/// Download and extract tarball.
async fn download_tarball(window: &WebviewWindow, tmp_dir: &Path) -> Result<(), String> {
    let client = build_skills_http_client(SKILLS_DOWNLOAD_TIMEOUT_SECS, Some(window))?;

    let mut last_error = None;
    for attempt in 1..=SKILLS_DOWNLOAD_ATTEMPTS {
        for url in TARBALL_URLS {
            let label = tarball_source_label(url);
            emit_log(
                window,
                &format!(
                    "Download attempt {}/{} ({})",
                    attempt, SKILLS_DOWNLOAD_ATTEMPTS, label
                ),
            );

            match download_tarball_once(&client, window, tmp_dir, url).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let message = format!("{} failed: {}", label, e);
                    emit_log(window, &message);
                    last_error = Some(message);
                    reset_download_workspace(tmp_dir);
                }
            }
        }

        if attempt < SKILLS_DOWNLOAD_ATTEMPTS {
            let delay_secs = attempt as u64 * 2;
            emit_log(window, &format!("Retrying in {} seconds...", delay_secs));
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        }
    }

    Err(format!(
        "Failed to download skills after {} attempts. Last error: {}",
        SKILLS_DOWNLOAD_ATTEMPTS,
        last_error.unwrap_or_else(|| "unknown download error".to_string())
    ))
}

fn contains_skill_dirs(path: &Path) -> bool {
    let mut dirs = Vec::new();
    collect_skill_dirs(path, &mut dirs);
    !dirs.is_empty()
}

fn find_skills_source(repo_dir: &Path) -> Option<PathBuf> {
    for subfolder in SKILLS_SUBFOLDERS {
        let candidate = repo_dir.join(subfolder);
        if contains_skill_dirs(&candidate) {
            return Some(candidate);
        }
    }

    if contains_skill_dirs(repo_dir) {
        return Some(repo_dir.to_path_buf());
    }

    let entries = std::fs::read_dir(repo_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_dir() && contains_skill_dirs(&candidate) {
            return Some(candidate);
        }
    }

    None
}

fn skills_staging_dir(target_dir: &Path) -> PathBuf {
    let parent = target_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let target_name = target_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skills");

    parent.join(format!(
        ".{}-installing-{}",
        target_name,
        uuid::Uuid::new_v4().simple()
    ))
}

fn hidden_sibling_path(path: &Path, label: &str) -> PathBuf {
    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");

    parent.join(format!(
        ".{}-{}-{}",
        name,
        label,
        uuid::Uuid::new_v4().simple()
    ))
}

fn replace_dir_from_staging(staged: &Path, target: &Path) -> Result<(), String> {
    let backup = hidden_sibling_path(target, "backup");
    let had_existing = target.exists();

    if had_existing {
        std::fs::rename(target, &backup).map_err(|e| {
            format!(
                "Failed to prepare replacement for {}: {}",
                target.display(),
                e
            )
        })?;
    }

    match std::fs::rename(staged, target) {
        Ok(()) => {
            if had_existing {
                let _ = std::fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(e) => {
            let restore_error = if had_existing {
                std::fs::rename(&backup, target)
                    .err()
                    .map(|restore| format!(" Restore also failed: {}", restore))
            } else {
                None
            };

            Err(format!(
                "Failed to install {}: {}{}",
                target.display(),
                e,
                restore_error.unwrap_or_default()
            ))
        }
    }
}

/// Copy the skills directory from the downloaded repo to the target.
fn copy_skills(repo_dir: &Path, target_dir: &Path) -> Result<usize, String> {
    let src = find_skills_source(repo_dir).ok_or_else(|| {
        format!(
            "skills directory not found in downloaded repo at {}",
            repo_dir.display()
        )
    })?;

    // Create target directory
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&src, &mut skill_dirs);
    skill_dirs.sort();

    if skill_dirs.is_empty() {
        return Err("No skills found in downloaded repository".into());
    }

    let staging_dir = skills_staging_dir(target_dir);
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    let mut staged_names = Vec::new();
    let stage_result = (|| -> Result<(), String> {
        for entry_path in &skill_dirs {
            let Some(skill_name) = entry_path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };

            let staged_skill = staging_dir.join(skill_name);
            copy_dir_recursive(entry_path, &staged_skill)?;
            staged_names.push(skill_name.to_string());
        }

        Ok(())
    })();

    if let Err(e) = stage_result {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(e);
    }

    let replace_result = (|| -> Result<usize, String> {
        let mut count = 0;
        for skill_name in staged_names {
            let staged_skill = staging_dir.join(&skill_name);
            let target_skill = target_dir.join(&skill_name);
            if import::find_skill_md(&target_skill).is_some() {
                count += 1;
                continue;
            }

            replace_dir_from_staging(&staged_skill, &target_skill).map_err(|e| {
                format!(
                    "Failed to replace {} with staged skill {}: {}",
                    target_skill.display(),
                    skill_name,
                    e
                )
            })?;
            count += 1;
        }

        Ok(count)
    })();

    let _ = std::fs::remove_dir_all(&staging_dir);
    replace_result
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {}: {}", dst.display(), e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {}", src.display(), e))?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let target = dst.join(entry.file_name());

        if entry_path.is_dir() {
            if import::should_skip_skill_tree_entry(&entry.file_name().to_string_lossy()) {
                continue;
            }
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            std::fs::copy(&entry_path, &target)
                .map_err(|e| format!("Failed to copy {}: {}", entry_path.display(), e))?;
        }
    }

    Ok(())
}

/// Parse a SKILL.md file to extract skill info.
fn parse_skill_md(skill_dir: &Path) -> Option<SkillInfo> {
    let skill_md = find_skill_md(skill_dir)?;

    let content = std::fs::read_to_string(&skill_md).ok()?;
    let folder = skill_dir.file_name()?.to_string_lossy().to_string();

    // Extract title from first # heading
    let name = content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches("# ").trim().to_string())
        .unwrap_or_else(|| folder.clone());

    // Extract description from first paragraph after heading
    let description = content
        .lines()
        .skip_while(|l| !l.starts_with("# "))
        .skip(1)
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect::<String>();

    // Infer domain from folder name prefix (e.g., "bioinformatics-rna-seq" → "bioinformatics")
    let domain = folder.split('-').next().unwrap_or("general").to_string();

    Some(SkillInfo {
        id: folder.clone(),
        name,
        domain,
        description,
        folder,
    })
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn install_scientific_skills(
    window: WebviewWindow,
    project_path: String,
) -> Result<InstallResult, String> {
    let target = skills_dir(Some(&project_path))?;
    install_skills_with_timeout(&window, &target, Some(&project_path)).await
}

#[tauri::command]
pub async fn install_scientific_skills_global(
    window: WebviewWindow,
) -> Result<InstallResult, String> {
    let target = skills_dir(None)?;
    install_skills_with_timeout(&window, &target, None).await
}

#[tauri::command]
pub async fn import_skill_from_folder(source_path: String) -> Result<Vec<SkillInfo>, String> {
    // Backward-compatible adapter: Claude user scope.
    let installed = skill_import(
        source_path,
        vec![domain::SkillTarget {
            runtime: crate::runtime::RuntimeKind::Claude,
            scope: domain::SkillScope::User,
        }],
        None,
    )
    .await?;
    Ok(installed
        .into_iter()
        .map(|skill| SkillInfo {
            id: skill.folder.clone(),
            name: skill.name,
            domain: "imported".into(),
            description: skill.description,
            folder: skill.folder,
        })
        .collect())
}

#[tauri::command]
pub async fn skill_import(
    source_path: String,
    targets: Vec<domain::SkillTarget>,
    project_path: Option<String>,
) -> Result<Vec<domain::RuntimeSkill>, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_dir() {
        return Err("Selected path is not a folder".into());
    }

    let mut skill_dirs = Vec::new();
    import::collect_skill_dirs(&source, &mut skill_dirs);
    skill_dirs.sort();
    let project = project_path.as_deref().map(Path::new);
    let imported = import_collected_skill_dirs(
        skill_dirs,
        &targets,
        project,
        manifest::SkillSource::Folder {
            path: source.to_string_lossy().to_string(),
        },
        false,
    )?;
    let _ = crate::slash_commands::import_user_slash_commands_from_source(&source, true);
    Ok(imported)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubImportSpec {
    owner: String,
    repo: String,
    git_ref: String,
    subpath: Option<String>,
}

fn strip_url_suffix(url: &str) -> &str {
    url.split_once('#')
        .map(|(head, _)| head)
        .unwrap_or(url)
        .split_once('?')
        .map(|(head, _)| head)
        .unwrap_or(url)
        .trim_end_matches('/')
}

fn parse_github_import_url(url: &str) -> Option<GithubImportSpec> {
    let cleaned = strip_url_suffix(url.trim());
    let rest = cleaned
        .strip_prefix("https://github.com/")
        .or_else(|| cleaned.strip_prefix("http://github.com/"))?;
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    let kind = parts.next();
    let (git_ref, subpath) = match kind {
        Some("tree") | Some("blob") => {
            let git_ref = parts.next().unwrap_or("main").to_string();
            let remainder = parts.collect::<Vec<_>>().join("/");
            (
                git_ref,
                if remainder.is_empty() {
                    None
                } else {
                    Some(remainder)
                },
            )
        }
        _ => ("main".to_string(), None),
    };
    Some(GithubImportSpec {
        owner,
        repo,
        git_ref,
        subpath,
    })
}

fn archive_urls_for_import(url: &str) -> Vec<String> {
    if let Some(spec) = parse_github_import_url(url) {
        let mut refs = vec![spec.git_ref.clone()];
        if spec.git_ref == "main" {
            refs.push("master".into());
        } else if spec.git_ref == "master" {
            refs.push("main".into());
        }
        let mut urls = Vec::new();
        for git_ref in refs {
            urls.push(format!(
                "https://codeload.github.com/{}/{}/tar.gz/{}",
                spec.owner, spec.repo, git_ref
            ));
            urls.push(format!(
                "https://github.com/{}/{}/archive/refs/heads/{}.tar.gz",
                spec.owner, spec.repo, git_ref
            ));
        }
        return urls;
    }
    vec![url.trim().to_string()]
}

fn is_skill_markdown_url(url: &str) -> bool {
    let cleaned = strip_url_suffix(url.trim()).to_ascii_lowercase();
    cleaned.ends_with("/skill.md") || cleaned.ends_with("skill.md")
}

async fn download_url_bytes(
    url: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<Vec<u8>, String> {
    let window = app.and_then(|handle| handle.get_webview_window("main"));
    let client = build_skills_http_client(SKILLS_DOWNLOAD_TIMEOUT_SECS, window.as_ref())?;
    if let Some(app) = app {
        emit_install_log(app, "Downloading skills...");
        emit_install_log(
            app,
            &format!("Downloading from {}...", tarball_source_label(url)),
        );
    }
    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "LocalPrism skills importer")
        .send()
        .await
        .map_err(|error| format!("Failed to download {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Download failed for {url} with status {}",
            response.status()
        ));
    }
    let total_size = response.content_length();
    let mut bytes =
        Vec::with_capacity(total_size.unwrap_or_default().min(64 * 1024 * 1024) as usize);
    let mut downloaded = 0_u64;
    let mut last_emitted_percent = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read {url}: {error}"))?
    {
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        let Some(app) = app else {
            continue;
        };
        if let Some(total) = total_size.filter(|value| *value > 0) {
            let percent = ((downloaded.saturating_mul(100)) / total).min(100);
            if percent >= last_emitted_percent + 5 || percent == 100 {
                emit_install_log(app, &format!("Download progress {percent}%"));
                last_emitted_percent = percent;
            }
        } else if downloaded / (1024 * 1024) > last_emitted_percent {
            last_emitted_percent = downloaded / (1024 * 1024);
            emit_install_log(app, &format!("Downloaded {last_emitted_percent} MiB"));
        }
    }
    if let Some(app) = app {
        emit_install_log(app, "Download complete");
    }
    Ok(bytes)
}

#[cfg(test)]
fn skill_already_installed(
    skill_dir: &Path,
    targets: &[domain::SkillTarget],
    project: Option<&Path>,
) -> bool {
    let existing = import::snapshot_installed_targets(skill_dir, targets, project);
    !targets.is_empty() && existing.len() == targets.len()
}

fn normalize_skill_import_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(index) = trimmed.find("https://").or_else(|| trimmed.find("http://")) {
        let rest = &trimmed[index..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        return rest[..end]
            .trim_end_matches(|ch: char| {
                matches!(ch, ')' | ']' | '>' | ',' | '"' | '\'' | '。' | '，')
            })
            .to_string();
    }
    if let Some(https) = github_ssh_to_https(trimmed) {
        return https;
    }
    trimmed.to_string()
}

fn github_ssh_to_https(raw: &str) -> Option<String> {
    let rest = raw
        .strip_prefix("git@github.com:")
        .or_else(|| raw.strip_prefix("ssh://git@github.com/"))
        .or_else(|| {
            raw.find("git@github.com:")
                .map(|index| &raw[index + "git@github.com:".len()..])
        })
        .or_else(|| {
            raw.find("ssh://git@github.com/")
                .map(|index| &raw[index + "ssh://git@github.com/".len()..])
        })?;
    let rest = rest.split_whitespace().next()?.trim_end_matches('/');
    let rest = rest.trim_end_matches(".git");
    if rest.is_empty() || rest.contains(' ') {
        return None;
    }
    Some(format!("https://github.com/{rest}"))
}

fn import_collected_skill_dirs(
    skill_dirs: Vec<PathBuf>,
    targets: &[domain::SkillTarget],
    project: Option<&Path>,
    source: manifest::SkillSource,
    skip_existing: bool,
) -> Result<Vec<domain::RuntimeSkill>, String> {
    if skill_dirs.is_empty() {
        return Err(
            "Downloaded source does not contain any skills. A skill must contain SKILL.md.".into(),
        );
    }
    let mut imported = Vec::new();
    let mut errors = Vec::new();
    for skill_dir in skill_dirs {
        let existing = import::snapshot_installed_targets(&skill_dir, targets, project);
        let already_installed = !targets.is_empty() && existing.len() == targets.len();
        if skip_existing && already_installed {
            imported.extend(existing);
            continue;
        }
        match import::import_skill_to_targets(&skill_dir, targets, project, source.clone()) {
            Ok(mut batch) => imported.append(&mut batch),
            Err(error) => {
                if already_installed {
                    imported.extend(existing);
                } else {
                    errors.push(error.to_string());
                }
            }
        }
    }
    if imported.is_empty() {
        if errors.is_empty() {
            return Err(
                "Downloaded source does not contain any skills. A skill must contain SKILL.md."
                    .into(),
            );
        }
        return Err(errors.join("\n"));
    }
    Ok(imported)
}

#[tauri::command]
pub async fn skill_import_url(
    app: tauri::AppHandle,
    source_url: String,
    targets: Vec<domain::SkillTarget>,
    project_path: Option<String>,
    skip_existing: Option<bool>,
) -> Result<Vec<domain::RuntimeSkill>, String> {
    let source_url = normalize_skill_import_url(&source_url);
    if source_url.is_empty() {
        return Err("Skill URL cannot be empty".into());
    }
    if !(source_url.starts_with("https://") || source_url.starts_with("http://")) {
        return Err(
            "Skill URL must be an http(s) link. GitHub links such as https://github.com/owner/repo are supported."
                .into(),
        );
    }

    let project = project_path.as_deref().map(Path::new);
    let skip_existing = skip_existing.unwrap_or(false);
    let source = manifest::SkillSource::Url {
        url: source_url.clone(),
    };
    let tmp_dir = short_skill_temp_dir("imp");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|error| format!("Failed to create download workspace: {error}"))?;

    let import_result = async {
        if is_skill_markdown_url(&source_url) {
            let bytes = download_url_bytes(&source_url, Some(&app)).await?;
            let text = String::from_utf8(bytes)
                .map_err(|error| format!("SKILL.md is not valid UTF-8: {error}"))?;
            let folder = source_url
                .rsplit('/')
                .nth(1)
                .map(sanitize_skill_folder_name)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "imported-skill".into());
            let skill_dir = tmp_dir.join(folder);
            std::fs::create_dir_all(&skill_dir)
                .map_err(|error| format!("Failed to create skill folder: {error}"))?;
            std::fs::write(skill_dir.join("SKILL.md"), text)
                .map_err(|error| format!("Failed to write SKILL.md: {error}"))?;
            emit_install_log(&app, "Copying skills...");
            let imported = import_collected_skill_dirs(
                vec![skill_dir],
                &targets,
                project,
                source,
                skip_existing,
            )?;
            emit_install_log(&app, &format!("Copied {} skills", imported.len()));
            return Ok(imported);
        }

        let spec = parse_github_import_url(&source_url);
        let subpath = spec
            .as_ref()
            .and_then(|value| value.subpath.as_deref())
            .and_then(safe_import_subpath);
        let mut last_error = None;
        for archive_url in archive_urls_for_import(&source_url) {
            match download_url_bytes(&archive_url, Some(&app)).await {
                Ok(bytes) => match unpack_tarball(&bytes, &tmp_dir, subpath.as_deref()) {
                    Ok(()) => {
                        last_error = None;
                        break;
                    }
                    Err(error) => last_error = Some(error),
                },
                Err(error) => last_error = Some(error),
            }
        }
        if let Some(error) = last_error {
            return Err(format!(
                "Could not download skills from {source_url}. {error}"
            ));
        }

        let repo_dir = tmp_dir.join("repo");
        let search_root = subpath
            .as_ref()
            .map(|path| repo_dir.join(path))
            .filter(|path| path.exists() && path.starts_with(&repo_dir))
            .unwrap_or(repo_dir);
        let mut skill_dirs = Vec::new();
        import::collect_skill_dirs(&search_root, &mut skill_dirs);
        skill_dirs.sort();
        emit_install_log(&app, "Copying skills...");
        let imported = import_collected_skill_dirs(
            skill_dirs,
            &targets,
            project,
            source,
            skip_existing,
        )?;
        let _ = crate::slash_commands::import_user_slash_commands_from_source(
            &tmp_dir.join("repo"),
            skip_existing,
        );
        emit_install_log(&app, &format!("Copied {} skills", imported.len()));
        Ok(imported)
    }
    .await;

    let _ = std::fs::remove_dir_all(&tmp_dir);
    import_result
}

#[tauri::command]
pub async fn skill_list(project_path: Option<String>) -> Result<Vec<domain::RuntimeSkill>, String> {
    import::list_runtime_skills(project_path.as_deref().map(Path::new))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn skill_delete_managed(entry_id: String, confirm_modified: bool) -> Result<(), String> {
    import::delete_managed_skill(&entry_id, confirm_modified).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn skill_auto_import_project(
    project_path: String,
) -> Result<Vec<domain::RuntimeSkill>, String> {
    let path = PathBuf::from(&project_path);
    import::auto_import_project_skills(&path).map_err(|error| error.to_string())
}

/// Ensure the target directory is creatable and writable.
/// If creation fails (e.g. ~/.claude is owned by root), prompt for admin password via osascript.
fn ensure_target_writable(target: &Path) -> Result<(), String> {
    // Try without elevation first
    if std::fs::create_dir_all(target).is_ok() {
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir().ok_or("Could not determine home directory")?;
        let user = std::env::var("USER").unwrap_or_default();
        let claude_dir = home.join(".claude");

        let script = format!(
            "mkdir -p '{}' && chown -R {} '{}'",
            target.display(),
            user,
            claude_dir.display()
        );

        let output = std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"{}\" with administrator privileges",
                    script
                ),
            ])
            .output()
            .map_err(|e| format!("Failed to run osascript: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Failed to fix directory permissions. Error: {}. \
                 You can fix this manually by running: sudo chown -R $(whoami) ~/.claude",
                stderr.trim()
            ));
        }

        // Verify writable
        let test_file = target.join(".prism_write_test");
        std::fs::write(&test_file, "test").map_err(|e| {
            format!(
                "Directory {} still not writable after elevation: {}",
                target.display(),
                e
            )
        })?;
        let _ = std::fs::remove_file(&test_file);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        return Err(format!(
            "Failed to create directory {}. Please check permissions.",
            target.display()
        ));
    }
}

/// Emit a progress log event to the frontend + stderr for terminal debugging.
fn emit_install_log(app: &tauri::AppHandle, msg: &str) {
    eprintln!("[skills] {}", msg);
    let _ = app.emit("skills-install-log", msg.to_string());
}

fn emit_log(window: &WebviewWindow, msg: &str) {
    emit_install_log(window.app_handle(), msg);
}

async fn install_skills_with_timeout(
    window: &WebviewWindow,
    target: &Path,
    project_path: Option<&str>,
) -> Result<InstallResult, String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(SKILLS_INSTALL_TIMEOUT_SECS),
        install_skills_to(window, target, project_path),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let message = format!(
                "Skills installation timed out after {} seconds. Check your network or try again later.",
                SKILLS_INSTALL_TIMEOUT_SECS
            );
            emit_log(window, &message);
            Err(message)
        }
    }
}

/// Core installation logic.
async fn install_skills_to(
    window: &WebviewWindow,
    target: &Path,
    _project_path: Option<&str>,
) -> Result<InstallResult, String> {
    emit_log(window, &format!("Target directory: {}", target.display()));

    // Ensure target directory is writable before proceeding
    emit_log(window, "Checking directory permissions...");
    ensure_target_writable(target).map_err(|e| {
        emit_log(window, &format!("Permission error: {}", e));
        e
    })?;
    emit_log(window, "Directory permissions OK");

    // Create a temporary directory for the clone/download
    let tmp_dir = short_skill_temp_dir("sas");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| {
        let msg = format!("Failed to create temp dir: {}", e);
        emit_log(window, &msg);
        msg
    })?;

    let result = async {
        // Download via tarball (faster, no git/git-lfs dependency)
        emit_log(window, "Downloading skills...");
        download_tarball(window, &tmp_dir).await.map_err(|e| {
            emit_log(window, &format!("Download failed: {}", e));
            e
        })?;
        emit_log(window, "Download complete");

        let repo_dir = tmp_dir.join("repo");

        // Copy skills to target directory
        emit_log(window, "Copying skills...");
        let count = copy_skills(&repo_dir, target).map_err(|e| {
            emit_log(window, &format!("Copy failed: {}", e));
            e
        })?;
        emit_log(window, &format!("Copied {} skills", count));
        match crate::slash_commands::import_user_slash_commands_from_source(&repo_dir, true) {
            Ok(commands) => {
                emit_log(
                    window,
                    &format!("Imported {commands} official slash commands into claude-home/slash"),
                );
            }
            Err(error) => {
                emit_log(window, &format!("Slash command import skipped: {error}"));
            }
        }

        let target_str = target.to_string_lossy().to_string();

        Ok(InstallResult {
            success: true,
            skills_installed: count,
            target_dir: target_str.clone(),
            message: format!("Successfully installed {} skills to {}", count, target_str),
        })
    }
    .await;

    match std::fs::remove_dir_all(&tmp_dir) {
        Ok(_) => emit_log(window, "Cleanup complete"),
        Err(e) if tmp_dir.exists() => emit_log(window, &format!("Cleanup failed: {}", e)),
        Err(_) => {}
    }

    result
}

#[tauri::command]
pub async fn check_skills_installed(project_path: Option<String>) -> Result<SkillsStatus, String> {
    let target = skills_dir(project_path.as_deref())?;

    if !target.exists() {
        return Ok(SkillsStatus {
            installed: false,
            skill_count: 0,
            location: target.to_string_lossy().to_string(),
        });
    }

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&target, &mut skill_dirs);
    let count = skill_dirs.len();

    Ok(SkillsStatus {
        installed: count > 0,
        skill_count: count,
        location: target.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn list_installed_skills(project_path: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let target = skills_dir(project_path.as_deref())?;

    if !target.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();
    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&target, &mut skill_dirs);
    skill_dirs.sort();

    for skill_dir in skill_dirs {
        if let Some(info) = parse_skill_md(&skill_dir) {
            skills.push(info);
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[tauri::command]
pub async fn delete_installed_skill(skill_folder: String) -> Result<(), String> {
    if skill_folder.trim().is_empty() {
        return Err("Skill folder cannot be empty".into());
    }

    let target = skills_dir(None)?;
    if !target.exists() {
        return Err("No global skills directory found".into());
    }

    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve global skills directory: {}", e))?;

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&target, &mut skill_dirs);
    let skill_dir = skill_dirs
        .into_iter()
        .find(|dir| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == skill_folder)
        })
        .ok_or_else(|| format!("Skill '{}' is not installed", skill_folder))?;

    let skill_canon = skill_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skill folder: {}", e))?;
    if !skill_canon.starts_with(&target_canon) {
        return Err("Refusing to delete a skill outside LocalPrism skills".into());
    }

    std::fs::remove_dir_all(&skill_canon)
        .map_err(|e| format!("Failed to delete skill {}: {}", skill_folder, e))?;

    Ok(())
}

#[tauri::command]
pub async fn uninstall_scientific_skills(project_path: Option<String>) -> Result<(), String> {
    let target = skills_dir(project_path.as_deref())?;

    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Failed to remove skills: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_skill_categories() -> Vec<SkillCategory> {
    skill_categories()
}

/// Read the raw SKILL.md content for a specific skill folder.
/// Tries local install first, then fetches from GitHub.
#[tauri::command]
pub async fn get_skill_content(
    skill_folder: String,
    project_path: Option<String>,
) -> Result<String, String> {
    // Try local (project-level first, then global)
    let locations: Vec<PathBuf> = match project_path.as_deref() {
        Some(pp) => vec![skills_dir(Some(pp))?, skills_dir(None)?],
        None => vec![skills_dir(None)?],
    };

    for base in &locations {
        let skill_dir = base.join(&skill_folder);
        if let Some(skill_md) = find_skill_md(&skill_dir) {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }

        let mut skill_dirs = Vec::new();
        collect_skill_dirs(base, &mut skill_dirs);
        for skill_dir in skill_dirs {
            if skill_dir
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == skill_folder)
            {
                if let Some(skill_md) = find_skill_md(&skill_dir) {
                    return std::fs::read_to_string(&skill_md)
                        .map_err(|e| format!("Failed to read SKILL.md: {}", e));
                }
            }
        }
    }

    // Fallback: fetch from GitHub. The upstream project moved from
    // claude-scientific-skills/scientific-skills to scientific-agent-skills/skills.
    let client = build_skills_http_client(SKILL_CONTENT_TIMEOUT_SECS, None)
        .map_err(|e| format!("Failed to create GitHub client: {}", e))?;

    let mut last_error = None;
    for base_url in RAW_SKILL_URLS {
        for skill_file in ["SKILL.md", "skill.md"] {
            let url = format!("{}/{}/{}", base_url, skill_folder, skill_file);
            let response = match client
                .get(&url)
                .header(reqwest::header::USER_AGENT, "LocalPrism skills viewer")
                .send()
                .await
            {
                Ok(response) => response,
                Err(e) => {
                    last_error = Some(format!("{}: {}", url, e));
                    continue;
                }
            };

            if response.status().is_success() {
                match response.text().await {
                    Ok(text) => return Ok(text),
                    Err(e) => {
                        last_error = Some(format!("{}: failed to read response: {}", url, e));
                        continue;
                    }
                }
            }

            last_error = Some(format!("{}: HTTP {}", url, response.status()));
        }
    }

    Err(format!(
        "Skill '{}' not found. Last error: {}",
        skill_folder,
        last_error.unwrap_or_else(|| "unknown".to_string())
    ))
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_github_import_url() {
        assert_eq!(
            parse_github_import_url("https://github.com/acme/writer-skill"),
            Some(GithubImportSpec {
                owner: "acme".into(),
                repo: "writer-skill".into(),
                git_ref: "main".into(),
                subpath: None,
            })
        );
        assert_eq!(
            parse_github_import_url(
                "https://github.com/acme/writer-skill/tree/develop/skills/writer"
            ),
            Some(GithubImportSpec {
                owner: "acme".into(),
                repo: "writer-skill".into(),
                git_ref: "develop".into(),
                subpath: Some("skills/writer".into()),
            })
        );
        assert!(is_skill_markdown_url(
            "https://raw.githubusercontent.com/acme/writer/main/skills/writer/SKILL.md"
        ));
        assert!(!is_skill_markdown_url(
            "https://github.com/acme/writer-skill"
        ));
        assert_eq!(
            normalize_skill_import_url(
                "git@github.com:crabin/paper-humanizer-skill.git"
            ),
            "https://github.com/crabin/paper-humanizer-skill"
        );
        assert_eq!(
            normalize_skill_import_url(
                "/install-skills 安装一下 https://github.com/crabin/paper-humanizer-skill.git /tmp/paper-humanizer-skill skill"
            ),
            "https://github.com/crabin/paper-humanizer-skill.git"
        );
        assert_eq!(
            parse_github_import_url("https://github.com/crabin/paper-humanizer-skill.git"),
            Some(GithubImportSpec {
                owner: "crabin".into(),
                repo: "paper-humanizer-skill".into(),
                git_ref: "main".into(),
                subpath: None,
            })
        );
        assert_eq!(
            parse_github_import_url(
                "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills"
            ),
            Some(GithubImportSpec {
                owner: "WUBING2023".into(),
                repo: "PaperSpine".into(),
                git_ref: "main".into(),
                subpath: Some("dist/claude/skills".into()),
            })
        );
    }

    fn gzip_tar(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (path, content) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, path, *content)
                    .expect("append tar data");
            }
            builder.finish().expect("finish tar");
        }
        let mut encoded = Vec::new();
        {
            let mut encoder =
                flate2::write::GzEncoder::new(&mut encoded, flate2::Compression::fast());
            encoder.write_all(&tar_bytes).expect("gzip tar");
            encoder.finish().expect("finish gzip");
        }
        encoded
    }

    #[test]
    fn test_should_extract_tar_path_filters_to_subpath() {
        let skills = unpack_extract_prefixes(Some("dist/claude/skills"));
        assert_eq!(
            skills,
            vec![
                "dist/claude/skills".to_string(),
                "dist/claude/commands".to_string()
            ]
        );
        assert_eq!(
            unpack_extract_prefixes(Some("skills")),
            vec!["skills".to_string(), "commands".to_string()]
        );
        assert!(should_extract_tar_path(
            Path::new("PaperSpine-main/dist/claude/skills/x/SKILL.md"),
            &skills
        ));
        assert!(should_extract_tar_path(
            Path::new("PaperSpine-main/dist/claude"),
            &skills
        ));
        assert!(should_extract_tar_path(
            Path::new("PaperSpine-main/dist/claude/commands/paperspine.md"),
            &skills
        ));
        assert!(!should_extract_tar_path(
            Path::new("PaperSpine-main/README.md"),
            &skills
        ));
        assert!(should_extract_tar_path(
            Path::new("PaperSpine-main/README.md"),
            &[]
        ));
    }

    #[test]
    fn test_sanitize_tar_relpath_rejects_parent_and_fixes_windows_names() {
        assert_eq!(sanitize_tar_relpath(Path::new("repo/../x")), None);
        assert_eq!(sanitize_tar_relpath(Path::new("repo/.. /x")), None);
        assert_eq!(sanitize_tar_component("foo:bar"), "foo_bar");
        assert_eq!(sanitize_tar_component("aux"), "_aux");
        assert_eq!(sanitize_tar_component(".. "), "");
        assert_eq!(sanitize_tar_component(".."), "");
        assert_eq!(
            sanitize_tar_relpath(Path::new("repo/good/SKILL.md")).as_deref(),
            Some(Path::new("repo/good/SKILL.md"))
        );
        assert_eq!(
            safe_import_subpath("dist/claude/skills").map(PathBuf::from),
            Some(PathBuf::from("dist/claude/skills"))
        );
        assert_eq!(safe_import_subpath("../../etc"), None);
        assert_eq!(safe_import_subpath("foo/../../../etc"), None);
    }

    #[test]
    fn test_unpack_tarball_without_subpath_keeps_readme() {
        let bytes = gzip_tar(&[
            ("repo/README.md", b"keep"),
            ("repo/skills/good/SKILL.md", b"# Good\n"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        unpack_tarball(&bytes, tmp.path(), None).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("repo/README.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn test_unpack_tarball_keeps_skill_subpath_and_skips_noise() {
        let bytes = gzip_tar(&[
            ("repo/README.md", b"ignore me"),
            ("repo/node_modules/x/very-long-file.txt", b"noise"),
            (
                "repo/dist/claude/skills/paper-spine-intake/SKILL.md",
                b"# Skill\n",
            ),
            (
                "repo/dist/claude/skills/paper-spine-intake/notes.md",
                b"notes",
            ),
            (
                "repo/dist/claude/commands/paperspine.md",
                b"---\ndescription: Start PaperSpine\n---\n/paperspine\n",
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        unpack_tarball(&bytes, tmp.path(), Some("dist/claude/skills")).unwrap();
        let skill = tmp
            .path()
            .join("repo")
            .join("dist/claude/skills/paper-spine-intake/SKILL.md");
        assert_eq!(std::fs::read_to_string(skill).unwrap(), "# Skill\n");
        assert_eq!(
            std::fs::read_to_string(
                tmp.path()
                    .join("repo")
                    .join("dist/claude/commands/paperspine.md")
            )
            .unwrap(),
            "---\ndescription: Start PaperSpine\n---\n/paperspine\n"
        );
        assert!(!tmp.path().join("repo").join("README.md").exists());
        assert!(!tmp.path().join("repo").join("node_modules").exists());
    }

    #[test]
    fn test_unpack_real_paperspine_tarball_if_present() {
        let archive = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/paperspine-main.tar.gz");
        if !archive.is_file() {
            return;
        }
        let bytes = std::fs::read(&archive).expect("read PaperSpine tarball");
        let tmp = tempfile::tempdir().unwrap();
        unpack_tarball(&bytes, tmp.path(), Some("dist/claude/skills"))
            .expect("unpack PaperSpine skill subpath");
        assert!(
            tmp.path()
                .join("repo/dist/claude/skills/paper-spine/SKILL.md")
                .is_file(),
            "expected paper-spine SKILL.md after filtered extract"
        );
        assert!(
            tmp.path()
                .join("repo/dist/claude/commands/paperspine.md")
                .is_file(),
            "expected official /paperspine command after sibling extract"
        );
        assert!(
            !tmp.path().join("repo/website").exists(),
            "website assets should not be extracted"
        );
    }

    #[test]
    fn test_skills_dir_global() {
        let temp = tempfile::tempdir().unwrap();
        let dir = skills_dir_with_home(Some(temp.path()), None).unwrap();
        assert_eq!(dir, temp.path().join("claude-home").join("skills"));
    }

    #[test]
    fn test_skills_dir_project() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("my-project");
        let project_string = project.to_string_lossy().to_string();
        let dir = skills_dir_with_home(None, Some(&project_string)).unwrap();
        assert_eq!(dir, project.join(".localprism").join("skills"));
    }

    #[test]
    fn test_skills_dir_global_does_not_fall_back_to_current_directory() {
        let error = skills_dir_with_home(None, None).unwrap_err();
        assert!(error.contains("home directory"));
    }

    #[test]
    fn test_sanitize_skill_folder_name() {
        assert_eq!(
            sanitize_skill_folder_name("My Local Skill!"),
            "my-local-skill"
        );
        assert_eq!(
            sanitize_skill_folder_name("__Data_Skill-01__"),
            "__data_skill-01__"
        );
    }

    #[test]
    fn test_normalize_proxy_url_defaults_to_http() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:7891"),
            Some("socks5://127.0.0.1:7891".to_string())
        );
        assert_eq!(normalize_proxy_url("   "), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_windows_proxy_server_single_proxy() {
        let rules = parse_windows_proxy_server("127.0.0.1:7890");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].kind, ProxyKind::All);
        assert_eq!(rules[0].url, "http://127.0.0.1:7890");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_windows_proxy_server_per_scheme_proxy() {
        let rules = parse_windows_proxy_server(
            "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891",
        );
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].kind, ProxyKind::Http);
        assert_eq!(rules[0].url, "http://127.0.0.1:7890");
        assert_eq!(rules[1].kind, ProxyKind::Https);
        assert_eq!(rules[1].url, "http://127.0.0.1:7890");
        assert_eq!(rules[2].kind, ProxyKind::All);
        assert_eq!(rules[2].url, "socks5://127.0.0.1:7891");
    }

    #[test]
    fn test_skill_categories_count() {
        let cats = skill_categories();
        assert_eq!(cats.len(), 16);
        // Verify skill_count matches actual skills vec length
        for cat in &cats {
            assert_eq!(cat.skill_count, cat.skills.len(), "Mismatch in {}", cat.id);
        }
        let total: usize = cats.iter().map(|c| c.skill_count).sum();
        assert!(total >= 100);
    }

    #[test]
    fn test_find_skills_source_new_repo_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join("skills").join("exploratory-data-analysis");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# Exploratory Data Analysis").unwrap();

        let src = find_skills_source(tmp.path()).unwrap();
        assert_eq!(
            src.file_name().and_then(|name| name.to_str()),
            Some("skills")
        );
    }

    #[test]
    fn test_find_skills_source_legacy_repo_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp
            .path()
            .join("scientific-skills")
            .join("exploratory-data-analysis");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# Exploratory Data Analysis").unwrap();

        let src = find_skills_source(tmp.path()).unwrap();
        assert_eq!(
            src.file_name().and_then(|name| name.to_str()),
            Some("scientific-skills")
        );
    }

    #[test]
    fn test_parse_skill_md() {
        let tmp = std::env::temp_dir().join("test-skill-parse");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let skill_content = "# RNA-seq Analysis\n\nComprehensive RNA-seq data analysis pipeline.\n\n## Usage\nUse this skill for RNA sequencing workflows.\n";
        std::fs::write(tmp.join("SKILL.md"), skill_content).unwrap();

        let info = parse_skill_md(&tmp).unwrap();
        assert_eq!(info.name, "RNA-seq Analysis");
        assert!(info.description.contains("RNA-seq"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_skills_skips_existing_skill_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let target = tmp.path().join("target");
        let src_skill = repo.join("skills").join("scanpy");
        let dest_skill = target.join("scanpy");
        std::fs::create_dir_all(&src_skill).unwrap();
        std::fs::create_dir_all(&dest_skill).unwrap();
        std::fs::write(src_skill.join("SKILL.md"), "# Scanpy replacement").unwrap();
        std::fs::write(dest_skill.join("SKILL.md"), "# Scanpy original").unwrap();

        let count = copy_skills(&repo, &target).unwrap();
        assert_eq!(count, 1);
        let kept = std::fs::read_to_string(dest_skill.join("SKILL.md")).unwrap();
        assert_eq!(kept, "# Scanpy original");
    }

    #[test]
    fn skill_already_installed_detects_user_scope_copy() {
        let _guard = crate::providers::paths::lock_provider_env();
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("LOCALPRISM_HOME");
        std::env::set_var("LOCALPRISM_HOME", &home);

        let dest = home.join("claude-home").join("skills").join("writer");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(
            dest.join("SKILL.md"),
            "---\nname: writer\ndescription: Writes prose\n---\n# Writer\n",
        )
        .unwrap();

        let source = tmp.path().join("source/writer");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: writer\ndescription: Writes prose\n---\n# Writer\n",
        )
        .unwrap();

        let installed = skill_already_installed(
            &source,
            &[domain::SkillTarget {
                runtime: crate::runtime::RuntimeKind::Claude,
                scope: domain::SkillScope::User,
            }],
            None,
        );
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }
        assert!(installed);
    }
}

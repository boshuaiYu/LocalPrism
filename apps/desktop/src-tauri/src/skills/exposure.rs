use crate::skills::domain::SkillScope;
use crate::skills::paths::SessionSkillExposure;
use std::path::Path;

/// Extra skill folders forced into this turn.
///
/// The installed library stays on disk. `prepare_isolated_claude_home` also
/// lists installed academic skills. This function adds the active agent's
/// attached skills plus a `/name` the user typed, including a scientific lab
/// the user named.
pub fn exposure_for_turn(
    project_path: Option<&Path>,
    agent_id: Option<&str>,
    prompt: &str,
) -> SessionSkillExposure {
    let mut folders = Vec::new();
    if let Some(agent_id) = agent_id.map(str::trim).filter(|value| !value.is_empty()) {
        folders.extend(agent_skill_folders(project_path, agent_id));
    }
    if let Some(command) = invoked_skill_folder(prompt) {
        folders.push(command);
    }
    let agent_id = agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    SessionSkillExposure { folders, agent_id }
}

fn agent_skill_folders(project_path: Option<&Path>, agent_id: &str) -> Vec<String> {
    let Ok(slug) = crate::agents::validate_agent_slug(agent_id) else {
        return Vec::new();
    };
    let project = project_path.filter(|path| path.is_absolute());
    for scope in [SkillScope::Project, SkillScope::User] {
        if scope == SkillScope::Project && project.is_none() {
            continue;
        }
        let Ok(root) = crate::agents::claude::agents_root(scope, project) else {
            continue;
        };
        let path = root.join(format!("{slug}.md"));
        if let Ok(profile) = crate::agents::claude::parse_claude_agent(&path, scope) {
            return profile.skill_ids;
        }
    }
    Vec::new()
}

fn invoked_skill_folder(prompt: &str) -> Option<String> {
    let trimmed = crate::skills::paperspine::user_intent_from_prompt(prompt).trim();
    let rest = trimmed.strip_prefix('/')?;
    let command = rest.split(|ch: char| ch.is_whitespace()).next()?.trim();
    if command.is_empty() || crate::skills::paths::validate_skill_slug(command).is_err() {
        None
    } else {
        Some(command.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::paths::prepare_isolated_claude_home;
    use std::fs;

    fn write_skill(root: &Path, name: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("# {name}\n")).unwrap();
    }

    #[test]
    fn hello_turn_exposes_no_skills_while_the_library_stays_intact() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("lp-home");
        let project = temp.path().join("paper");
        let library = home.join("claude-home").join("skills");
        fs::create_dir_all(&project).unwrap();
        for name in [
            "nature-writing",
            "academic-paper-reviewer",
            "scanpy",
            "biopython",
            "rdkit",
            "waypoint-bio",
            "paper-humanizer",
            "paper-spine",
        ] {
            write_skill(&library, name);
        }
        for index in 0..30 {
            write_skill(&library, &format!("bulk-skill-{index}"));
        }
        let agents = home.join("claude-home").join("agents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(
            agents.join("de-ai.md"),
            "---\nname: De-AI\ndescription: Revise prose\nskills:\n  - nature-writing\n  - paper-spine\n---\nRevise.\n",
        )
        .unwrap();
        let commands = home.join("claude-home").join("commands");
        let slash = home.join("claude-home").join("slash");
        fs::create_dir_all(&commands).unwrap();
        fs::create_dir_all(&slash).unwrap();
        fs::write(commands.join("paperspine.md"), "# paperspine\n").unwrap();
        fs::write(slash.join("waypoint.md"), "# waypoint\n").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);

        let hello = crate::skills::paperspine::adapt_host_bound_skill_prompt("你好");
        let hello_exposure = exposure_for_turn(Some(&project), None, &hello);
        assert!(hello_exposure.folders.is_empty());
        let hello_runtime = prepare_isolated_claude_home(Some(&project), &hello_exposure).unwrap();
        let hello_skills = fs::read_dir(hello_runtime.join("skills"))
            .unwrap()
            .flatten()
            .count();

        let invoked = crate::skills::paperspine::adapt_host_bound_skill_prompt(
            "[Currently open file: paper.tex]\n\n/scanpy plot this",
        );
        let turn = exposure_for_turn(Some(&project), Some("de-ai"), &invoked);
        let runtime = prepare_isolated_claude_home(Some(&project), &turn).unwrap();
        let projects = runtime.join("projects");
        fs::write(projects.join("through.txt"), "ok").unwrap();

        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        assert!(hello_skills > 0, "academic skills must be listed on an ordinary turn");
        let hello_names: Vec<_> = fs::read_dir(hello_runtime.join("skills"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(hello_names.iter().any(|name| name == "nature-writing"));
        assert!(hello_names
            .iter()
            .any(|name| name == "academic-paper-reviewer"));
        assert!(hello_names.iter().any(|name| name == "paper-humanizer"));
        assert!(hello_names
            .iter()
            .any(|name| name == "scientific-agent-skills"));
        assert!(!hello_names.iter().any(|name| name.contains("paper-spine")));
        assert!(!hello_names.iter().any(|name| name == "scanpy"));
        assert!(!hello_names
            .iter()
            .any(|name| name.starts_with("bulk-skill-")));
        let catalog = fs::read_to_string(
            hello_runtime
                .join("skills")
                .join("scientific-agent-skills")
                .join("SKILL.md"),
        )
        .unwrap();
        assert!(catalog.contains("scanpy"));
        assert!(catalog.contains("waypoint-bio"));
        assert!(!catalog.contains("# bulk"));
        let nature_body = fs::read_to_string(
            hello_runtime
                .join("skills")
                .join("nature-writing")
                .join("SKILL.md"),
        )
        .unwrap();
        assert!(nature_body.contains("# nature-writing"));
        assert!(library.join("waypoint-bio").join("SKILL.md").exists());
        assert!(library.join("bulk-skill-29").join("SKILL.md").exists());
        assert!(library.join("paper-spine").join("SKILL.md").exists());
        assert_ne!(hello_runtime, home.join("claude-home"));
        assert!(hello_runtime.starts_with(home.join("claude-home").join("runtimes")));

        let exposed: Vec<_> = fs::read_dir(runtime.join("skills"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(exposed.contains(&"nature-writing".to_string()));
        assert!(exposed.contains(&"academic-paper-reviewer".to_string()));
        assert!(exposed.contains(&"scanpy".to_string()));
        assert!(!exposed.iter().any(|name| name.contains("paper-spine")));
        assert!(!exposed.iter().any(|name| name == "waypoint-bio"));
        assert!(!exposed.iter().any(|name| name.starts_with("bulk-skill-")));
        assert!(exposed.contains(&"scientific-agent-skills".to_string()));
        let runtime_agents: Vec<_> = fs::read_dir(runtime.join("agents"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(runtime_agents, vec!["de-ai.md".to_string()]);
        let hello_agents = fs::read_dir(hello_runtime.join("agents"))
            .unwrap()
            .flatten()
            .count();
        assert_eq!(hello_agents, 0);
        assert_eq!(
            fs::read_dir(hello_runtime.join("commands"))
                .unwrap()
                .flatten()
                .count(),
            0
        );
        assert_eq!(
            fs::read_dir(hello_runtime.join("slash"))
                .unwrap()
                .flatten()
                .count(),
            0
        );
        assert_eq!(
            fs::read_dir(runtime.join("commands"))
                .unwrap()
                .flatten()
                .count(),
            0
        );
        assert_eq!(
            fs::read_dir(runtime.join("slash"))
                .unwrap()
                .flatten()
                .count(),
            0
        );
        assert!(commands.join("paperspine.md").is_file());
        assert!(slash.join("waypoint.md").is_file());
        assert_eq!(
            projects.canonicalize().unwrap(),
            home.join("claude-home")
                .join("projects")
                .canonicalize()
                .unwrap()
        );
        assert!(home
            .join("claude-home")
            .join("projects")
            .join("through.txt")
            .is_file());
    }

    #[test]
    fn slash_skill_survives_later_paragraphs_and_compression_carryover() {
        let file_then_notes =
            "[Currently open file: paper.tex]\n\n/scanpy plot this\n\nKeep the axis labels.";
        let exposed = exposure_for_turn(None, None, file_then_notes);
        assert_eq!(exposed.folders, vec!["scanpy".to_string()]);

        let carryover = "Summary:\nEarlier draft.\n\n[Currently open file: paper.tex]\n\n/nature-writing revise";
        let exposed = exposure_for_turn(None, None, carryover);
        assert_eq!(exposed.folders, vec!["nature-writing".to_string()]);

        let traversal = exposure_for_turn(None, None, "/../../providers");
        assert!(traversal.folders.is_empty());

        let cited = "\
[Currently open file: paper.tex]
[Selection: @paper.tex:2:1-2:10]
[Selected text:
claim [1]
]

/scanpy plot this

See Smith [1]

more notes";
        let exposed = exposure_for_turn(None, None, cited);
        assert_eq!(exposed.folders, vec!["scanpy".to_string()]);
    }

    #[test]
    fn removing_a_runtime_does_not_delete_library_skills() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("lp-home");
        let library = home.join("claude-home").join("skills");
        write_skill(&library, "scanpy");
        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let exposure = SessionSkillExposure {
            folders: vec!["scanpy".into()],
            agent_id: None,
        };
        let runtime = prepare_isolated_claude_home(None, &exposure).unwrap();
        assert!(runtime
            .join("skills")
            .join("scanpy")
            .join("SKILL.md")
            .exists());
        crate::skills::paths::remove_runtime_dir(&runtime);
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }
        assert!(
            library.join("scanpy").join("SKILL.md").is_file(),
            "runtime cleanup deleted the library skill"
        );
        assert!(!runtime.exists());
    }
}

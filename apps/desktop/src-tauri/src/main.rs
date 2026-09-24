// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Hidden CLI mode: when invoked with `--tectonic-compile <work_dir> <main_file>`,
    // run tectonic in this subprocess and exit. This isolates tectonic's global C state
    // so that a failed compilation doesn't poison the font cache for subsequent runs.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "--bind-project-path" {
        use std::io::Read;
        let mut payload = String::new();
        let _ = std::io::stdin().read_to_string(&mut payload);
        let spec = args.get(2).map(String::as_str);
        print!(
            "{}",
            claude_prism_desktop_lib::bind_project_path_hook(spec, &payload)
        );
        std::process::exit(0);
    }
    if args.len() >= 4 && args[1] == "--tectonic-compile" {
        let work_dir = std::path::Path::new(&args[2]);
        let main_file = &args[3];
        match claude_prism_desktop_lib::tectonic_compile_subprocess(work_dir, main_file) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        }
    }

    claude_prism_desktop_lib::run()
}

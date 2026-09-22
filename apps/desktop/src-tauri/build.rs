fn main() {
    // Embed ZOTERO credentials at compile time from .env file or system env
    let _ = dotenvy::dotenv(); // load .env if present (local dev)
    for key in ["ZOTERO_CONSUMER_KEY", "ZOTERO_CONSUMER_SECRET"] {
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
    }

    // On Linux, hide statically linked ICU/HarfBuzz/FreeType/Fontconfig/expat/
    // zlib symbols from the dynamic symbol table. Exporting them makes the
    // dynamic linker interpose our copies over the system libraries that GTK,
    // Mesa, and WebKit load (segfault or "free(): invalid pointer").
    // GLib itself must not be linked statically at all; see the patched
    // tectonic_dep_support. Hiding g_* while a second GLib remains inside the
    // executable splits gtk-rs from libgtk and still crashes.
    // See: https://github.com/delibae/claude-prism/issues/100
    #[cfg(target_os = "linux")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        println!(
            "cargo:rustc-link-arg=-Wl,--version-script={}/symbols.map",
            manifest_dir
        );
        // The cdylib artifact does not define the libc copy-relocations listed
        // as global in symbols.map. Newer rustc passes --no-undefined-version,
        // which would reject that script while linking the cdylib.
        println!("cargo:rustc-link-arg=-Wl,--undefined-version");
        println!("cargo:rerun-if-changed=symbols.map");
    }

    tauri_build::build()
}

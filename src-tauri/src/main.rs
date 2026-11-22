#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "desktop")]
    mokkaui_desktop_lib::run();

    #[cfg(not(feature = "desktop"))]
    eprintln!(
        "This binary requires the 'desktop' feature. Use mokkaui-server for headless mode."
    );
}

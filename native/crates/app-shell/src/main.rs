fn main() {
    if let Err(error) = app_shell::run() {
        eprintln!("openwps native failed to start: {error}");
        std::process::exit(1);
    }
}
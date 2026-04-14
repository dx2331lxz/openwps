use std::env;
use std::path::PathBuf;

use editor_runtime::EditorRuntime;
use native_storage::{clear_autosave, load_package, recover_from_autosave, save_package, StorageError, PACKAGE_EXTENSION};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowAttributes, WindowId};

pub struct OpenWpsApp {
    runtime: EditorRuntime,
    package_path: PathBuf,
    window: Option<Window>,
}

impl OpenWpsApp {
    pub fn new() -> Self {
        let package_path = default_package_path();
        let mut runtime = load_runtime(&package_path);
        runtime.bootstrap_selection();
        Self {
            runtime,
            package_path,
            window: None,
        }
    }

    fn build_window_attributes(&self) -> WindowAttributes {
        Window::default_attributes()
            .with_title(self.runtime.window_title())
            .with_inner_size(LogicalSize::new(1180.0, 820.0))
            .with_min_inner_size(LogicalSize::new(900.0, 640.0))
    }

    fn persist_runtime(&self) {
        if let Err(error) = save_package(&self.package_path, self.runtime.document()) {
            eprintln!("failed to save native package {}: {error}", self.package_path.display());
            return;
        }

        if let Err(error) = clear_autosave(&self.package_path) {
            eprintln!("failed to clear autosave {}: {error}", self.package_path.display());
        }
    }
}

impl Default for OpenWpsApp {
    fn default() -> Self {
        Self::new()
    }
}

impl ApplicationHandler for OpenWpsApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        match event_loop.create_window(self.build_window_attributes()) {
            Ok(window) => {
                window.set_title(&format!("{} | {}", self.runtime.window_title(), self.runtime.status_line()));
                self.window = Some(window);
            }
            Err(error) => {
                eprintln!("failed to create native window: {error}");
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, window_id: WindowId, event: WindowEvent) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        if window.id() != window_id {
            return;
        }

        match event {
            WindowEvent::CloseRequested => {
                self.persist_runtime();
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                window.set_title(&format!(
                    "{} | {} | {}x{}",
                    self.runtime.window_title(),
                    self.runtime.status_line(),
                    size.width,
                    size.height
                ));
            }
            WindowEvent::RedrawRequested => {}
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(window) = self.window.as_ref() {
            window.request_redraw();
        }
    }
}

fn default_package_path() -> PathBuf {
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    root.join(".openwps-native").join(format!("workspace.{}", PACKAGE_EXTENSION))
}

fn load_runtime(package_path: &PathBuf) -> EditorRuntime {
    if let Ok(Some(bundle)) = recover_from_autosave(package_path) {
        return EditorRuntime::from_document(bundle.snapshot.document);
    }

    match load_package(package_path) {
        Ok(package) => EditorRuntime::from_document(package.document),
        Err(StorageError::InvalidPackage(_)) | Err(StorageError::Io(_)) => {
            let document = EditorRuntime::default_document();
            if let Err(error) = save_package(package_path, &document) {
                eprintln!("failed to bootstrap native package {}: {error}", package_path.display());
            }
            EditorRuntime::from_document(document)
        }
        Err(error) => {
            eprintln!("failed to load native package {}: {error}", package_path.display());
            EditorRuntime::new()
        }
    }
}

pub fn run() -> Result<(), winit::error::EventLoopError> {
    let event_loop = EventLoop::new()?;
    let mut app = OpenWpsApp::new();
    event_loop.run_app(&mut app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn creates_native_app_model() {
        let app = OpenWpsApp::new();
        assert!(app.runtime.window_title().contains("openwps Native V2"));
    }

    #[test]
    fn bootstraps_missing_native_package() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let package_path = std::env::temp_dir()
            .join("openwps-app-shell-tests")
            .join(format!("workspace-{unique}.{}", PACKAGE_EXTENSION));
        if let Some(parent) = package_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }

        let runtime = load_runtime(&package_path);
        assert!(package_path.exists());
        assert!(runtime.window_title().contains("Native Workspace"));

        if let Some(parent) = package_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}

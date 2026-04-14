use std::env;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;

use document_core::{Block, Document};
use editor_runtime::EditorRuntime;
use native_storage::{clear_autosave, load_package, recover_from_autosave, save_package, StorageError, PACKAGE_EXTENSION};
use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop, OwnedDisplayHandle};
use winit::window::{Window, WindowAttributes, WindowId};

pub struct OpenWpsApp {
    context: Context<OwnedDisplayHandle>,
    runtime: EditorRuntime,
    package_path: PathBuf,
    window: Option<Arc<Window>>,
    surface: Option<Surface<OwnedDisplayHandle, Arc<Window>>>,
}

impl OpenWpsApp {
    pub fn new(context: Context<OwnedDisplayHandle>) -> Self {
        let package_path = default_package_path();
        let mut runtime = load_runtime(&package_path);
        runtime.bootstrap_selection();
        Self {
            context,
            runtime,
            package_path,
            window: None,
            surface: None,
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

    fn redraw(&mut self) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let Some(surface) = self.surface.as_mut() else {
            return;
        };

        let size = window.inner_size();
        let Some(width) = NonZeroU32::new(size.width.max(1)) else {
            return;
        };
        let Some(height) = NonZeroU32::new(size.height.max(1)) else {
            return;
        };

        if let Err(error) = surface.resize(width, height) {
            eprintln!("failed to resize surface: {error}");
            return;
        }

        let frame = self.runtime.render_frame(size.width.max(1), size.height.max(1));
        match surface.buffer_mut() {
            Ok(mut buffer) => {
                buffer.copy_from_slice(&frame);
                if let Err(error) = buffer.present() {
                    eprintln!("failed to present frame: {error}");
                }
            }
            Err(error) => eprintln!("failed to acquire frame buffer: {error}"),
        }
    }
}

impl ApplicationHandler for OpenWpsApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        match event_loop.create_window(self.build_window_attributes()) {
            Ok(window) => {
                let window = Arc::new(window);
                window.set_title(&format!("{} | {}", self.runtime.window_title(), self.runtime.status_line()));
                match Surface::new(&self.context, window.clone()) {
                    Ok(surface) => {
                        self.surface = Some(surface);
                        self.window = Some(window);
                    }
                    Err(error) => {
                        eprintln!("failed to create native surface: {error}");
                        event_loop.exit();
                    }
                }
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
                self.redraw();
            }
            WindowEvent::RedrawRequested => self.redraw(),
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
        let (document, migrated) = migrate_bootstrap_document(bundle.snapshot.document);
        if migrated {
            let _ = save_package(package_path, &document);
            let _ = clear_autosave(package_path);
        }
        return EditorRuntime::from_document(document);
    }

    match load_package(package_path) {
        Ok(package) => {
            let (document, migrated) = migrate_bootstrap_document(package.document);
            if migrated {
                let _ = save_package(package_path, &document);
            }
            EditorRuntime::from_document(document)
        }
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

fn migrate_bootstrap_document(document: Document) -> (Document, bool) {
    if is_legacy_bootstrap_document(&document) {
        let mut migrated = EditorRuntime::default_document();
        migrated.revision_counter = document.revision_counter;
        return (migrated, true);
    }

    (document, false)
}

fn is_legacy_bootstrap_document(document: &Document) -> bool {
    let title_matches = matches!(document.metadata.title.as_deref(), Some("Native Workspace"));
    let first_paragraph = document
        .sections
        .first()
        .and_then(|section| section.blocks.first())
        .and_then(|block| match block {
            Block::Paragraph(paragraph) => Some(paragraph.plain_text()),
            _ => None,
        })
        .unwrap_or_default();

    title_matches
        || first_paragraph.contains("openwps Native V2 已启动")
        || first_paragraph.contains("layout-engine 与 renderer-skia")
}

pub fn run() -> Result<(), winit::error::EventLoopError> {
    let event_loop = EventLoop::new()?;
    let context = Context::new(event_loop.owned_display_handle()).expect("softbuffer context");
    let mut app = OpenWpsApp::new(context);
    event_loop.run_app(&mut app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn creates_native_app_model() {
        let runtime = EditorRuntime::new();
        assert!(runtime.window_title().contains("openwps 原生版 V2"));
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
        assert!(runtime.window_title().contains("原生工作区"));

        if let Some(parent) = package_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn migrates_legacy_bootstrap_document() {
        let mut legacy = Document::new();
        legacy.metadata.title = Some("Native Workspace".to_string());
        if let Some(Block::Paragraph(paragraph)) = legacy.sections[0].blocks.first_mut() {
            *paragraph = document_core::Paragraph::with_text(
                "openwps Native V2 已启动。下一步接入 layout-engine 与 renderer-skia。",
            );
        }

        let (migrated, changed) = migrate_bootstrap_document(legacy);
        assert!(changed);
        assert_eq!(migrated.metadata.title.as_deref(), Some("原生工作区"));
        assert_eq!(migrated.sections[0].blocks.len(), 5);
    }
}

use editor_runtime::EditorRuntime;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowAttributes, WindowId};

pub struct OpenWpsApp {
    runtime: EditorRuntime,
    window: Option<Window>,
}

impl OpenWpsApp {
    pub fn new() -> Self {
        let mut runtime = EditorRuntime::new();
        runtime.bootstrap_selection();
        Self {
            runtime,
            window: None,
        }
    }

    fn build_window_attributes(&self) -> WindowAttributes {
        Window::default_attributes()
            .with_title(self.runtime.window_title())
            .with_inner_size(LogicalSize::new(1180.0, 820.0))
            .with_min_inner_size(LogicalSize::new(900.0, 640.0))
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
            WindowEvent::CloseRequested => event_loop.exit(),
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

pub fn run() -> Result<(), winit::error::EventLoopError> {
    let event_loop = EventLoop::new()?;
    let mut app = OpenWpsApp::new();
    event_loop.run_app(&mut app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_native_app_model() {
        let app = OpenWpsApp::new();
        assert!(app.runtime.window_title().contains("openwps Native V2"));
    }
}

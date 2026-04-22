use std::sync::Mutex;

use crate::background::SharedBackgroundManager;
use crate::builtins::SharedBuiltinsRuntime;
use crate::mcp::SharedMcpManager;
use crate::memory_auto::SharedMemoryStore;
use crate::skills::SharedSkillRegistry;

#[derive(Debug, Default)]
pub struct AppStateInner {
    #[allow(dead_code)]
    pub is_streaming: bool,
}

pub type AppState = Mutex<AppStateInner>;

/// Bundle of shared runtime handles managed by Tauri. Keeping them on one
/// struct lets command handlers grab only what they need without chasing
/// the right `State<'_, T>` for each subsystem.
#[allow(dead_code)]
pub struct RuntimeHandles {
    pub mcp: SharedMcpManager,
    pub skills: SharedSkillRegistry,
    pub builtins: SharedBuiltinsRuntime,
    pub memory: SharedMemoryStore,
    pub background: SharedBackgroundManager,
}

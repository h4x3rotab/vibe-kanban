use std::sync::OnceLock;

pub const CHAT_HISTORY_TAIL_ENTRIES_ENV: &str = "VK_CHAT_HISTORY_TAIL_ENTRIES";

static CHAT_HISTORY_TAIL_ENTRIES: OnceLock<Option<usize>> = OnceLock::new();

pub fn chat_history_tail_entries() -> Option<usize> {
    *CHAT_HISTORY_TAIL_ENTRIES.get_or_init(|| match std::env::var(CHAT_HISTORY_TAIL_ENTRIES_ENV) {
        Ok(raw) => match raw.trim().parse::<usize>() {
            Ok(value) => Some(value),
            Err(err) => {
                tracing::warn!(
                    "Ignoring invalid {} value {:?}: {}",
                    CHAT_HISTORY_TAIL_ENTRIES_ENV,
                    raw,
                    err
                );
                None
            }
        },
        Err(_) => None,
    })
}

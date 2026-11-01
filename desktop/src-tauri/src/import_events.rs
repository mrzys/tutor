//! Best-effort invalidations for committed import records. SQLite remains the
//! source of truth; events contain no source material or model/teacher text.
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}},
};

struct Observer {
    active: AtomicBool,
    callback: Box<dyn Fn(Value) + Send + Sync>,
}
type Observers = HashMap<PathBuf, BTreeMap<u64, Arc<Observer>>>;
fn registry() -> &'static Mutex<Observers> {
    static REGISTRY: OnceLock<Mutex<Observers>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_OBSERVER: AtomicU64 = AtomicU64::new(1);
static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Own this guard for the lifetime of the window/stdio event transport. Dropping
/// it stops future deliveries; a callback already running may finish normally.
pub struct Subscription {
    directory: PathBuf,
    id: u64,
    observer: Arc<Observer>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.observer.active.store(false, Ordering::Release);
        if let Ok(mut all) = registry().lock() {
            if let Some(observers) = all.get_mut(&self.directory) {
                observers.remove(&self.id);
                if observers.is_empty() { all.remove(&self.directory); }
            }
        }
    }
}

/// Subscribe to one existing canonical application data directory. The callback
/// can be invoked by any import worker and must not assume the UI thread.
pub fn subscribe(
    directory: &Path,
    callback: impl Fn(Value) + Send + Sync + 'static,
) -> io::Result<Subscription> {
    let directory = directory.canonicalize()?;
    let id = NEXT_OBSERVER.fetch_add(1, Ordering::Relaxed);
    let observer = Arc::new(Observer { active: AtomicBool::new(true), callback: Box::new(callback) });
    registry().lock().map_err(|_| io::Error::other("Import event registry is unavailable"))?
        .entry(directory.clone()).or_default().insert(id, observer.clone());
    Ok(Subscription { directory, id, observer })
}

fn token(value: &Value, key: &str, maximum: usize) -> Option<String> {
    value[key].as_str().filter(|text| !text.is_empty() && text.len() <= maximum
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')))
        .map(str::to_owned)
}

/// Call only after the import SQLite transaction commits and its locks are
/// released. No listener, a closed transport, or a panicking observer must never
/// turn a successful write into an apparent failure. This is an invalidation,
/// not a validation receipt and not a replacement for reading persisted state.
pub fn committed(directory: &Path, record: &Value) {
    let Ok(directory) = directory.canonicalize() else { return; };
    let observers = match registry().lock() {
        Ok(all) => all.get(&directory).map(|items| items.values().cloned().collect::<Vec<_>>()),
        Err(_) => return,
    };
    let Some(observers) = observers.filter(|items| !items.is_empty()) else { return; };
    let Some(import_id) = token(record, "importId", 240) else { return; };
    let mut event = json!({
        "importId": import_id,
        "status": token(record, "status", 80).unwrap_or_default(),
        "stage": token(record, "recognitionStage", 80).unwrap_or_default(),
        "sequence": NEXT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    });
    if let Some(job_id) = token(&record["backgroundJob"], "jobId", 240) { event["jobId"] = json!(job_id); }
    if let Some(revision) = record["revision"].as_u64() { event["revision"] = json!(revision); }
    // Snapshot Arc handles above, then notify outside the registry mutex. This
    // allows a transport to subscribe/drop guards during its callback safely.
    for observer in observers {
        if observer.active.load(Ordering::Acquire)
            && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (observer.callback)(event.clone()))).is_err()
        {
            observer.active.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn record() -> Value {
        json!({"importId":"simulated-events","status":"processing","recognitionStage":"structuring",
            "revision":7,"backgroundJob":{"jobId":"simulated-job","apiKey":"private-key","payloadHash":"private-hash"},
            "student":{"name":"private-student"},"questions":[{"stem":"private-question".repeat(10000)}],
            "filename":"private-filename","modelAttempts":[{"prompt":"private-prompt"}]})
    }

    #[test]
    fn simulated_worker_events_are_directory_scoped_lightweight_and_drop_with_subscription() {
        let first = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let (send, receive) = mpsc::channel();
        let (other_send, other_receive) = mpsc::channel();
        let subscription = subscribe(first.path(), move |event| { send.send(event).unwrap(); }).unwrap();
        let _other_subscription = subscribe(other.path(), move |event| { other_send.send(event).unwrap(); }).unwrap();
        let directory = first.path().to_owned();
        std::thread::spawn(move || committed(&directory, &record())).join().unwrap();
        let event = receive.try_recv().unwrap();
        let mut keys = event.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort();
        assert_eq!(keys, ["importId", "jobId", "revision", "sequence", "stage", "status"]);
        assert_eq!(event["importId"], "simulated-events");
        assert_eq!(event["stage"], "structuring");
        assert_eq!(event["revision"], 7);
        assert!(event.to_string().len() < 300);
        assert!(!event.to_string().contains("private"));
        assert!(other_receive.try_recv().is_err());
        committed(&first.path().join("."), &record());
        assert!(receive.try_recv().unwrap()["sequence"].as_u64().unwrap() > event["sequence"].as_u64().unwrap());
        drop(subscription);
        committed(first.path(), &record());
        assert!(receive.try_recv().is_err());
    }

    #[test]
    fn simulated_notifications_allow_reentrant_subscription_without_registry_lock() {
        let directory = tempfile::tempdir().unwrap();
        let callback_directory = directory.path().to_owned();
        let (send, receive) = mpsc::channel();
        let _subscription = subscribe(directory.path(), move |_| {
            let nested = subscribe(&callback_directory, |_| {}).unwrap();
            drop(nested);
            send.send(()).unwrap();
        }).unwrap();
        committed(directory.path(), &record());
        receive.try_recv().unwrap();
    }

    #[test]
    fn simulated_observer_failure_cannot_undo_committed_sqlite_state_or_block_other_observers() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::open(directory.path(), &crate::bank::tests::seed()).unwrap();
        let _broken = subscribe(directory.path(), |_| panic!("simulated closed event transport")).unwrap();
        let (send, receive) = mpsc::channel();
        let _healthy = subscribe(directory.path(), move |event| { send.send(event).unwrap(); }).unwrap();
        let record = record();
        let transaction = store.user.unchecked_transaction().unwrap();
        store.put_document("imports", "simulated-events", &record).unwrap();
        transaction.commit().unwrap();
        committed(directory.path(), &record);
        assert_eq!(store.document("imports", "simulated-events").unwrap(), record);
        assert_eq!(receive.try_recv().unwrap()["importId"], "simulated-events");
        committed(directory.path(), &record);
        receive.try_recv().unwrap();
    }

    #[test]
    fn simulated_invalid_metadata_cannot_smuggle_free_text_into_events() {
        let directory = tempfile::tempdir().unwrap();
        let (send, receive) = mpsc::channel();
        let _subscription = subscribe(directory.path(), move |event| { send.send(event).unwrap(); }).unwrap();
        committed(directory.path(), &json!({"importId":"simulated-events","status":"private teacher prose",
            "recognitionStage":"学生备注","revision":-1,"backgroundJob":{"jobId":"private job text"}}));
        let event = receive.try_recv().unwrap();
        assert_eq!(event["status"], "");
        assert_eq!(event["stage"], "");
        assert!(event.get("revision").is_none());
        assert!(event.get("jobId").is_none());
    }
}

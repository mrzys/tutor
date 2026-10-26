//! Ephemeral per-request observations. No teacher text, credentials or persisted logs.
use std::cell::RefCell;

type Observer = Box<dyn Fn(&str, &str)>;
thread_local! {
    static OBSERVER: RefCell<Option<Observer>> = RefCell::new(None);
}

pub fn observe<T>(observer: impl Fn(&str, &str) + 'static, action: impl FnOnce() -> T) -> T {
    struct Restore(Option<Observer>);
    impl Drop for Restore {
        fn drop(&mut self) {
            OBSERVER.with(|slot| {
                slot.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(OBSERVER.with(|slot| slot.replace(Some(Box::new(observer)))));
    action()
}

pub fn emit(step: &str, status: &str) {
    crate::assembly_log::stage(step, status);
    OBSERVER.with(|slot| {
        if let Some(observer) = slot.borrow().as_ref() {
            observer(step, status);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;
    #[test]
    fn simulated_observer_is_request_local_and_restored_after_failure() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let captured = events.clone();
        observe(
            move |step, status| {
                captured
                    .borrow_mut()
                    .push((step.to_owned(), status.to_owned()))
            },
            || {
                emit("scope", "running");
                std::thread::spawn(|| emit("other-request", "running"))
                    .join()
                    .unwrap();
                let _ = std::panic::catch_unwind(|| observe(|_, _| {}, || panic!("simulated")));
                emit("scope", "completed");
            },
        );
        emit("after-request", "running");
        assert_eq!(
            *events.borrow(),
            vec![
                ("scope".into(), "running".into()),
                ("scope".into(), "completed".into())
            ]
        );
    }
}

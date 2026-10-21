//! The Keychain stores one application master key; settings contain only sealed bytes.
use crate::error::{AppError, AppResult};
use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use security_framework::os::macos::keychain::SecKeychain;
use zeroize::Zeroizing;

#[cfg(not(test))]
const SERVICE: &str = "fun.mrzys.tutor.credentials";
const ACCOUNT: &str = "settings-master-key-v1";
const HEADER: &[u8] = b"TUTOR-MAC-KEY\x01";
const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 12;
// Security.framework's errSecItemNotFound and errSecDuplicateItem.
const ITEM_NOT_FOUND: i32 = -25300;
const DUPLICATE_ITEM: i32 = -25299;

fn credential_error() -> AppError {
    AppError::new(
        "credential_error",
        "无法读取或保存本机密钥，请检查 macOS 钥匙串访问权限并重新设置。",
    )
}

trait MasterKeyStore {
    fn read(&self) -> AppResult<Option<Zeroizing<Vec<u8>>>>;
    /// Must never overwrite an existing master key, including a concurrent creation.
    fn add(&self, key: &[u8]) -> AppResult<()>;
}

struct KeychainStore<'a> {
    keychain: SecKeychain,
    service: &'a str,
}

impl<'a> KeychainStore<'a> {
    fn new(service: &'a str) -> AppResult<Self> {
        Ok(Self {
            keychain: SecKeychain::default().map_err(|_| credential_error())?,
            service,
        })
    }
}

impl MasterKeyStore for KeychainStore<'_> {
    fn read(&self) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
        match self.keychain.find_generic_password(self.service, ACCOUNT) {
            Ok((password, _)) => Ok(Some(Zeroizing::new(password.as_ref().to_vec()))),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err(credential_error()),
        }
    }

    fn add(&self, key: &[u8]) -> AppResult<()> {
        match self
            .keychain
            .add_generic_password(self.service, ACCOUNT, key)
        {
            Ok(()) => Ok(()),
            // Another process may have created it; read the winner rather than overwrite it.
            Err(error) if error.code() == DUPLICATE_ITEM => Ok(()),
            Err(_) => Err(credential_error()),
        }
    }
}

fn master_key(store: &impl MasterKeyStore, create: bool) -> AppResult<Zeroizing<Vec<u8>>> {
    let existing = store.read()?;
    let key = match existing {
        Some(key) => key,
        None if create => {
            let mut candidate = Zeroizing::new(vec![0; KEY_LENGTH]);
            SystemRandom::new()
                .fill(&mut candidate)
                .map_err(|_| credential_error())?;
            store.add(&candidate)?;
            store.read()?.ok_or_else(credential_error)?
        }
        None => return Err(credential_error()),
    };
    if key.len() != KEY_LENGTH {
        return Err(credential_error());
    }
    Ok(key)
}

fn valid_envelope(input: &[u8]) -> bool {
    input.starts_with(HEADER)
        && input.len() >= HEADER.len() + NONCE_LENGTH + aead::AES_256_GCM.tag_len()
}

fn transform(input: &[u8], decrypt: bool, store: &impl MasterKeyStore) -> AppResult<Vec<u8>> {
    // Bad or foreign platform data must not create a new master key or prompt Keychain access.
    if decrypt && !valid_envelope(input) {
        return Err(credential_error());
    }
    let master = master_key(store, !decrypt)?;
    let key = LessSafeKey::new(
        UnboundKey::new(&aead::AES_256_GCM, &master).map_err(|_| credential_error())?,
    );
    if decrypt {
        let nonce =
            Nonce::try_assume_unique_for_key(&input[HEADER.len()..HEADER.len() + NONCE_LENGTH])
                .map_err(|_| credential_error())?;
        let mut plaintext = Zeroizing::new(input[HEADER.len() + NONCE_LENGTH..].to_vec());
        let opened = key
            .open_in_place(nonce, Aad::from(HEADER), &mut plaintext)
            .map_err(|_| credential_error())?;
        Ok(opened.to_vec())
    } else {
        let mut nonce = [0; NONCE_LENGTH];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| credential_error())?;
        let mut sealed = Zeroizing::new(input.to_vec());
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(HEADER),
            &mut *sealed,
        )
        .map_err(|_| credential_error())?;
        let mut result = Vec::with_capacity(HEADER.len() + NONCE_LENGTH + sealed.len());
        result.extend_from_slice(HEADER);
        result.extend_from_slice(&nonce);
        result.extend_from_slice(&sealed);
        Ok(result)
    }
}

#[cfg(not(test))]
pub(super) fn secret_bytes(input: &[u8], decrypt: bool) -> AppResult<Vec<u8>> {
    if decrypt && !valid_envelope(input) {
        return Err(credential_error());
    }
    // A debug driver can exercise real persistence without touching application credentials.
    // Release builds cannot redirect the Keychain service through process environment.
    #[cfg(all(debug_assertions, feature = "dev-tools"))]
    if let Some(service) = std::env::var_os("TUTOR_TEST_KEYCHAIN_SERVICE") {
        let service = service.to_str().ok_or_else(credential_error)?;
        let suffix = service
            .strip_prefix("fun.mrzys.tutor.credentials-test.")
            .ok_or_else(credential_error)?;
        let id = uuid::Uuid::parse_str(suffix).map_err(|_| credential_error())?;
        if id.to_string() != suffix {
            return Err(credential_error());
        }
        return transform(input, decrypt, &KeychainStore::new(service)?);
    }
    transform(input, decrypt, &KeychainStore::new(SERVICE)?)
}

#[cfg(test)]
pub(super) fn secret_bytes(input: &[u8], decrypt: bool) -> AppResult<Vec<u8>> {
    tests::TEST_KEYCHAIN_SERVICE.with(|service| match service.borrow().as_deref() {
        Some(service) => transform(input, decrypt, &KeychainStore::new(service)?),
        None => tests::TEST_STORE.with(|store| transform(input, decrypt, store)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    pub(super) struct MemoryStore {
        key: RefCell<Option<Zeroizing<Vec<u8>>>>,
        reads: Cell<usize>,
        adds: Cell<usize>,
        deny: Cell<bool>,
        concurrent_key: RefCell<Option<Zeroizing<Vec<u8>>>>,
    }

    thread_local! {
        pub(super) static TEST_STORE: MemoryStore = MemoryStore::default();
        pub(super) static TEST_KEYCHAIN_SERVICE: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    impl MasterKeyStore for MemoryStore {
        fn read(&self) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
            self.reads.set(self.reads.get() + 1);
            if self.deny.get() {
                return Err(credential_error());
            }
            Ok(self.key.borrow().clone())
        }
        fn add(&self, key: &[u8]) -> AppResult<()> {
            self.adds.set(self.adds.get() + 1);
            *self.key.borrow_mut() = Some(
                self.concurrent_key
                    .borrow_mut()
                    .take()
                    .unwrap_or_else(|| Zeroizing::new(key.to_vec())),
            );
            Ok(())
        }
    }

    #[test]
    fn sealed_settings_roundtrip_reuses_master_and_randomizes_ciphertext() {
        let store = MemoryStore::default();
        let secret = b"simulated-key-never-real";
        let first = transform(secret, false, &store).unwrap();
        let second = transform(secret, false, &store).unwrap();
        assert_ne!(first, second);
        assert!(!first.windows(secret.len()).any(|window| window == secret));
        assert_eq!(transform(&first, true, &store).unwrap(), secret);
        assert_eq!(transform(&second, true, &store).unwrap(), secret);
        assert_eq!(store.adds.get(), 1);
        let replacement = b"simulated-replacement";
        let replaced = transform(replacement, false, &store).unwrap();
        assert_eq!(transform(&replaced, true, &store).unwrap(), replacement);
        assert_eq!(store.adds.get(), 1);
    }

    #[test]
    fn damaged_foreign_or_modified_settings_fail_closed() {
        let store = MemoryStore::default();
        for input in [b"foreign-dpapi-data".as_slice(), HEADER, b""] {
            assert!(transform(input, true, &store).is_err());
        }
        assert_eq!(store.reads.get(), 0);
        let sealed = transform(b"simulated-secret", false, &store).unwrap();
        for index in [0, HEADER.len(), sealed.len() - 1] {
            let mut damaged = sealed.clone();
            damaged[index] ^= 1;
            assert!(transform(&damaged, true, &store).is_err());
        }
        let other = MemoryStore::default();
        transform(b"another-secret", false, &other).unwrap();
        assert!(transform(&sealed, true, &other).is_err());
    }

    #[test]
    fn missing_denied_or_invalid_master_is_not_replaced() {
        let original = MemoryStore::default();
        let sealed = transform(b"simulated-secret", false, &original).unwrap();
        let missing = MemoryStore::default();
        assert!(transform(&sealed, true, &missing).is_err());
        assert_eq!(missing.adds.get(), 0);
        let denied = MemoryStore::default();
        denied.deny.set(true);
        let error = transform(b"simulated-private-key", false, &denied).unwrap_err();
        assert_eq!(error.code, "credential_error");
        assert!(!error.message.contains("simulated-private-key"));
        assert_eq!(denied.adds.get(), 0);
        let invalid = MemoryStore::default();
        *invalid.key.borrow_mut() = Some(Zeroizing::new(vec![1; 5]));
        assert!(transform(b"simulated-secret", false, &invalid).is_err());
        assert_eq!(invalid.adds.get(), 0);
    }

    #[test]
    fn concurrent_master_creation_uses_existing_winner() {
        let store = MemoryStore::default();
        *store.concurrent_key.borrow_mut() = Some(Zeroizing::new(vec![7; KEY_LENGTH]));
        let sealed = transform(b"simulated-secret", false, &store).unwrap();
        assert_eq!(
            store.key.borrow().as_ref().unwrap().as_slice(),
            &[7; KEY_LENGTH]
        );
        assert_eq!(
            transform(&sealed, true, &store).unwrap(),
            b"simulated-secret"
        );
        assert_eq!(store.adds.get(), 1);
    }

    #[test]
    #[ignore = "accesses macOS Keychain using a unique test service and cleans it up"]
    fn live_keychain_roundtrip_isolated_service() {
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = security_framework::passwords::delete_generic_password(&self.0, ACCOUNT);
            }
        }
        let service = format!("fun.mrzys.tutor.credentials-test.{}", uuid::Uuid::new_v4());
        let cleanup = Cleanup(service);
        let store = KeychainStore::new(&cleanup.0).unwrap();
        assert!(store.read().unwrap().is_none());
        let sealed = transform(b"simulated-keychain-secret", false, &store).unwrap();
        let reopened = KeychainStore::new(&cleanup.0).unwrap();
        assert_eq!(
            transform(&sealed, true, &reopened).unwrap(),
            b"simulated-keychain-secret"
        );
        // A later save keeps the same master key, including an attempted duplicate creation.
        let original_master = reopened.read().unwrap().unwrap();
        reopened.add(&[8; KEY_LENGTH]).unwrap();
        assert_eq!(
            reopened.read().unwrap().unwrap().as_slice(),
            original_master.as_slice()
        );
        security_framework::passwords::delete_generic_password(&cleanup.0, ACCOUNT).unwrap();
        assert!(reopened.read().unwrap().is_none());
        assert!(transform(&sealed, true, &reopened).is_err());
        assert!(reopened.read().unwrap().is_none());
    }

    #[test]
    #[ignore = "accesses macOS Keychain using a unique test service and cleans it up"]
    fn live_model_settings_save_reopen_update_and_delete() {
        use super::super::ModelClient;
        use serde_json::json;
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                TEST_KEYCHAIN_SERVICE.with(|service| *service.borrow_mut() = None);
                let _ = security_framework::passwords::delete_generic_password(&self.0, ACCOUNT);
            }
        }
        let cleanup = Cleanup(format!(
            "fun.mrzys.tutor.credentials-test.{}",
            uuid::Uuid::new_v4()
        ));
        TEST_KEYCHAIN_SERVICE.with(|service| *service.borrow_mut() = Some(cleanup.0.clone()));
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("model-settings.json");
        // Preseed empty settings so opening cannot read the development .env.
        std::fs::write(
            &path,
            br#"{"schemaVersion":2,"revision":0,"activeProfileId":null,"profiles":[]}"#,
        )
        .unwrap();
        let mut client = ModelClient::open(directory.path()).unwrap();
        let save = |client: &mut ModelClient, key: &str| {
            client.save(&json!({"expectedRevision":client.revision,"activeProfileId":"a","profiles":[
                {"id":"a","name":"模拟 Keychain 配置","provider":"deepseek","baseUrl":"https://api.deepseek.com","model":"deepseek-flash","apiKey":key}
            ]})).unwrap()
        };
        save(&mut client, "simulated-first-key");
        let first_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!first_disk.contains("simulated-first-key"));
        assert!(
            !client
                .public_settings()
                .to_string()
                .contains("simulated-first-key")
        );
        let mut reopened = ModelClient::open(directory.path()).unwrap();
        assert_eq!(reopened.api_key, "simulated-first-key");
        save(&mut reopened, "");
        assert_eq!(
            ModelClient::open(directory.path()).unwrap().api_key,
            "simulated-first-key"
        );
        save(&mut reopened, "simulated-updated-key");
        let updated = ModelClient::open(directory.path()).unwrap();
        assert_eq!(updated.api_key, "simulated-updated-key");
        assert!(
            !std::fs::read_to_string(&path)
                .unwrap()
                .contains("simulated-updated-key")
        );
        assert!(
            !updated
                .public_settings()
                .to_string()
                .contains("simulated-updated-key")
        );
        let store = KeychainStore::new(&cleanup.0).unwrap();
        let master_before_delete = store.read().unwrap().unwrap();
        reopened
            .save(
                &json!({"expectedRevision":reopened.revision,"activeProfileId":null,"profiles":[]}),
            )
            .unwrap();
        let empty = ModelClient::open(directory.path()).unwrap();
        assert!(empty.profiles.is_empty());
        assert!(empty.api_key.is_empty());
        assert_eq!(
            store.read().unwrap().unwrap().as_slice(),
            master_before_delete.as_slice()
        );
        security_framework::passwords::delete_generic_password(&cleanup.0, ACCOUNT).unwrap();
        assert!(store.read().unwrap().is_none());
    }
}

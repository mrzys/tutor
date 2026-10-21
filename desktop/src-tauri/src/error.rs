use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
pub type AppResult<T> = Result<T, AppError>;
impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "storage_error",
            "本地文件读写失败，请检查存储目录和剩余空间。",
        )
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        if matches!(error, rusqlite::Error::SqliteFailure(ref cause, _) if matches!(cause.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
        {
            return Self::new(
                "storage_busy",
                "本地数据库正被其他操作使用，请等待当前操作结束后重试；已有记录已保留。",
            );
        }
        Self::new("storage_error", "本地数据库操作失败，已有记录已保留。")
    }
}
impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        Self::new("invalid_data", "数据格式校验失败，已有内容未修改。")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_busy_and_locked_offer_retry_without_exposing_database_details() {
        for code in [
            rusqlite::ffi::SQLITE_BUSY,
            rusqlite::ffi::SQLITE_LOCKED,
            rusqlite::ffi::SQLITE_BUSY_SNAPSHOT,
        ] {
            let error = AppError::from(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("simulated-private-path.sqlite".into()),
            ));
            assert_eq!(error.code, "storage_busy");
            assert!(error.message.contains("重试"));
            assert!(!error.message.contains("private"));
        }
        let other = AppError::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some("simulated-private-constraint".into()),
        ));
        assert_eq!(other.code, "storage_error");
        assert!(!other.message.contains("private"));
    }
}

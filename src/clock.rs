use std::time::SystemTime;

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub fn now_iso() -> String {
    let now: OffsetDateTime = SystemTime::now().into();
    now.format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn now_millis() -> i64 {
    let now: OffsetDateTime = SystemTime::now().into();
    now.unix_timestamp_nanos()
        .checked_div(1_000_000)
        .unwrap_or_default() as i64
}

use std::collections::BTreeMap;
use std::env;

pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn resolve_factory_version() -> String {
    env::var("FACTORY_BUILD_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| PACKAGE_VERSION.to_string())
}

pub fn resolve_factory_version_from_env(env: &BTreeMap<String, String>) -> String {
    env.get("FACTORY_BUILD_VERSION")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| PACKAGE_VERSION.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_build_version_when_present() {
        let mut env = BTreeMap::new();
        env.insert("FACTORY_BUILD_VERSION".to_string(), "0.2.0".to_string());

        assert_eq!(resolve_factory_version_from_env(&env), "0.2.0");
    }

    #[test]
    fn falls_back_to_package_version_for_missing_or_empty_build_version() {
        assert_eq!(
            resolve_factory_version_from_env(&BTreeMap::new()),
            PACKAGE_VERSION
        );

        let mut env = BTreeMap::new();
        env.insert("FACTORY_BUILD_VERSION".to_string(), String::new());
        assert_eq!(resolve_factory_version_from_env(&env), PACKAGE_VERSION);
    }
}

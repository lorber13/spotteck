//! Whether Spotteck can play right now and, if not, why.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Readiness {
    NeedsClientId,
    SignedOut,
    Connecting,
    PlanUnsupported,
    Ready,
    EngineError,
}

impl Readiness {
    /// Italian text for the account panel and for refused commands.
    pub fn message(&self) -> &'static str {
        match self {
            Readiness::NeedsClientId => "Inserisci il Client ID della tua app Spotify nelle Impostazioni.",
            Readiness::SignedOut => "Accedi con il tuo account Spotify Premium.",
            Readiness::Connecting => "Connessione a Spotify in corso…",
            Readiness::PlanUnsupported => "Spotteck richiede Spotify Premium.",
            Readiness::Ready => "Collegato a Spotify.",
            Readiness::EngineError => "Spotify non risponde. Riprova tra poco.",
        }
    }

    /// The state for the `product` field of the Web API's `GET /me`. Family, Duo and
    /// Student plans report `premium`; Free accounts report `free` or `open`. When the field
    /// is missing, the player endpoints answer `PREMIUM_REQUIRED` for Free accounts instead.
    pub fn from_product(product: Option<&str>) -> Readiness {
        match product.map(str::to_ascii_lowercase).as_deref() {
            Some("free") | Some("open") => Readiness::PlanUnsupported,
            _ => Readiness::Ready,
        }
    }

    /// `Ok` when playback commands may run, otherwise the message to return to the UI.
    pub fn gate(&self) -> Result<(), String> {
        match self {
            Readiness::Ready => Ok(()),
            other => Err(other.message().to_owned()),
        }
    }
}

/// Epoch counter bumped on login, logout and account switch. Async work captures the
/// current value and drops its result if the epoch moved on meanwhile.
#[derive(Debug, Default)]
pub struct Generation(AtomicU64);

impl Generation {
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }

    pub fn bump(&self) -> u64 {
        self.0.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn is_current(&self, epoch: u64) -> bool {
        self.current() == epoch
    }
}

/// Reconnect delays after a transient failure: 2 s doubling up to 60 s.
#[derive(Debug, Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    pub fn next_delay(&mut self) -> Duration {
        let secs = 2u64.saturating_mul(1 << self.failures.min(5)).min(60);
        self.failures = self.failures.saturating_add(1);
        Duration::from_secs(secs)
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans() {
        assert_eq!(Readiness::from_product(Some("premium")), Readiness::Ready);
        assert_eq!(Readiness::from_product(Some("Free")), Readiness::PlanUnsupported);
        assert_eq!(Readiness::from_product(Some("open")), Readiness::PlanUnsupported);
        // Missing field: the player endpoints still refuse Free accounts.
        assert_eq!(Readiness::from_product(None), Readiness::Ready);
    }

    #[test]
    fn gate_refuses_every_state_but_ready() {
        assert!(Readiness::Ready.gate().is_ok());
        for state in [
            Readiness::NeedsClientId,
            Readiness::SignedOut,
            Readiness::Connecting,
            Readiness::PlanUnsupported,
            Readiness::EngineError,
        ] {
            assert_eq!(state.gate().unwrap_err(), state.message());
        }
        assert_eq!(Readiness::PlanUnsupported.gate().unwrap_err(), "Spotteck richiede Spotify Premium.");
    }

    #[test]
    fn serializes_kebab_case() {
        assert_eq!(serde_json::to_string(&Readiness::PlanUnsupported).unwrap(), "\"plan-unsupported\"");
        assert_eq!(serde_json::to_string(&Readiness::NeedsClientId).unwrap(), "\"needs-client-id\"");
    }

    #[test]
    fn stale_generation_is_detected() {
        let generation = Generation::default();
        let epoch = generation.current();
        assert!(generation.is_current(epoch));
        generation.bump();
        assert!(!generation.is_current(epoch));
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let mut backoff = Backoff::default();
        let delays: Vec<u64> = (0..8).map(|_| backoff.next_delay().as_secs()).collect();
        assert_eq!(delays, [2, 4, 8, 16, 32, 60, 60, 60]);
        backoff.reset();
        assert_eq!(backoff.next_delay().as_secs(), 2);
    }
}

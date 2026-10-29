//! The Datadog inbox: active incidents, alerting monitors, Error Tracking issues and clustered
//! error logs, as the machine polls, fingerprints and triages them, split by what you do about
//! them. The twin of `slack` for Datadog: the machine classifies, the board only reads `split`
//! and `triage` and sends keys.
use crate::model::{DatadogItem, unix_secs};

/// One split per item; the machine picks it, the board only shows it. Order is the tab order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DatadogSplit {
    #[default]
    ActNow,
    Investigate,
    Watch,
    Noise,
    Snoozed,
    Done,
}

impl DatadogSplit {
    pub const ALL: [DatadogSplit; 6] = [
        DatadogSplit::ActNow,
        DatadogSplit::Investigate,
        DatadogSplit::Watch,
        DatadogSplit::Noise,
        DatadogSplit::Snoozed,
        DatadogSplit::Done,
    ];

    /// The machine's name for the split, as `DatadogItem::split` carries it.
    pub fn wire(self) -> &'static str {
        match self {
            DatadogSplit::ActNow => "act_now",
            DatadogSplit::Investigate => "investigate",
            DatadogSplit::Watch => "watch",
            DatadogSplit::Noise => "noise",
            DatadogSplit::Snoozed => "snoozed",
            DatadogSplit::Done => "done",
        }
    }

    pub fn from_wire(wire: &str) -> Option<DatadogSplit> {
        DatadogSplit::ALL.iter().copied().find(|s| s.wire() == wire)
    }

    pub fn label(self) -> &'static str {
        match self {
            DatadogSplit::ActNow => "Act now",
            DatadogSplit::Investigate => "Investigate",
            DatadogSplit::Watch => "Watch",
            DatadogSplit::Noise => "Noise",
            DatadogSplit::Snoozed => "Snoozed",
            DatadogSplit::Done => "Done",
        }
    }

    /// The header strip's label under 100 columns.
    pub fn label_narrow(self) -> &'static str {
        match self {
            DatadogSplit::ActNow => "Act",
            DatadogSplit::Investigate => "Inv",
            DatadogSplit::Watch => "Watch",
            DatadogSplit::Noise => "Noise",
            DatadogSplit::Snoozed => "Snz",
            DatadogSplit::Done => "Done",
        }
    }

    /// Still live: Snoozed and Done are put away.
    pub fn open(self) -> bool {
        !matches!(self, DatadogSplit::Snoozed | DatadogSplit::Done)
    }

    pub fn next(self) -> DatadogSplit {
        let i = DatadogSplit::ALL.iter().position(|s| *s == self).unwrap_or(0);
        DatadogSplit::ALL[(i + 1) % DatadogSplit::ALL.len()]
    }

    pub fn prev(self) -> DatadogSplit {
        let i = DatadogSplit::ALL.iter().position(|s| *s == self).unwrap_or(0);
        DatadogSplit::ALL[(i + DatadogSplit::ALL.len() - 1) % DatadogSplit::ALL.len()]
    }
}

/// Indices into `items` for `split`. The open splits go P0 first, incidents ahead of the other
/// sources (the order triage takes them in), then the most recently seen; Snoozed and Done
/// newest first.
pub fn items(all: &[DatadogItem], split: DatadogSplit) -> Vec<usize> {
    let mut found: Vec<usize> = all.iter().enumerate().filter(|(_, i)| i.split_enum() == Some(split)).map(|(i, _)| i).collect();
    let seen = |i: usize| std::cmp::Reverse(unix_secs(&all[i].last_seen).unwrap_or(0));
    if split.open() {
        found.sort_by_key(|&i| (all[i].priority_rank(), all[i].source_rank(), seen(i)));
    } else {
        found.sort_by_key(|&i| seen(i));
    }
    found
}

/// How many items sit in each split, in `DatadogSplit::ALL` order.
pub fn counts(all: &[DatadogItem]) -> [usize; 6] {
    let mut out = [0; 6];
    for item in all {
        if let Some(i) = item.split_enum().and_then(|s| DatadogSplit::ALL.iter().position(|x| *x == s)) {
            out[i] += 1;
        }
    }
    out
}

/// The open Datadog view: which split, and where the cursor is in it.
#[derive(Clone, Debug, Default)]
pub struct DatadogState {
    pub split: DatadogSplit,
    pub cursor: usize,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use crate::model::{DatadogItem, DatadogSnapshot};

    /// A realistic item as the machine sends it, every field present, nulls where the contract
    /// allows them. An `incident` is the checkout outage, anything else a log cluster on the
    /// payments worker. `triage` is `null` when `priority` is None.
    pub fn item_json(id: &str, source: &str, split: &str, priority: Option<&str>, last_seen: &str) -> String {
        let triage = match priority {
            Some(p) => format!(
                r#"{{"priority":"{p}","category":"outage","summary":"checkout 5xx since the 14:02 deploy",
                "why":"SEV-1 incident, customers impacted","suspectedCause":"the 14:02 deploy of checkout-api",
                "nextStep":"roll back checkout-api to v412","refs":[{{"kind":"deploy","ref":"checkout-api@v413"}}],
                "by":"model","triagedAt":"2026-10-28T09:01:00.000Z","overridden":false}}"#
            ),
            None => "null".to_string(),
        };
        let (title, service, count, url) = if source == "incident" {
            ("Checkout returns 500s", "checkout-api", "null", "https://app.datadoghq.com/incidents/412")
        } else {
            ("TimeoutError in payments-worker", "payments-worker", "1240", "https://app.datadoghq.com/logs?query=service%3Apayments-worker")
        };
        format!(
            r#"{{"id":"{id}","source":"{source}","title":"{title}","service":"{service}","env":"prod",
            "status":"active","severity":"SEV-1","count":{count},
            "firstSeen":"2026-10-28T08:00:00.000Z","lastSeen":"{last_seen}","url":"{url}",
            "samples":["POST /checkout 500: upstream timeout after 30s","POST /checkout 500: pool exhausted"],
            "repository":"acme/checkout","floor":"P1","triage":{triage},"split":"{split}",
            "snoozedUntil":null,"doneAt":null,"reopenedAt":null,"resolvedAt":null,"taskId":null}}"#
        )
    }

    pub fn item(id: &str, source: &str, split: &str, priority: Option<&str>, last_seen: &str) -> DatadogItem {
        serde_json::from_str(&item_json(id, source, split, priority, last_seen)).unwrap()
    }

    /// Two items: a P0 incident in Act now and a P3 log cluster in Noise. Error Tracking failed
    /// its last poll; the other sources are fine.
    pub fn snapshot_json() -> String {
        format!(
            r#"{{"items":[{},{}],"polledAt":"2026-10-28T10:00:00.000Z",
            "sources":{{"incident":{{"ok":true,"error":null,"count":1}},"monitor":{{"ok":true,"error":null,"count":0}},
                       "error_tracking":{{"ok":false,"error":"app key lacks error_tracking_read","count":0}},
                       "error_logs":{{"ok":true,"error":null,"count":1}}}},
            "triaging":false,"error":null}}"#,
            item_json("inc:412", "incident", "act_now", Some("P0"), "2026-10-28T09:55:00.000Z"),
            item_json("log:payments-worker:TimeoutError", "error_logs", "noise", Some("P3"), "2026-10-28T09:40:00.000Z"),
        )
    }

    pub fn snapshot() -> DatadogSnapshot {
        serde_json::from_str(&snapshot_json()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{item, snapshot};
    use super::*;
    use crate::model::DatadogSnapshot;

    #[test]
    fn a_snapshot_deserialises_with_every_field_and_counts_by_split() {
        let snapshot = snapshot();
        assert_eq!(snapshot.items.len(), 2);
        let incident = &snapshot.items[0];
        assert_eq!((incident.source.as_str(), incident.priority(), incident.split_enum()), ("incident", Some("P0"), Some(DatadogSplit::ActNow)));
        assert_eq!(incident.summary(), "checkout 5xx since the 14:02 deploy");
        let triage = incident.triage.as_ref().unwrap();
        assert_eq!(triage.suspected_cause.as_deref(), Some("the 14:02 deploy of checkout-api"));
        assert_eq!(triage.next_step, "roll back checkout-api to v412");
        assert_eq!(triage.refs[0].reference, "checkout-api@v413");
        assert_eq!(incident.samples.len(), 2);
        assert_eq!(incident.count, None);
        assert_eq!(incident.service.as_deref(), Some("checkout-api"));
        assert_eq!(snapshot.items[1].count, Some(1240));
        assert_eq!(snapshot.items[1].split_enum(), Some(DatadogSplit::Noise));
        assert!(!snapshot.sources["error_tracking"].ok);
        assert_eq!(snapshot.sources["error_tracking"].error.as_deref(), Some("app key lacks error_tracking_read"));
        assert_eq!(counts(&snapshot.items), [1, 0, 0, 1, 0, 0]);
        assert_eq!(items(&snapshot.items, DatadogSplit::ActNow), vec![0]);
        assert_eq!(items(&snapshot.items, DatadogSplit::Noise), vec![1]);
        assert!(items(&snapshot.items, DatadogSplit::Watch).is_empty());

        let off: DatadogSnapshot = serde_json::from_str(r#"{"items":[],"polledAt":null,"sources":{},"triaging":false,"error":"no_token"}"#).unwrap();
        assert_eq!(off.error.as_deref(), Some("no_token"));
        let mut untriaged = item("et:9f3", "error_tracking", "investigate", None, "2026-10-28T09:00:00Z");
        assert_eq!(untriaged.summary(), "TimeoutError in payments-worker", "the title until triage ran");
        untriaged.split = "nope".into();
        assert_eq!(counts(&[untriaged]), [0; 6], "an unknown split counts nowhere");
    }

    #[test]
    fn open_splits_sort_p0_first_then_incidents_then_newest_and_done_newest_first() {
        let all = vec![
            item("a", "error_logs", "act_now", Some("P0"), "2026-10-28T09:00:00Z"),
            item("b", "incident", "act_now", Some("P1"), "2026-10-28T09:30:00Z"),
            item("c", "incident", "act_now", Some("P0"), "2026-10-28T08:00:00Z"),
            item("d", "error_logs", "act_now", Some("P0"), "2026-10-28T09:50:00Z"),
            item("e", "incident", "act_now", None, "2026-10-28T09:59:00Z"),
            item("f", "incident", "done", Some("P0"), "2026-10-28T07:00:00Z"),
            item("g", "error_logs", "done", Some("P3"), "2026-10-28T09:00:00Z"),
        ];
        let ids = |ix: Vec<usize>| ix.iter().map(|&i| all[i].id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids(items(&all, DatadogSplit::ActNow)), vec!["c", "d", "a", "b", "e"], "P0 incidents, then P0 newest first, then P1, untriaged last");
        assert_eq!(ids(items(&all, DatadogSplit::Done)), vec!["g", "f"], "Done newest first");
    }

    #[test]
    fn splits_cycle_and_read_from_the_wire() {
        assert_eq!(DatadogSplit::from_wire("investigate"), Some(DatadogSplit::Investigate));
        assert_eq!(DatadogSplit::from_wire("act_now"), Some(DatadogSplit::ActNow));
        assert_eq!(DatadogSplit::from_wire("nope"), None);
        for split in DatadogSplit::ALL {
            assert_eq!(DatadogSplit::from_wire(split.wire()), Some(split));
            assert!(split.label_narrow().len() <= 6, "{split:?}");
        }
        assert_eq!(DatadogSplit::ActNow.next(), DatadogSplit::Investigate);
        assert_eq!(DatadogSplit::Done.next(), DatadogSplit::ActNow);
        assert_eq!(DatadogSplit::ActNow.prev(), DatadogSplit::Done);
        assert_eq!(DatadogSplit::ActNow.label(), "Act now");
        assert!(DatadogSplit::Watch.open() && !DatadogSplit::Snoozed.open() && !DatadogSplit::Done.open());
    }
}

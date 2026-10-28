//! The Slack inbox: everything your Activity tab shows plus the handles you watch, as the
//! machine polls and triages it, split by what you do about it. The twin of `pulls` for
//! Slack: the machine classifies, the board only reads `split` and `triage` and sends keys.
use crate::model::{SlackItem, SlackWatch, unix_secs};

/// One split per item; the machine picks it, the board only shows it. Order is the tab order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SlackSplit {
    #[default]
    NeedsReply,
    WaitingOnThem,
    Decide,
    Fyi,
    Snoozed,
    Done,
}

impl SlackSplit {
    pub const ALL: [SlackSplit; 6] = [
        SlackSplit::NeedsReply,
        SlackSplit::WaitingOnThem,
        SlackSplit::Decide,
        SlackSplit::Fyi,
        SlackSplit::Snoozed,
        SlackSplit::Done,
    ];

    /// The machine's name for the split, as `SlackItem::split` carries it.
    pub fn wire(self) -> &'static str {
        match self {
            SlackSplit::NeedsReply => "needs_reply",
            SlackSplit::WaitingOnThem => "waiting_on_them",
            SlackSplit::Decide => "decide",
            SlackSplit::Fyi => "fyi",
            SlackSplit::Snoozed => "snoozed",
            SlackSplit::Done => "done",
        }
    }

    pub fn from_wire(wire: &str) -> Option<SlackSplit> {
        SlackSplit::ALL.iter().copied().find(|s| s.wire() == wire)
    }

    pub fn label(self) -> &'static str {
        match self {
            SlackSplit::NeedsReply => "Needs reply",
            SlackSplit::WaitingOnThem => "Waiting on them",
            SlackSplit::Decide => "Decide",
            SlackSplit::Fyi => "FYI",
            SlackSplit::Snoozed => "Snoozed",
            SlackSplit::Done => "Done",
        }
    }

    /// The header strip's label under 100 columns.
    pub fn label_narrow(self) -> &'static str {
        match self {
            SlackSplit::NeedsReply => "Reply",
            SlackSplit::WaitingOnThem => "Wait",
            SlackSplit::Decide => "Decide",
            SlackSplit::Fyi => "FYI",
            SlackSplit::Snoozed => "Snz",
            SlackSplit::Done => "Done",
        }
    }

    /// The splits that count on the badge and raise a notice (for P0 and P1 items).
    pub fn needs_me(self) -> bool {
        matches!(self, SlackSplit::NeedsReply | SlackSplit::Decide)
    }

    pub fn next(self) -> SlackSplit {
        let i = SlackSplit::ALL.iter().position(|s| *s == self).unwrap_or(0);
        SlackSplit::ALL[(i + 1) % SlackSplit::ALL.len()]
    }

    pub fn prev(self) -> SlackSplit {
        let i = SlackSplit::ALL.iter().position(|s| *s == self).unwrap_or(0);
        SlackSplit::ALL[(i + SlackSplit::ALL.len() - 1) % SlackSplit::ALL.len()]
    }
}

/// Indices into `items` for `split`. Needs reply and Decide go P0 first, then oldest, so the
/// most pressing thing is on top; the other splits newest first, like Slack itself.
pub fn items(all: &[SlackItem], split: SlackSplit) -> Vec<usize> {
    let mut found: Vec<usize> = all.iter().enumerate().filter(|(_, i)| i.split_enum() == Some(split)).map(|(i, _)| i).collect();
    let at = |i: usize| unix_secs(&all[i].ts).unwrap_or(0);
    if split.needs_me() {
        found.sort_by_key(|&i| (all[i].priority_rank(), at(i)));
    } else {
        found.sort_by_key(|&i| std::cmp::Reverse(at(i)));
    }
    found
}

/// How many items sit in each split, in `SlackSplit::ALL` order.
pub fn counts(all: &[SlackItem]) -> [usize; 6] {
    let mut out = [0; 6];
    for item in all {
        if let Some(i) = item.split_enum().and_then(|s| SlackSplit::ALL.iter().position(|x| *x == s)) {
            out[i] += 1;
        }
    }
    out
}

/// What a key does to an item, in the order the actions menu lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlackKey {
    Reply,
    Task,
    Done,
    Snooze,
    Open,
    Nudge,
    Bump,
    Lower,
}

impl SlackKey {
    pub const ALL: [SlackKey; 8] = [
        SlackKey::Reply,
        SlackKey::Task,
        SlackKey::Done,
        SlackKey::Snooze,
        SlackKey::Open,
        SlackKey::Nudge,
        SlackKey::Bump,
        SlackKey::Lower,
    ];

    pub fn key(self) -> char {
        match self {
            SlackKey::Reply => 'r',
            SlackKey::Task => 't',
            SlackKey::Done => 'd',
            SlackKey::Snooze => 's',
            SlackKey::Open => 'o',
            SlackKey::Nudge => 'n',
            SlackKey::Bump => '!',
            SlackKey::Lower => '-',
        }
    }

    pub fn from_char(c: char) -> Option<SlackKey> {
        SlackKey::ALL.iter().copied().find(|k| k.key() == c)
    }

    pub fn label(self) -> &'static str {
        match self {
            SlackKey::Reply => "reply: edit the draft, ctrl+s posts it as you in the thread",
            SlackKey::Task => "ticket: a Backlog task from the message and its thread",
            SlackKey::Done => "done: clear it here; it comes back if the thread moves",
            SlackKey::Snooze => "snooze: 1h, 3h, tomorrow or Monday at 9",
            SlackKey::Open => "open: the message in Slack",
            SlackKey::Nudge => "nudge: a one-line reminder in the thread you are waiting on",
            SlackKey::Bump => "priority up one step",
            SlackKey::Lower => "priority down one step",
        }
    }

    /// The word before the colon: what the pane's key block shows.
    pub fn short(self) -> &'static str {
        self.label().split([':', ' ']).next().unwrap_or("")
    }
}

/// Why a key is off for this item, or None when it works. Settled here so a greyed key never
/// has to round-trip to learn the machine would refuse it.
pub fn blocker(item: &SlackItem, key: SlackKey) -> Option<&'static str> {
    let split = item.split_enum();
    match key {
        SlackKey::Reply | SlackKey::Open | SlackKey::Snooze => None,
        SlackKey::Task => item.task_id().is_some().then_some("already a ticket"),
        SlackKey::Done => (split == Some(SlackSplit::Done)).then_some("already done"),
        SlackKey::Nudge => (split != Some(SlackSplit::WaitingOnThem)).then_some("only while waiting on them"),
        SlackKey::Bump | SlackKey::Lower => match item.priority() {
            None => Some("not triaged yet"),
            Some("P0") if key == SlackKey::Bump => Some("already P0"),
            Some("P3") if key == SlackKey::Lower => Some("already P3"),
            _ => None,
        },
    }
}

/// The snooze picker's choices, in the order it lists them.
pub const SNOOZE_OPTIONS: [&str; 4] = ["1 hour", "3 hours", "tomorrow 9:00", "next Monday 9:00"];

/// When a snooze ends, as unix seconds: `option` indexes `SNOOZE_OPTIONS`, `offset` is the
/// local zone's seconds east of UTC so "9:00" is your 9:00.
pub fn snooze_until(option: usize, now: u64, offset: i64) -> u64 {
    const DAY: i64 = 86_400;
    match option {
        0 => now + 3600,
        1 => now + 3 * 3600,
        _ => {
            let local = now as i64 + offset;
            let today = local.div_euclid(DAY);
            // 1970-01-01 was a Thursday: (days + 4) % 7 gives 0 for Sunday, 1 for Monday.
            let weekday = (today + 4).rem_euclid(7);
            let to_monday = (8 - weekday).rem_euclid(7);
            let days_ahead = if option == 2 { 1 } else if to_monday == 0 { 7 } else { to_monday };
            ((today + days_ahead) * DAY + 9 * 3600 - offset).max(0) as u64
        }
    }
}

/// The open Watches popup: which row the cursor is on.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchesState {
    pub cursor: usize,
}

/// The open Slack view: which split, where the cursor is in it, and the Watches popup when open.
#[derive(Clone, Debug, Default)]
pub struct SlackState {
    pub split: SlackSplit,
    pub cursor: usize,
    pub watches: Option<WatchesState>,
}

/// What a watch picker query means: `@handle` a usergroup, `#name` a channel, anything else a
/// keyword. Returns the kind and the text to match.
pub fn watch_kind_of(query: &str) -> (&'static str, &str) {
    match query.chars().next() {
        Some('@') => ("usergroup", &query[1..]),
        Some('#') => ("channel", &query[1..]),
        _ => ("keyword", query),
    }
}

/// The watches column text: `P2 · in #eng, #luna-tui`, `as mention`, `P3 · FYI`.
pub fn watch_scope(watch: &SlackWatch) -> String {
    let floor = watch.priority.as_deref().map(str::to_string);
    let scope = match watch.kind.as_str() {
        "usergroup" => Some("as mention".to_string()),
        "channel" => Some("FYI".to_string()),
        "keyword" if !watch.channels.is_empty() => Some(format!("in {}", watch.channels.join(", "))),
        _ => None,
    };
    [floor, scope].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

#[cfg(test)]
pub(crate) mod fixtures {
    use crate::model::{SlackItem, SlackSnapshot, SlackWatch};

    /// A realistic item as the machine sends it, every field present, nulls where the contract
    /// allows them. `triage` is `null` when `priority` is None.
    pub fn item_json(id: &str, split: &str, priority: Option<&str>, ts: &str) -> String {
        let triage = match priority {
            Some(p) => format!(
                r#"{{"priority":"{p}","category":"blocker","expectsReply":true,"summary":"approve rollback",
                "why":"production incident; asks you for a decision","draft":"Approve the rollback, I'm on it.",
                "refs":[{{"kind":"pr","ref":"acme/app#212"}},{{"kind":"jira","ref":"INC-4411"}}],"deadline":null,
                "by":"model","triagedAt":"2026-10-28T09:01:00.000Z","overridden":false}}"#
            ),
            None => "null".to_string(),
        };
        format!(
            r#"{{"id":"{id}","kind":"mention","channel":{{"id":"C0123","name":"payments-oncall","kind":"channel"}},
            "author":{{"id":"U1","name":"marta","isBot":false}},
            "text":"@higor checkout is returning 500s since the 14:02 deploy, can you look? Rolling back needs your approval.",
            "threadTs":"1730112000.0001",
            "context":[{{"ts":"1730112000.0001","user":{{"id":"U1","name":"marta","isBot":false}},"text":"checkout is returning 500s"}},
                       {{"ts":"1730112100.0002","user":{{"id":"U2","name":"joão","isBot":false}},"text":"I can run the rollback once Higor says go"}}],
            "permalink":"https://acme.slack.com/archives/C0123/p1730112345000100","ts":"{ts}",
            "matched":["me"],"count":1,"replies":3,"youReplied":false,"seenAt":null,"doneAt":null,"snoozedUntil":null,
            "reopenedAt":null,"triage":{triage},"split":"{split}",
            "linked":{{"pr":{{"repo":"acme/app","number":212,"split":"ci_failed"}},"taskId":null}}}}"#
        )
    }

    pub fn item(id: &str, split: &str, priority: Option<&str>, ts: &str) -> SlackItem {
        serde_json::from_str(&item_json(id, split, priority, ts)).unwrap()
    }

    pub fn watch_json(id: &str, kind: &str, value: &str, label: &str, builtin: bool) -> String {
        format!(
            r#"{{"id":"{id}","kind":"{kind}","value":"{value}","label":"{label}","channels":[],"enabled":true,
            "builtin":{builtin},"priority":{},"createdAt":"2026-10-28T08:00:00.000Z"}}"#,
            if kind == "broadcast" { "\"P2\"" } else { "null" }
        )
    }

    pub fn watch(id: &str, kind: &str, value: &str, label: &str, builtin: bool) -> SlackWatch {
        serde_json::from_str(&watch_json(id, kind, value, label, builtin)).unwrap()
    }

    pub fn snapshot_json() -> String {
        format!(
            r#"{{"items":[{},{}],"watches":[{},{}],"me":{{"id":"U0","name":"higor","isBot":false}},
            "polledAt":"2026-10-28T10:00:00.000Z","error":null,"socket":"connected"}}"#,
            item_json("C0123:1730112345.0001", "needs_reply", Some("P0"), "2026-10-28T09:48:00.000Z"),
            item_json("C0123:1730100000.0001", "fyi", Some("P3"), "2026-10-28T07:00:00.000Z"),
            watch_json("w1", "usergroup", "S04ABCD", "@platform-team", false),
            watch_json("w2", "broadcast", "here", "@here", true),
        )
    }

    pub fn snapshot() -> SlackSnapshot {
        serde_json::from_str(&snapshot_json()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::item;
    use super::*;
    use crate::model::{SlackItem, priority_step};

    #[test]
    fn needs_reply_sorts_p0_first_then_oldest_and_the_rest_newest_first() {
        let all = vec![
            item("a", "needs_reply", Some("P1"), "2026-10-28T08:00:00Z"),
            item("b", "needs_reply", Some("P0"), "2026-10-28T09:00:00Z"),
            item("c", "needs_reply", Some("P1"), "2026-10-28T07:00:00Z"),
            item("d", "needs_reply", None, "2026-10-28T06:00:00Z"),
            item("e", "fyi", Some("P3"), "2026-10-28T07:00:00Z"),
            item("f", "fyi", Some("P2"), "2026-10-28T09:30:00Z"),
            item("g", "done", Some("P2"), "2026-10-28T09:30:00Z"),
        ];
        let ids = |ix: Vec<usize>| ix.iter().map(|&i| all[i].id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids(items(&all, SlackSplit::NeedsReply)), vec!["b", "c", "a", "d"], "P0, then P1 oldest first, untriaged last");
        assert_eq!(ids(items(&all, SlackSplit::Fyi)), vec!["f", "e"], "FYI newest first");
        assert_eq!(ids(items(&all, SlackSplit::Decide)), Vec::<&str>::new());
        assert_eq!(counts(&all), [4, 0, 0, 2, 0, 1]);
    }

    #[test]
    fn splits_cycle_and_read_from_the_wire() {
        assert_eq!(SlackSplit::NeedsReply.next(), SlackSplit::WaitingOnThem);
        assert_eq!(SlackSplit::Done.next(), SlackSplit::NeedsReply);
        assert_eq!(SlackSplit::NeedsReply.prev(), SlackSplit::Done);
        assert_eq!(SlackSplit::from_wire("waiting_on_them"), Some(SlackSplit::WaitingOnThem));
        assert_eq!(SlackSplit::from_wire("nope"), None);
        for split in SlackSplit::ALL {
            assert_eq!(SlackSplit::from_wire(split.wire()), Some(split));
            assert!(split.label_narrow().len() <= 6, "{split:?}");
        }
        assert!(SlackSplit::NeedsReply.needs_me() && SlackSplit::Decide.needs_me());
        assert!(!SlackSplit::Fyi.needs_me() && !SlackSplit::WaitingOnThem.needs_me() && !SlackSplit::Done.needs_me());
        assert_eq!(SlackSplit::Snoozed.label_narrow(), "Snz");
    }

    #[test]
    fn blockers_grey_the_keys_the_machine_would_refuse() {
        let keys = |i: &SlackItem| SlackKey::ALL.iter().filter(|k| blocker(i, **k).is_none()).map(|k| k.key()).collect::<String>();
        let open = item("a", "needs_reply", Some("P1"), "t");
        assert_eq!(keys(&open), "rtdso!-", "reply, ticket, done, snooze, open, both priority steps; no nudge");
        let mut linked = open.clone();
        linked.linked.task_id = Some("t1".into());
        assert_eq!(blocker(&linked, SlackKey::Task), Some("already a ticket"));
        let waiting = item("b", "waiting_on_them", Some("P2"), "t");
        assert!(blocker(&waiting, SlackKey::Nudge).is_none());
        assert_eq!(blocker(&open, SlackKey::Nudge), Some("only while waiting on them"));
        assert_eq!(blocker(&item("c", "done", Some("P2"), "t"), SlackKey::Done), Some("already done"));
        assert_eq!(blocker(&item("d", "needs_reply", Some("P0"), "t"), SlackKey::Bump), Some("already P0"));
        assert_eq!(blocker(&item("e", "fyi", Some("P3"), "t"), SlackKey::Lower), Some("already P3"));
        assert_eq!(blocker(&item("f", "fyi", None, "t"), SlackKey::Bump), Some("not triaged yet"));
        assert_eq!(SlackKey::from_char('!'), Some(SlackKey::Bump));
        assert_eq!(SlackKey::Reply.short(), "reply");
        assert_eq!(SlackKey::Bump.short(), "priority");
        assert_eq!(priority_step("P1", true), Some("P0"));
        assert_eq!(priority_step("P1", false), Some("P2"));
        assert_eq!(priority_step("P0", true), None);
        assert_eq!(priority_step("P3", false), None);
    }

    #[test]
    fn snooze_times_land_at_nine_local_tomorrow_and_next_monday() {
        // 2026-10-28 is a Wednesday; 10:00Z.
        let now = unix_secs("2026-10-28T10:00:00Z").unwrap();
        assert_eq!(snooze_until(0, now, 0), now + 3600);
        assert_eq!(snooze_until(1, now, 0), now + 3 * 3600);
        assert_eq!(snooze_until(2, now, 0), unix_secs("2026-10-29T09:00:00Z").unwrap());
        assert_eq!(snooze_until(3, now, 0), unix_secs("2026-11-02T09:00:00Z").unwrap());
        // In Lisbon (UTC+0 in winter, +1 before the clocks change) 9:00 local is 8:00Z.
        assert_eq!(snooze_until(2, now, 3600), unix_secs("2026-10-29T08:00:00Z").unwrap());
        // A Monday asks for the one after.
        let monday = unix_secs("2026-11-02T10:00:00Z").unwrap();
        assert_eq!(snooze_until(3, monday, 0), unix_secs("2026-11-09T09:00:00Z").unwrap());
        // São Paulo (UTC-3): tomorrow 9:00 local is 12:00Z.
        assert_eq!(snooze_until(2, now, -3 * 3600), unix_secs("2026-10-29T12:00:00Z").unwrap());
    }

    #[test]
    fn the_watch_picker_reads_the_kind_off_the_first_character() {
        assert_eq!(watch_kind_of("@platform"), ("usergroup", "platform"));
        assert_eq!(watch_kind_of("#eng"), ("channel", "eng"));
        assert_eq!(watch_kind_of("luna-tui"), ("keyword", "luna-tui"));
        let group = super::fixtures::watch("w1", "usergroup", "S04", "@platform-team", false);
        assert_eq!(watch_scope(&group), "as mention");
        let here = super::fixtures::watch("w2", "broadcast", "here", "@here", true);
        assert_eq!(watch_scope(&here), "P2");
        let mut word = super::fixtures::watch("w3", "keyword", "luna-tui", "luna-tui", false);
        word.channels = vec!["#eng".into(), "#luna-tui".into()];
        word.priority = Some("P2".into());
        assert_eq!(watch_scope(&word), "P2 · in #eng, #luna-tui");
    }
}

//! The Memory view: what the company brain learns from finished work enters as a claim, one statement with the exact
//! quote it rests on. Jev judges each claim and the person decides the ones that wait; once the shadow period has
//! shown enough, Jev decides alone and the person can undo it later. The machine sends the claims
//! (`GET /brain/claims`), the week's digest (`GET /brain/digest`) and takes the two decisions; the board only shows
//! them, so every text is a model's or a person's and goes through `sanitize` before it reaches the terminal.

use serde::Deserialize;

use crate::text::{ellipsis, sanitize, wrap};

/// Where a claim came from: `card` or `note`, and its title.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Source {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
}

/// One claim of `GET /brain/claims`. Only the three fields every claim has are required: a machine may leave the rest out
/// or add more.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub id: String,
    pub statement: String,
    pub status: String,
    #[serde(default)]
    pub quote: String,
    /// `fact`, `pattern`, `decision` or `risk`.
    #[serde(default)]
    pub kind: String,
    /// `repo` or `org`.
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub source: Option<Source>,
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default)]
    pub speaker_trust: Option<String>,
    #[serde(default)]
    pub extractor: Option<String>,
    /// Why the code checks refused a `refused` claim.
    #[serde(default)]
    pub refusal: Option<String>,
    /// `low`, `medium` or `high`; none when Jev did not run.
    #[serde(default)]
    pub tier: Option<String>,
    /// What Jev's answer and the code rules come to: `verify`, `flag`, `ask` or `reject`; none when Jev did not run.
    #[serde(default)]
    pub proposed: Option<String>,
    /// The code rules that make the claim the person's.
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decided_at: Option<String>,
}

/// How often Jev and the person agreed: `waiting` claims wait on the person; of the `decided` ones Jev gave a verdict on, the
/// person `agreed` with it that many times; `missed` counts those Jev would have verified and the person rejected. `ready`
/// says the shadow period has shown enough for this repository to let Jev decide alone; an older machine does not send it.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct Stats {
    #[serde(default)]
    pub waiting: u64,
    #[serde(default)]
    pub decided: u64,
    #[serde(default)]
    pub agreed: u64,
    #[serde(default)]
    pub missed: u64,
    #[serde(default)]
    pub ready: bool,
}

impl Stats {
    pub fn header(&self) -> String {
        format!(
            "Memory · {} waiting · Jev agreed with you on {} of {}",
            self.waiting, self.agreed, self.decided
        )
    }

    /// The good news after the header, once the shadow period has shown enough.
    pub fn ready_text(&self) -> Option<&'static str> {
        self.ready.then_some("· the shadow bar is met")
    }

    /// The warning after the header, when Jev would have verified something the person rejected.
    pub fn missed_text(&self) -> Option<String> {
        (self.missed > 0)
            .then(|| format!("· {} it would have verified and you rejected", self.missed))
    }
}

/// The body of `GET /brain/claims`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ClaimList {
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub stats: Stats,
}

/// Why a decision failed: the machine's error code beside its message. `not_waiting` (409) says somebody decided it first.
#[derive(Clone, Debug, PartialEq)]
pub struct DecideError {
    pub code: String,
    pub message: String,
}

impl DecideError {
    pub fn not_waiting(&self) -> bool {
        self.code == "not_waiting"
    }
}

impl std::fmt::Display for DecideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Which claims the view shows; the order is the order `h` and `l` cycle in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Status {
    /// Waiting on the person.
    #[default]
    Unverified,
    Verified,
    Rejected,
    Refused,
    /// "Since last week": not a status of a claim but the digest of what Jev did alone.
    Week,
}

impl Status {
    const ALL: [Status; 5] = [
        Status::Unverified,
        Status::Verified,
        Status::Rejected,
        Status::Refused,
        Status::Week,
    ];

    /// The word the machine's query takes; the digest page is fetched from its own route and never sends it.
    pub fn wire(self) -> &'static str {
        match self {
            Status::Unverified => "unverified",
            Status::Verified => "verified",
            Status::Rejected => "rejected",
            Status::Refused => "refused",
            Status::Week => "digest",
        }
    }

    /// The word on screen: an unverified claim is one that waits.
    pub fn label(self) -> &'static str {
        match self {
            Status::Unverified => "Waiting",
            Status::Verified => "Verified",
            Status::Rejected => "Rejected",
            Status::Refused => "Refused",
            Status::Week => "Since last week",
        }
    }

    pub fn empty_text(self) -> String {
        match self {
            Status::Unverified => "Nothing waits on you.".to_string(),
            other => format!("No {} claim.", other.wire()),
        }
    }

    pub fn next(self) -> Status {
        let i = Status::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Status::ALL[(i + 1) % Status::ALL.len()]
    }

    pub fn prev(self) -> Status {
        let i = Status::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Status::ALL[(i + Status::ALL.len() - 1) % Status::ALL.len()]
    }
}

/// The decision a key would send: which claim, which way, and whether it undoes an earlier decision (so it asks first).
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub id: String,
    /// The statement on one line, for the confirm.
    pub statement: String,
    pub verify: bool,
    pub undoes: bool,
}

/// The open Memory view: the claims of the shown status as the machine last sent them (or the week's digest on the last page),
/// and where the person is in them.
#[derive(Clone, Debug, Default)]
pub struct MemoryState {
    pub status: Status,
    pub claims: Vec<Claim>,
    /// The digest of the `Week` page; empty on the others.
    pub digest: Digest,
    pub stats: Stats,
    /// False until the first answer for the shown status: an empty list is not "nothing waits" before then.
    pub loaded: bool,
    pub cursor: usize,
    /// The claim a call is out for; a key on another claim waits for it.
    pub pending: Option<String>,
    /// Why the last fetch failed, until one succeeds.
    pub error: Option<String>,
}

impl MemoryState {
    /// How many rows the shown page has.
    pub fn len(&self) -> usize {
        match self.status {
            Status::Week => self.digest.len(),
            _ => self.claims.len(),
        }
    }

    fn at(&self) -> usize {
        self.cursor.min(self.len().saturating_sub(1))
    }

    /// The selected claim: a row of a list, or a claim row of the digest.
    pub fn selected(&self) -> Option<&Claim> {
        match self.status {
            Status::Week => self.selected_row().and_then(|row| row.claim()),
            _ => self.claims.get(self.at()),
        }
    }

    /// The selected row of the digest page.
    pub fn selected_row(&self) -> Option<Row<'_>> {
        self.digest.rows().into_iter().nth(self.at())
    }

    /// What `a` (`verify`) or `x` would send for the selected claim, while no call is out. A waiting claim is decided at once;
    /// a verified one can only be rejected and a rejected one only verified, which undoes a decision and so asks first. A
    /// refused claim, a lesson and a contested pair take neither.
    pub fn decision(&self, verify: bool) -> Option<Decision> {
        if self.pending.is_some() {
            return None;
        }
        let claim = self.selected()?;
        let undoes = match (self.status, claim.status.as_str()) {
            (Status::Unverified, "unverified") => false,
            (Status::Unverified | Status::Refused, _) => return None,
            (_, "verified") if !verify => true,
            (_, "rejected") if verify => true,
            _ => return None,
        };
        Some(Decision {
            id: claim.id.clone(),
            statement: flat(&claim.statement),
            verify,
            undoes,
        })
    }

    /// Shows another status: the rows of the last one go, so a key can never act on them.
    pub fn show(&mut self, status: Status) {
        self.status = status;
        self.claims.clear();
        self.digest = Digest::default();
        self.loaded = false;
        self.cursor = 0;
        self.error = None;
    }

    /// The machine's list for the shown status, with the cursor kept inside it.
    pub fn take(&mut self, list: ClaimList) {
        self.claims = list.claims;
        self.stats = list.stats;
        self.loaded = true;
        self.error = None;
        self.cursor = self.cursor.min(self.claims.len().saturating_sub(1));
    }

    /// The machine's digest, with the cursor kept inside it.
    pub fn take_digest(&mut self, digest: Digest) {
        self.digest = digest;
        self.loaded = true;
        self.error = None;
        self.cursor = self.cursor.min(self.len().saturating_sub(1));
    }

    /// The claim `id` was decided: it leaves the list now, and the cursor stays where it was, on the row that followed it.
    pub fn decided(&mut self, id: &str) {
        self.pending = None;
        self.claims.retain(|c| c.id != id);
        self.digest.verified.retain(|c| c.id != id);
        self.digest.rejected.retain(|c| c.id != id);
        self.cursor = self.cursor.min(self.len().saturating_sub(1));
    }

    /// The title of the pane beside the rows.
    pub fn detail_title(&self) -> &'static str {
        self.selected_row().map_or("Claim", |row| row.title())
    }

    /// The detail of the selected row, wrapped to `width`; none when nothing is selected.
    pub fn detail_lines(&self, width: usize) -> Option<Vec<(Tone, String)>> {
        match self.status {
            Status::Week => self.selected_row().map(|row| row.detail_lines(width)),
            _ => self.selected().map(|claim| claim.detail_lines(width)),
        }
    }
}

/// A lesson that rests on a claim rejected since: agents no longer read it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct AtRisk {
    #[serde(default)]
    pub learning: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub claim: String,
}

/// Two claims that say opposite things, neither rejected.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Contested {
    #[serde(default)]
    pub claim: String,
    #[serde(default)]
    pub says: String,
    #[serde(default)]
    pub contradicts: String,
    #[serde(default)]
    pub against: String,
}

/// The body of `GET /brain/digest`: what Jev decided alone since `since`, the lessons it put at risk and the claims that
/// contradict each other.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    #[serde(default)]
    pub since: String,
    /// What Jev verified alone, flagged ones first.
    #[serde(default)]
    pub verified: Vec<Claim>,
    #[serde(default)]
    pub rejected: Vec<Claim>,
    #[serde(default)]
    pub at_risk: Vec<AtRisk>,
    #[serde(default)]
    pub contested: Vec<Contested>,
}

/// One row of the digest page.
#[derive(Clone, Copy, Debug)]
pub enum Row<'a> {
    Verified(&'a Claim),
    Rejected(&'a Claim),
    AtRisk(&'a AtRisk),
    Contested(&'a Contested),
}

/// One display line of the digest page: a section title, the "none" of an empty section, or the row at that index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Title(String),
    None,
    Row(usize),
}

impl Digest {
    /// How many of what Jev verified alone it flagged.
    pub fn flagged(&self) -> usize {
        self.verified.iter().filter(|c| c.is_flagged()).count()
    }

    pub fn len(&self) -> usize {
        self.verified.len() + self.rejected.len() + self.at_risk.len() + self.contested.len()
    }

    /// Every row of every section as one list, the order the selection moves in.
    pub fn rows(&self) -> Vec<Row<'_>> {
        let mut rows = Vec::with_capacity(self.len());
        rows.extend(self.verified.iter().map(Row::Verified));
        rows.extend(self.rejected.iter().map(Row::Rejected));
        rows.extend(self.at_risk.iter().map(Row::AtRisk));
        rows.extend(self.contested.iter().map(Row::Contested));
        rows
    }

    /// The page top to bottom: each section's title with its count, then its rows or a "none".
    pub fn layout(&self) -> Vec<Entry> {
        let flagged = self.flagged();
        let sections = [
            (
                if flagged > 0 {
                    format!(
                        "Jev verified alone · {} · {flagged} flagged",
                        self.verified.len()
                    )
                } else {
                    format!("Jev verified alone · {}", self.verified.len())
                },
                self.verified.len(),
            ),
            (
                format!("Jev rejected alone · {}", self.rejected.len()),
                self.rejected.len(),
            ),
            (
                format!("Lessons at risk · {}", self.at_risk.len()),
                self.at_risk.len(),
            ),
            (
                format!("Contested claims · {}", self.contested.len()),
                self.contested.len(),
            ),
        ];
        let mut out = Vec::new();
        let mut next = 0;
        for (title, count) in sections {
            out.push(Entry::Title(title));
            if count == 0 {
                out.push(Entry::None);
            }
            out.extend((next..next + count).map(Entry::Row));
            next += count;
        }
        out
    }
}

impl<'a> Row<'a> {
    /// The claim of a claim row.
    pub fn claim(&self) -> Option<&'a Claim> {
        match self {
            Row::Verified(c) | Row::Rejected(c) => Some(c),
            Row::AtRisk(_) | Row::Contested(_) => None,
        }
    }

    /// The title of the pane for this row.
    pub fn title(&self) -> &'static str {
        match self {
            Row::Verified(_) | Row::Rejected(_) => "Claim",
            Row::AtRisk(_) => "Lesson",
            Row::Contested(_) => "Contested",
        }
    }

    /// A lesson's title, or a pair's two statements, on one line cut to `width` cells. A claim row is drawn by the screen
    /// with the columns of the lists, so this is its statement.
    pub fn row_text(&self, width: usize) -> String {
        match self {
            Row::Verified(c) | Row::Rejected(c) => c.row_text(width),
            Row::AtRisk(l) => ellipsis(&flat(&l.title), width),
            Row::Contested(p) => ellipsis(
                &format!("{} · against: {}", flat(&p.says), flat(&p.against)),
                width,
            ),
        }
    }

    pub fn detail_lines(&self, width: usize) -> Vec<(Tone, String)> {
        match self {
            Row::Verified(c) | Row::Rejected(c) => c.detail_lines(width),
            Row::AtRisk(l) => {
                let mut out = Vec::new();
                put(&mut out, Tone::Plain, &l.title, "", width);
                out.push((Tone::Plain, String::new()));
                put(
                    &mut out,
                    Tone::Plain,
                    "The claim it rests on was rejected. Agents no longer read this lesson.",
                    "",
                    width,
                );
                out
            }
            Row::Contested(p) => {
                let mut out = Vec::new();
                put(&mut out, Tone::Dim, "says", "", width);
                put(&mut out, Tone::Plain, &p.says, "  ", width);
                put(&mut out, Tone::Dim, "against", "", width);
                put(&mut out, Tone::Plain, &p.against, "  ", width);
                out.push((Tone::Plain, String::new()));
                put(
                    &mut out,
                    Tone::Plain,
                    "Reject one of the two to settle it.",
                    "",
                    width,
                );
                out
            }
        }
    }
}

/// What a line of the detail is, for the colour the screen gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Plain,
    Quote,
    Dim,
    /// What makes the claim the person's.
    Reason,
    Refusal,
}

/// `text` as one run: every control character a space, so a newline too.
fn flat(text: &str) -> String {
    sanitize(text, false)
}

/// Wraps `text` to `width` cells with `prefix` before every line, and appends the lines to `out`.
fn put(out: &mut Vec<(Tone, String)>, tone: Tone, text: &str, prefix: &str, width: usize) {
    let room = width.saturating_sub(prefix.chars().count());
    for line in wrap(&flat(text), room, 0) {
        out.push((tone, format!("{prefix}{line}")));
    }
}

impl Claim {
    /// `low`, `medium` or `high`; a dash when Jev did not run, or the machine sent a word the board does not know.
    pub fn tier_label(&self) -> &'static str {
        match self.tier.as_deref() {
            Some("low") => "low",
            Some("medium") => "medium",
            Some("high") => "high",
            _ => "–",
        }
    }

    /// Jev's verdict as the word on screen; a dash when Jev did not run.
    pub fn verdict(&self) -> &'static str {
        match self.proposed.as_deref() {
            Some("verify") => "verify",
            Some("flag") => "flag",
            Some("ask") => "ask",
            Some("reject") => "reject",
            _ => "–",
        }
    }

    /// Who decided it: `jev` or `you`, a dash for the code rules, nobody or a word the board does not know.
    pub fn who(&self) -> &'static str {
        match self.decided_by.as_deref() {
            Some("jev") => "jev",
            Some("person") => "you",
            _ => "–",
        }
    }

    /// Jev verified it alone, but was not fully sure.
    pub fn is_flagged(&self) -> bool {
        self.status == "verified"
            && self.decided_by.as_deref() == Some("jev")
            && self.proposed.as_deref() == Some("flag")
    }

    /// A decided claim: verified or rejected.
    pub fn is_decided(&self) -> bool {
        matches!(self.status.as_str(), "verified" | "rejected")
    }

    /// Who verified or rejected it, in words; none for a claim nobody decided, or one the code rules decided.
    pub fn decision_note(&self) -> Option<String> {
        let verb = match self.status.as_str() {
            "verified" => "verified",
            "rejected" => "rejected",
            _ => return None,
        };
        match self.decided_by.as_deref() {
            Some("jev") if self.is_flagged() => {
                Some(format!("Jev {verb} this alone and flagged it."))
            }
            Some("jev") => Some(format!("Jev {verb} this alone.")),
            Some("person") => Some(format!("You {verb} this.")),
            _ => None,
        }
    }

    /// The statement on one line, cut to `width` cells.
    pub fn row_text(&self, width: usize) -> String {
        ellipsis(&flat(&self.statement), width)
    }

    /// The detail: the statement, the quote it rests on, why it waits or was refused, then where it came from and who said it.
    pub fn detail_lines(&self, width: usize) -> Vec<(Tone, String)> {
        let mut out = Vec::new();
        put(&mut out, Tone::Plain, &self.statement, "", width);
        if !self.quote.trim().is_empty() {
            out.push((Tone::Plain, String::new()));
            put(&mut out, Tone::Quote, &self.quote, "│ ", width);
        }
        if let Some(note) = self.decision_note() {
            out.push((Tone::Plain, String::new()));
            let tone = if self.is_flagged() {
                Tone::Reason
            } else {
                Tone::Plain
            };
            put(&mut out, tone, &note, "", width);
        }
        if let Some(refusal) = self.refusal.as_deref().filter(|r| !r.trim().is_empty()) {
            out.push((Tone::Plain, String::new()));
            put(
                &mut out,
                Tone::Refusal,
                &format!("refused: {refusal}"),
                "",
                width,
            );
        }
        if !self.reasons.is_empty() {
            out.push((Tone::Plain, String::new()));
            put(&mut out, Tone::Reason, "waits on you because", "", width);
            for reason in &self.reasons {
                let room = width.saturating_sub(4);
                for (i, line) in wrap(&flat(reason), room, 0).into_iter().enumerate() {
                    let lead = if i == 0 { "  · " } else { "    " };
                    out.push((Tone::Reason, format!("{lead}{line}")));
                }
            }
        }
        let mut facts: Vec<String> = Vec::new();
        if let Some(source) = &self.source {
            facts.push(format!("source: {} · {}", source.kind, source.title));
        }
        let place: Vec<&str> = [self.kind.as_str(), self.scope.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
        if !place.is_empty() {
            facts.push(place.join(" · "));
        }
        let trust = self
            .speaker_trust
            .as_deref()
            .map(|t| format!(" · {t}"))
            .unwrap_or_default();
        if let Some(extractor) = &self.extractor {
            let trust = if self.speaker.is_none() { &trust } else { "" };
            facts.push(format!("extracted by {extractor}{trust}"));
        }
        if let Some(speaker) = &self.speaker {
            facts.push(format!("said by {speaker}{trust}"));
        }
        if let Some(by) = &self.decided_by {
            let at = self
                .decided_at
                .as_deref()
                .map(|a| format!(" · {a}"))
                .unwrap_or_default();
            facts.push(format!("decided by {by}{at}"));
        }
        if !facts.is_empty() {
            out.push((Tone::Plain, String::new()));
        }
        for fact in facts {
            put(&mut out, Tone::Dim, &fact, "", width);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const FULL: &str = r#"{
      "claims": [{
        "id": "0b9c6f1e-0000", "repo": "luna-tui-1a2b3c4d", "repoPath": "/Users/me/luna-tui", "taskId": "6f1c2a9e",
        "statement": "The e2e suite needs the seed command before the app starts.",
        "quote": "seed.command ran after the app was up and the login test failed",
        "kind": "fact", "scope": "repo",
        "source": { "kind": "card", "ref": "6f1c2a9e", "title": "Wire the e2e start mode" },
        "speaker": null, "speakerTrust": "machine", "extractor": "reviewing_memory",
        "status": "unverified", "refusal": null,
        "tier": "low", "proposed": "verify",
        "reasons": ["applies to the whole org"], "durable": true, "contradicts": [], "recordId": "rec-1",
        "decidedBy": null, "decidedAt": null, "createdAt": "2026-11-16T12:00:00.000Z",
        "somethingNew": 7
      }],
      "stats": { "waiting": 3, "decided": 14, "agreed": 12, "missed": 1, "later": 2 }
    }"#;

    fn claim(extra: serde_json::Value) -> Claim {
        let mut json = serde_json::json!({
            "id": "c1", "statement": "Seed first.", "status": "unverified"
        });
        for (key, value) in extra.as_object().into_iter().flatten() {
            json[key] = value.clone();
        }
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn the_machines_list_is_read_and_unknown_fields_are_ignored() {
        let list: ClaimList = serde_json::from_str(FULL).unwrap();
        assert_eq!(list.claims.len(), 1);
        let c = &list.claims[0];
        assert_eq!(
            c.statement,
            "The e2e suite needs the seed command before the app starts."
        );
        assert_eq!(c.source.as_ref().map(|s| s.kind.as_str()), Some("card"));
        assert_eq!(c.speaker, None);
        assert_eq!(c.reasons, vec!["applies to the whole org"]);
        assert_eq!(
            list.stats,
            Stats {
                waiting: 3,
                decided: 14,
                agreed: 12,
                missed: 1,
                ready: false
            }
        );
    }

    #[test]
    fn a_claim_missing_its_optional_fields_still_reads() {
        let c = claim(serde_json::json!({}));
        assert_eq!((c.tier.as_deref(), c.proposed.as_deref()), (None, None));
        assert!(c.reasons.is_empty() && c.source.is_none() && c.refusal.is_none());
        let list: ClaimList = serde_json::from_str(r#"{"claims":[]}"#).unwrap();
        assert_eq!(list.stats, Stats::default());
    }

    #[test]
    fn the_status_cycles_through_the_five_pages_and_names_itself_for_the_wire_and_the_screen() {
        let all = [
            (Status::Unverified, "unverified", "Waiting"),
            (Status::Verified, "verified", "Verified"),
            (Status::Rejected, "rejected", "Rejected"),
            (Status::Refused, "refused", "Refused"),
            (Status::Week, "digest", "Since last week"),
        ];
        for (i, (status, wire, label)) in all.iter().enumerate() {
            assert_eq!((status.wire(), status.label()), (*wire, *label));
            assert_eq!(status.next(), all[(i + 1) % 5].0);
            assert_eq!(status.prev(), all[(i + 4) % 5].0);
        }
    }

    #[test]
    fn a_tier_and_a_verdict_read_as_words_and_a_dash_when_there_is_none() {
        let c = claim(serde_json::json!({"tier": "medium", "proposed": "flag"}));
        assert_eq!((c.tier_label(), c.verdict()), ("medium", "flag"));
        let none = claim(serde_json::json!({"tier": null, "proposed": null}));
        assert_eq!((none.tier_label(), none.verdict()), ("–", "–"));
        let odd = claim(serde_json::json!({"tier": "\u{1b}[31mhigh", "proposed": "maybe"}));
        assert_eq!(
            (odd.tier_label(), odd.verdict()),
            ("–", "–"),
            "a word the board does not know is not drawn"
        );
    }

    #[test]
    fn a_row_is_the_statement_on_one_line_cut_to_the_width() {
        let c = claim(serde_json::json!({"statement": "Seed\nfirst, then start the app."}));
        assert_eq!(c.row_text(80), "Seed first, then start the app.");
        assert_eq!(c.row_text(10), "Seed firs…");
        assert_eq!(c.row_text(0), "");
    }

    #[test]
    fn a_text_from_a_claim_loses_its_control_characters() {
        let c = claim(serde_json::json!({
            "statement": "Seed\u{1b}[2Jfirst\u{7}.",
            "quote": "a\u{1b}]0;title\u{7}b",
            "source": {"kind": "note", "ref": "n1", "title": "x\u{1b}[31mred"},
            "reasons": ["why\u{1b}[0m"],
            "extractor": "re\u{8}view"
        }));
        let all = format!("{}\n{}", c.row_text(200), lines_text(&c.detail_lines(80)));
        assert!(
            !all.chars().any(|ch| ch.is_control() && ch != '\n'),
            "{all:?}"
        );
    }

    fn lines_text(lines: &[(Tone, String)]) -> String {
        lines
            .iter()
            .map(|(_, l)| l.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_detail_has_the_statement_the_quote_the_source_and_who_said_it() {
        let list: ClaimList = serde_json::from_str(FULL).unwrap();
        let lines = list.claims[0].detail_lines(40);
        let text = lines_text(&lines);
        assert!(
            text.starts_with("The e2e suite needs the seed command"),
            "{text}"
        );
        assert!(
            lines.len() > 6,
            "the statement and the quote wrap at 40 cells: {text}"
        );
        assert!(lines.iter().all(|(_, l)| l.chars().count() <= 40), "{text}");
        let quoted: Vec<&str> = lines
            .iter()
            .filter(|(tone, _)| *tone == Tone::Quote)
            .map(|(_, l)| l.as_str())
            .collect();
        assert!(
            quoted.len() >= 2 && quoted.iter().all(|l| l.starts_with("│ ")),
            "{quoted:?}"
        );
        for want in [
            "source: card · Wire the e2e start mode",
            "fact · repo",
            "extracted by reviewing_memory · machine",
            "waits on you because",
            "  · applies to the whole org",
        ] {
            assert!(text.contains(want), "{want}: {text}");
        }
    }

    #[test]
    fn the_detail_names_a_speaker_each_reason_and_a_refusal_when_there_are_some() {
        let c = claim(serde_json::json!({
            "speaker": "Ana", "speakerTrust": "member",
            "reasons": ["applies to the whole org", "contradicts a verified claim"],
            "status": "refused", "refusal": "the quote is not in the source"
        }));
        let text = lines_text(&c.detail_lines(80));
        assert!(text.contains("said by Ana · member"), "{text}");
        assert!(
            text.contains("  · applies to the whole org\n  · contradicts a verified claim"),
            "{text}"
        );
        let refusal = c
            .detail_lines(80)
            .into_iter()
            .find(|(tone, _)| *tone == Tone::Refusal)
            .expect("the refusal is a line of its own");
        assert_eq!(refusal.1, "refused: the quote is not in the source");
        let plain = claim(serde_json::json!({}));
        let text = lines_text(&plain.detail_lines(80));
        assert!(
            !text.contains("waits on you because") && !text.contains("refused"),
            "{text}"
        );
    }

    #[test]
    fn a_decided_claim_says_who_decided_it() {
        let c = claim(serde_json::json!({
            "status": "verified", "decidedBy": "higor", "decidedAt": "2026-11-16T13:00:00.000Z"
        }));
        assert!(lines_text(&c.detail_lines(80)).contains("decided by higor"));
    }

    #[test]
    fn the_header_counts_what_waits_and_how_often_jev_was_right() {
        let stats = Stats {
            waiting: 3,
            decided: 14,
            agreed: 12,
            missed: 0,
            ready: false,
        };
        assert_eq!(
            stats.header(),
            "Memory · 3 waiting · Jev agreed with you on 12 of 14"
        );
        assert_eq!(stats.missed_text(), None);
        let stats = Stats { missed: 1, ..stats };
        assert_eq!(
            stats.missed_text().as_deref(),
            Some("· 1 it would have verified and you rejected")
        );
    }

    #[test]
    fn the_shadow_bar_is_read_and_a_machine_that_does_not_send_it_has_not_met_it() {
        let met: Stats = serde_json::from_str(r#"{"waiting":1,"ready":true}"#).unwrap();
        assert!(met.ready);
        assert_eq!(met.ready_text(), Some("· the shadow bar is met"));
        let not: Stats = serde_json::from_str(r#"{"waiting":1,"ready":false}"#).unwrap();
        assert_eq!(not.ready_text(), None);
        let older: Stats = serde_json::from_str(r#"{"waiting":1}"#).unwrap();
        assert!(!older.ready && older.ready_text().is_none());
        assert_eq!(
            met.header(),
            not.header(),
            "the rest of the header is the same"
        );
    }

    #[test]
    fn who_decided_reads_jev_you_or_a_dash() {
        for (by, want) in [
            (json!("jev"), "jev"),
            (json!("person"), "you"),
            (json!("code"), "–"),
            (json!(null), "–"),
            (json!("\u{1b}[31mjev"), "–"),
        ] {
            let c = claim(json!({"status": "verified", "decidedBy": by}));
            assert_eq!(c.who(), want, "{by}");
        }
    }

    #[test]
    fn only_a_claim_jev_verified_alone_with_a_flag_is_flagged() {
        let flagged = claim(json!({"status": "verified", "decidedBy": "jev", "proposed": "flag"}));
        assert!(flagged.is_flagged());
        for extra in [
            json!({"status": "verified", "decidedBy": "jev", "proposed": "verify"}),
            json!({"status": "verified", "decidedBy": "person", "proposed": "flag"}),
            json!({"status": "rejected", "decidedBy": "jev", "proposed": "flag"}),
            json!({"status": "verified", "decidedBy": "jev", "proposed": null}),
        ] {
            assert!(!claim(extra.clone()).is_flagged(), "{extra}");
        }
    }

    #[test]
    fn the_detail_says_in_words_who_decided_and_whether_jev_flagged_it() {
        let note = |extra: Value| {
            let c = claim(extra);
            c.decision_note()
        };
        assert_eq!(
            note(json!({"status": "verified", "decidedBy": "jev", "proposed": "flag"})).as_deref(),
            Some("Jev verified this alone and flagged it.")
        );
        assert_eq!(
            note(json!({"status": "verified", "decidedBy": "jev", "proposed": "verify"}))
                .as_deref(),
            Some("Jev verified this alone.")
        );
        assert_eq!(
            note(json!({"status": "rejected", "decidedBy": "jev"})).as_deref(),
            Some("Jev rejected this alone.")
        );
        assert_eq!(
            note(json!({"status": "rejected", "decidedBy": "person"})).as_deref(),
            Some("You rejected this.")
        );
        assert_eq!(
            note(json!({"status": "verified", "decidedBy": "person"})).as_deref(),
            Some("You verified this.")
        );
        assert_eq!(note(json!({"status": "unverified"})), None);
        assert_eq!(
            note(json!({"status": "verified", "decidedBy": "code"})),
            None
        );
        let flagged = claim(json!({"status": "verified", "decidedBy": "jev", "proposed": "flag"}));
        let lines = flagged.detail_lines(80);
        let (tone, _) = lines
            .iter()
            .find(|(_, l)| l == "Jev verified this alone and flagged it.")
            .expect("the note is a line of the detail");
        assert_eq!(*tone, Tone::Reason, "a flag is drawn as a warning");
    }

    const DIGEST: &str = r#"{
      "since": "2026-11-09T12:00:00.000Z",
      "verified": [
        {"id":"v1","statement":"Flagged one.","status":"verified","decidedBy":"jev","proposed":"flag"},
        {"id":"v2","statement":"Sure one.","status":"verified","decidedBy":"jev","proposed":"verify"}
      ],
      "rejected": [
        {"id":"r1","statement":"Dropped one.","status":"rejected","decidedBy":"jev","proposed":"reject"}
      ],
      "atRisk": [
        {"learning":"learning:0b9c","title":"The e2e suite needs the seed command before the app starts.","claim":"claim:0b9c"}
      ],
      "contested": [
        {"claim":"claim:7ae9","says":"The board lint may be skipped for a docs change.","contradicts":"claim:1c2d","against":"The board lint must be clean before a commit."}
      ],
      "somethingNew": 1
    }"#;

    #[test]
    fn the_digest_is_read_with_its_four_sections_and_a_missing_one_is_empty() {
        let digest: Digest = serde_json::from_str(DIGEST).unwrap();
        assert_eq!(digest.since, "2026-11-09T12:00:00.000Z");
        assert_eq!(
            (
                digest.verified.len(),
                digest.rejected.len(),
                digest.at_risk.len(),
                digest.contested.len()
            ),
            (2, 1, 1, 1)
        );
        assert_eq!(digest.flagged(), 1);
        assert_eq!(digest.len(), 5);
        let empty: Digest = serde_json::from_str(r#"{"since":"x"}"#).unwrap();
        assert_eq!(empty.len(), 0);
        assert!(empty.rows().is_empty());
    }

    #[test]
    fn the_digest_rows_run_through_all_four_sections_in_order() {
        let digest: Digest = serde_json::from_str(DIGEST).unwrap();
        let kinds: Vec<&str> = digest
            .rows()
            .iter()
            .map(|r| match r {
                Row::Verified(c) | Row::Rejected(c) => c.id.as_str(),
                Row::AtRisk(_) => "risk",
                Row::Contested(_) => "contested",
            })
            .collect();
        assert_eq!(kinds, ["v1", "v2", "r1", "risk", "contested"]);
        assert!(matches!(digest.rows()[0], Row::Verified(_)));
        assert!(matches!(digest.rows()[2], Row::Rejected(_)));
    }

    #[test]
    fn the_digest_layout_has_a_title_with_a_count_per_section_and_none_for_an_empty_one() {
        let digest: Digest = serde_json::from_str(DIGEST).unwrap();
        assert_eq!(
            digest.layout(),
            vec![
                Entry::Title("Jev verified alone · 2 · 1 flagged".into()),
                Entry::Row(0),
                Entry::Row(1),
                Entry::Title("Jev rejected alone · 1".into()),
                Entry::Row(2),
                Entry::Title("Lessons at risk · 1".into()),
                Entry::Row(3),
                Entry::Title("Contested claims · 1".into()),
                Entry::Row(4),
            ]
        );
        let empty: Digest = serde_json::from_str(r#"{"since":"x"}"#).unwrap();
        assert_eq!(
            empty.layout(),
            vec![
                Entry::Title("Jev verified alone · 0".into()),
                Entry::None,
                Entry::Title("Jev rejected alone · 0".into()),
                Entry::None,
                Entry::Title("Lessons at risk · 0".into()),
                Entry::None,
                Entry::Title("Contested claims · 0".into()),
                Entry::None,
            ]
        );
    }

    #[test]
    fn a_lesson_row_is_its_title_and_a_pair_row_says_then_against() {
        let digest: Digest = serde_json::from_str(DIGEST).unwrap();
        let rows = digest.rows();
        assert_eq!(
            rows[3].row_text(200),
            "The e2e suite needs the seed command before the app starts."
        );
        assert_eq!(
            rows[4].row_text(200),
            "The board lint may be skipped for a docs change. · against: The board lint must be clean before a commit."
        );
        assert_eq!(rows[3].row_text(10), "The e2e s…");
        assert_eq!(rows[4].row_text(0), "");
    }

    #[test]
    fn the_detail_of_a_lesson_and_of_a_pair_say_what_to_do_and_a_claim_keeps_its_own() {
        let digest: Digest = serde_json::from_str(DIGEST).unwrap();
        let rows = digest.rows();
        let lesson = lines_text(&rows[3].detail_lines(80));
        assert_eq!(
            lesson,
            "The e2e suite needs the seed command before the app starts.\n\nThe claim it rests on was rejected. Agents no longer read this lesson."
        );
        let pair = lines_text(&rows[4].detail_lines(100));
        for want in [
            "The board lint may be skipped for a docs change.",
            "The board lint must be clean before a commit.",
            "Reject one of the two to settle it.",
        ] {
            assert!(pair.contains(want), "{want}: {pair}");
        }
        let narrow = rows[4].detail_lines(30);
        assert!(
            narrow.iter().all(|(_, l)| l.chars().count() <= 30),
            "{narrow:?}"
        );
        assert!(lines_text(&narrow).contains("The board lint must be clean"));
        let claim = lines_text(&rows[0].detail_lines(80));
        assert!(
            claim.contains("Jev verified this alone and flagged it."),
            "{claim}"
        );
        assert_eq!(rows[0].title(), "Claim");
        assert_eq!(rows[3].title(), "Lesson");
        assert_eq!(rows[4].title(), "Contested");
    }

    #[test]
    fn a_text_of_the_digest_loses_its_control_characters() {
        let digest: Digest = serde_json::from_str(
            r#"{"since":"x","atRisk":[{"learning":"l","title":"a\u001b[31mb\u0007","claim":"c"}],
               "contested":[{"claim":"c","says":"s\u001b]0;x\u0007","contradicts":"d","against":"a\nb"}]}"#,
        )
        .unwrap();
        let mut all = String::new();
        for row in digest.rows() {
            all += &row.row_text(200);
            all += &lines_text(&row.detail_lines(60));
        }
        assert!(
            !all.chars().any(|ch| ch.is_control() && ch != '\n'),
            "{all:?}"
        );
    }

    fn state_with(status: Status, claims: Vec<Claim>) -> MemoryState {
        MemoryState {
            status,
            claims,
            loaded: true,
            ..Default::default()
        }
    }

    #[test]
    fn a_waiting_claim_is_decided_at_once_either_way_and_nothing_else_there_is() {
        let state = state_with(Status::Unverified, vec![claim(json!({}))]);
        for verify in [true, false] {
            let d = state.decision(verify).expect("a waiting claim");
            assert_eq!((d.id.as_str(), d.verify, d.undoes), ("c1", verify, false));
        }
        let stale = state_with(
            Status::Unverified,
            vec![claim(json!({"status": "verified"}))],
        );
        assert!(stale.decision(true).is_none() && stale.decision(false).is_none());
    }

    #[test]
    fn a_verified_claim_can_only_be_rejected_and_a_rejected_one_only_verified_and_both_undo() {
        let verified = state_with(
            Status::Verified,
            vec![claim(
                json!({"status": "verified", "statement": "Seed\nfirst."}),
            )],
        );
        assert!(verified.decision(true).is_none());
        let d = verified.decision(false).unwrap();
        assert_eq!((d.verify, d.undoes), (false, true));
        assert_eq!(d.statement, "Seed first.", "flat, for the confirm");
        let rejected = state_with(Status::Rejected, vec![claim(json!({"status": "rejected"}))]);
        assert!(rejected.decision(false).is_none());
        let d = rejected.decision(true).unwrap();
        assert_eq!((d.verify, d.undoes), (true, true));
        let refused = state_with(Status::Refused, vec![claim(json!({"status": "refused"}))]);
        assert!(refused.decision(true).is_none() && refused.decision(false).is_none());
    }

    #[test]
    fn no_decision_while_a_call_is_out() {
        let mut state = state_with(Status::Unverified, vec![claim(json!({}))]);
        state.pending = Some("c1".into());
        assert!(state.decision(true).is_none());
    }

    #[test]
    fn on_the_digest_only_the_claim_rows_of_the_first_two_sections_take_the_opposite_decision() {
        let mut state = state_with(Status::Week, vec![]);
        state.take_digest(serde_json::from_str(DIGEST).unwrap());
        // Rows: 0 and 1 verified, 2 rejected, 3 lesson, 4 pair.
        let want = [
            (0, false, true),
            (1, false, true),
            (2, true, true),
            (3, true, false),
            (3, false, false),
            (4, true, false),
            (4, false, false),
            (0, true, false),
            (2, false, false),
        ];
        for (cursor, verify, some) in want {
            state.cursor = cursor;
            assert_eq!(
                state.decision(verify).is_some(),
                some,
                "row {cursor}, verify {verify}"
            );
        }
        state.cursor = 2;
        assert_eq!(state.decision(true).unwrap().id, "r1");
    }

    #[test]
    fn a_decided_claim_leaves_the_digest_and_the_cursor_stays_inside_it() {
        let mut state = state_with(Status::Week, vec![]);
        state.take_digest(serde_json::from_str(DIGEST).unwrap());
        state.cursor = 4;
        state.pending = Some("v1".into());
        state.decided("v1");
        assert_eq!(state.len(), 4);
        assert_eq!(state.cursor, 3);
        assert!(state.pending.is_none());
        state.decided("r1");
        assert_eq!((state.digest.rejected.len(), state.len()), (0, 3));
    }

    #[test]
    fn showing_another_page_forgets_the_rows_of_the_last_one() {
        let mut state = state_with(Status::Week, vec![]);
        state.take_digest(serde_json::from_str(DIGEST).unwrap());
        assert!(state.loaded && state.len() == 5);
        state.show(Status::Unverified);
        assert!(!state.loaded && state.len() == 0);
    }
}

//! Intake's dedup gate on the board: the candidates the machine lists, a person's answer to them (`:dedup duplicate 2`,
//! `:dedup related 1,3`, `:dedup neither`) and a ticket named by an id prefix (`:merge 3f2a`). Every candidate title is a stranger's:
//! it goes through `detail::plain` before it is drawn. The answer carries ids from the listed candidates only; the machine checks that again.
use serde_json::Value;

use crate::detail::plain;

/// One candidate of the open dedup gate.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub slot: u64,
    pub id: String,
    pub kind: String,
    pub title: String,
    pub state: Option<String>,
    pub score: f64,
}

/// The candidates in a gate's `requested` (`kind: "dedup"`); empty for any other gate.
pub fn candidates(requested: &Value) -> Vec<Candidate> {
    if requested.get("kind").and_then(|k| k.as_str()) != Some("dedup") {
        return Vec::new();
    }
    requested
        .get("candidates")
        .and_then(|c| c.as_array())
        .map(|list| {
            list.iter()
                .take(5)
                .filter_map(|c| {
                    Some(Candidate {
                        slot: c.get("slot")?.as_u64()?,
                        id: c.get("id")?.as_str()?.to_string(),
                        kind: plain(c.get("kind")?.as_str()?),
                        title: plain(c.get("title").and_then(|t| t.as_str()).unwrap_or(""))
                            .replace('\n', " "),
                        state: c.get("state").and_then(|s| s.as_str()).map(plain),
                        score: c.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Candidate {
    /// `1  3f2a9c1d  open  0.82  Checkout fails when paying`
    pub fn line(&self) -> String {
        let what = self.state.as_deref().unwrap_or(&self.kind);
        format!(
            "{}  {}  {:<8} {:.2}  {}",
            self.slot,
            self.id.chars().take(8).collect::<String>(),
            what,
            self.score,
            self.title
        )
    }
}

/// `duplicate 2`, `related 1,3` or `neither` as the machine's `{ choice, of }`, the numbers read as the listed slots.
pub fn parse_answer(rest: &str, listed: &[Candidate]) -> Result<(String, Vec<String>), String> {
    let (choice, slots) = rest
        .split_once(char::is_whitespace)
        .map_or((rest.trim(), ""), |(c, s)| (c, s.trim()));
    let ids = |slots: &str| -> Result<Vec<String>, String> {
        let mut out: Vec<String> = Vec::new();
        for part in slots.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let slot: u64 = part
                .parse()
                .map_err(|_| format!("{part} is not a slot number"))?;
            let found = listed
                .iter()
                .find(|c| c.slot == slot)
                .ok_or_else(|| format!("no candidate in slot {slot}"))?;
            if !out.contains(&found.id) {
                out.push(found.id.clone());
            }
        }
        Ok(out)
    };
    match choice {
        "neither" => Ok(("neither".into(), Vec::new())),
        "duplicate" => match ids(slots)?.as_slice() {
            [one] => Ok(("duplicate".into(), vec![one.clone()])),
            _ => Err("name exactly one slot: :dedup duplicate 2".into()),
        },
        "related" => {
            let found = ids(slots)?;
            if found.is_empty() {
                Err("name the slots: :dedup related 1,3".into())
            } else {
                Ok(("related".into(), found))
            }
        }
        _ => Err("use :dedup duplicate <slot> | related <slots> | neither".into()),
    }
}

/// The one id among `ids` that starts with `prefix` (at least 4 characters); an error says why it is none.
pub fn resolve_prefix<'a>(
    prefix: &str,
    ids: impl Iterator<Item = &'a str>,
) -> Result<String, String> {
    let prefix = prefix.trim().to_lowercase();
    if prefix.len() < 4 {
        return Err("give at least 4 characters of the ticket's id".into());
    }
    let hits: Vec<&str> = ids
        .filter(|id| id.to_lowercase().starts_with(&prefix))
        .collect();
    match hits.as_slice() {
        [one] => Ok((*one).to_string()),
        [] => Err(format!("no ticket starts with {}", plain(&prefix))),
        _ => Err(format!(
            "{} tickets start with {}",
            hits.len(),
            plain(&prefix)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gate() -> Value {
        json!({"kind":"dedup","candidates":[
            {"slot":1,"id":"11111111-0000-0000-0000-000000000000","kind":"open","title":"Checkout fails\u{1b}[2J\nwhen paying","state":"triage","score":0.82},
            {"slot":2,"id":"22222222-0000-0000-0000-000000000000","kind":"backlog","title":"Slow","state":null,"score":0.31}]})
    }

    #[test]
    fn lists_the_candidates_of_a_dedup_gate_and_only_of_that_gate() {
        let c = candidates(&gate());
        assert_eq!(c.len(), 2);
        assert_eq!(
            c[0].line(),
            "1  11111111  triage   0.82  Checkout fails [2J when paying"
        );
        assert!(!c[0].title.contains('\u{1b}') && !c[0].title.contains('\n'));
        assert_eq!(c[1].line(), "2  22222222  backlog  0.31  Slow");
        assert!(candidates(&json!({"kind":"context","missing":["text"]})).is_empty());
    }

    #[test]
    fn reads_an_answer_as_slots_and_sends_ids() {
        let c = candidates(&gate());
        assert_eq!(
            parse_answer("duplicate 2", &c),
            Ok((
                "duplicate".into(),
                vec!["22222222-0000-0000-0000-000000000000".into()]
            ))
        );
        assert_eq!(parse_answer("related 1, 2", &c).unwrap().1.len(), 2);
        assert_eq!(parse_answer("neither", &c), Ok(("neither".into(), vec![])));
    }

    #[test]
    fn refuses_what_the_gate_did_not_list() {
        let c = candidates(&gate());
        assert!(parse_answer("duplicate 3", &c).is_err());
        assert!(parse_answer("duplicate 1,2", &c).is_err());
        assert!(parse_answer("duplicate", &c).is_err());
        assert!(parse_answer("related", &c).is_err());
        assert!(parse_answer("related x", &c).is_err());
        assert!(parse_answer("maybe 1", &c).is_err());
    }

    #[test]
    fn names_a_ticket_by_a_unique_prefix_of_at_least_four() {
        let ids = ["3f2a9c1d-0", "3f2b0000-1", "aaaa1111-2"];
        assert_eq!(
            resolve_prefix("3f2a", ids.iter().copied()),
            Ok("3f2a9c1d-0".into())
        );
        assert!(resolve_prefix("3f2", ids.iter().copied()).is_err());
        assert!(
            resolve_prefix("3f2", ids.iter().copied())
                .unwrap_err()
                .contains("4 characters")
        );
        assert!(resolve_prefix("3f2", ids.iter().copied()).is_err());
        assert!(
            resolve_prefix("zzzz", ids.iter().copied())
                .unwrap_err()
                .contains("no ticket")
        );
        assert!(resolve_prefix("3F2A", ids.iter().copied()).is_ok());
    }
}

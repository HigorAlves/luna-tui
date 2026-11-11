//! The one place the board launches anything: a file or folder in the platform's opener, or a link in
//! the browser. The program is run with the target as a single argument, never through a shell; a path
//! must exist and lie under a folder the board may open from; a link must be `https://`. Anything else
//! is refused with a fixed sentence that never repeats the target.

use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// The longest link the board will hand to a browser.
const MAX_URL: usize = 2_000;

pub(crate) const REFUSE_RELATIVE: &str = "refused: not an absolute path";
pub(crate) const REFUSE_MISSING: &str = "refused: that path does not exist";
pub(crate) const REFUSE_OUTSIDE: &str = "refused: outside the machine's folders and the card's repository";
pub(crate) const REFUSE_URL: &str = "refused: only https links open";
const STARTING: &str = "could not start the opener";
pub(crate) const REFUSE_NO_OPENER: &str = "no opener on this system";

/// What launches a target: `(program, target)`. Tests record the call instead of spawning.
pub(crate) type Launch<'a> = &'a mut dyn FnMut(&str, &OsStr) -> io::Result<()>;

/// The launcher the app owns.
pub(crate) type Launcher = Box<dyn FnMut(&str, &OsStr) -> io::Result<()>>;

/// The platform's "open this" program: `open` on macOS, `xdg-open` on Linux, none elsewhere.
pub fn opener() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("open")
    } else if cfg!(target_os = "linux") {
        Some("xdg-open")
    } else {
        None
    }
}

/// The machine's state folder, where each run's files live: `MACHINE_STATE_DIR`, else `~/.local/state/hardness` (the machine's own default).
pub fn state_dir() -> Option<PathBuf> {
    state_dir_from(std::env::var("MACHINE_STATE_DIR").ok(), std::env::var("HOME").ok())
}

fn state_dir_from(state: Option<String>, home: Option<String>) -> Option<PathBuf> {
    match state.filter(|s| !s.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => home.filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".local").join("state").join("hardness")),
    }
}

/// Spawns `program target` detached: no shell, output discarded, and a thread reaps the child so none lingers.
pub(crate) fn spawn_detached(program: &str, target: &OsStr) -> io::Result<()> {
    let mut child = Command::new(program).arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Opens `path` (a file or a folder) when it is absolute, exists and, with symlinks and `..` resolved, lies under one of `roots`.
pub(crate) fn open_path_with(launch: Launch, path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let program = opener().ok_or(REFUSE_NO_OPENER)?;
    if !path.is_absolute() {
        return Err(REFUSE_RELATIVE.into());
    }
    // Canonical: it proves the path exists, and settles `..` and symlinks before the root check.
    let real = fs::canonicalize(path).map_err(|_| REFUSE_MISSING.to_string())?;
    if !roots.iter().filter_map(|root| fs::canonicalize(root).ok()).any(|root| real.starts_with(root)) {
        return Err(REFUSE_OUTSIDE.into());
    }
    launch(program, real.as_os_str()).map_err(|_| STARTING.to_string())
}

/// Opens `url` in the browser when it is a plain `https://` link.
pub(crate) fn open_url_with(launch: Launch, url: &str) -> Result<(), String> {
    let program = opener().ok_or(REFUSE_NO_OPENER)?;
    let plain = url.starts_with("https://") && url.len() > "https://".len() && url.len() <= MAX_URL && !url.chars().any(|ch| ch.is_whitespace() || ch.is_control());
    if !plain {
        return Err(REFUSE_URL.into());
    }
    launch(program, OsStr::new(url)).map_err(|_| STARTING.to_string())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    /// A fresh folder under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("board-open-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn file(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"x").unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run(path: &Path, roots: &[PathBuf]) -> (Result<(), String>, Vec<(String, std::ffi::OsString)>) {
        let mut calls = Vec::new();
        let mut launch = |program: &str, target: &OsStr| {
            calls.push((program.to_string(), target.to_os_string()));
            Ok(())
        };
        let result = open_path_with(&mut launch, path, roots);
        (result, calls)
    }

    fn run_url(url: &str) -> (Result<(), String>, usize) {
        let mut n = 0;
        let mut launch = |_: &str, _: &OsStr| {
            n += 1;
            Ok(())
        };
        let result = open_url_with(&mut launch, url);
        (result, n)
    }

    #[test]
    fn the_state_folder_is_the_machines_variable_else_its_default_under_home() {
        assert_eq!(state_dir_from(Some("/srv/luna".into()), Some("/home/me".into())), Some(PathBuf::from("/srv/luna")));
        assert_eq!(state_dir_from(None, Some("/home/me".into())), Some(PathBuf::from("/home/me/.local/state/hardness")));
        assert_eq!(state_dir_from(Some(String::new()), None), None);
    }

    #[test]
    fn the_opener_is_open_on_macos_and_xdg_open_on_linux() {
        let expect = if cfg!(target_os = "macos") { Some("open") } else if cfg!(target_os = "linux") { Some("xdg-open") } else { None };
        assert_eq!(opener(), expect);
    }

    #[test]
    fn a_path_with_spaces_is_one_argument() {
        let s = Scratch::new("spaces");
        let file = s.file("my runs/a shot.png");
        let (result, calls) = run(&file, std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(()));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, opener().unwrap());
        assert_eq!(calls[0].1, fs::canonicalize(&file).unwrap().as_os_str());
    }

    #[test]
    fn shell_metacharacters_in_a_name_reach_the_opener_untouched() {
        let s = Scratch::new("meta");
        let file = s.file("a;rm -rf $(echo x)`id`.png");
        let (result, calls) = run(&file, std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(()));
        assert_eq!(calls[0].1, fs::canonicalize(&file).unwrap().as_os_str());
    }

    #[test]
    fn a_folder_under_a_root_opens() {
        let s = Scratch::new("folder");
        s.file("qa/one.png");
        let (result, calls) = run(&s.0.join("qa"), std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(()));
        assert_eq!(calls.len(), 1);
    }

    #[test]
    fn dotdot_cannot_leave_the_root() {
        let s = Scratch::new("dotdot");
        let outside = Scratch::new("dotdot-outside");
        let secret = outside.file("secret.txt");
        let root = s.0.join("root");
        fs::create_dir_all(&root).unwrap();
        let sneaky = root.join("..").join("..").join(secret.strip_prefix("/").unwrap());
        let up = root.join("../../..").join(secret.strip_prefix("/").unwrap());
        for path in [sneaky, up] {
            let (result, calls) = run(&path, std::slice::from_ref(&root));
            assert!(result.is_err() && calls.is_empty(), "{path:?}");
        }
        let (result, calls) = run(&secret, &[root]);
        assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()));
        assert!(calls.is_empty());
    }

    #[test]
    fn a_symlink_inside_the_root_pointing_out_is_refused() {
        let s = Scratch::new("link");
        let outside = Scratch::new("link-outside");
        let secret = outside.file("secret.txt");
        let root = s.0.join("root");
        fs::create_dir_all(&root).unwrap();
        symlink(&secret, root.join("innocent.png")).unwrap();
        symlink(&outside.0, root.join("dir")).unwrap();
        for path in [root.join("innocent.png"), root.join("dir").join("secret.txt")] {
            let (result, calls) = run(&path, std::slice::from_ref(&root));
            assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()), "{path:?}");
            assert!(calls.is_empty());
        }
    }

    #[test]
    fn a_relative_path_is_refused() {
        let (result, calls) = run(Path::new("files/qa/shot.png"), &[PathBuf::from("/")]);
        assert_eq!(result, Err(REFUSE_RELATIVE.to_string()));
        assert!(calls.is_empty());
    }

    #[test]
    fn a_missing_path_is_refused() {
        let s = Scratch::new("missing");
        let (result, calls) = run(&s.0.join("nope.png"), std::slice::from_ref(&s.0));
        assert_eq!(result, Err(REFUSE_MISSING.to_string()));
        assert!(calls.is_empty());
    }

    #[test]
    fn no_roots_means_nothing_opens() {
        let s = Scratch::new("noroots");
        let file = s.file("a.png");
        let (result, calls) = run(&file, &[]);
        assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()));
        assert!(calls.is_empty());
    }

    #[test]
    fn a_sibling_folder_sharing_the_roots_prefix_is_outside() {
        let s = Scratch::new("prefix");
        let file = s.file("rootbeer/a.png");
        fs::create_dir_all(s.0.join("root")).unwrap();
        let (result, _) = run(&file, &[s.0.join("root")]);
        assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()));
    }

    #[test]
    fn a_https_link_opens_as_one_argument() {
        let mut got = Vec::new();
        let mut launch = |program: &str, target: &OsStr| {
            got.push((program.to_string(), target.to_os_string()));
            Ok(())
        };
        assert_eq!(open_url_with(&mut launch, "https://github.com/acme/app/pull/412?x=a;b&y=$(id)"), Ok(()));
        assert_eq!(got, vec![(opener().unwrap().to_string(), "https://github.com/acme/app/pull/412?x=a;b&y=$(id)".into())]);
    }

    #[test]
    fn links_other_than_https_are_refused() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL));
        for url in [
            "http://example.com",
            "file:///etc/passwd",
            "ftp://example.com",
            "javascript:alert(1)",
            "https:// example.com",
            "https://example.com/a b",
            "https://example.com/\u{1b}[2J",
            "https://example.com/a\nb",
            "-oProxyCommand=id",
            "--help",
            "",
            long.as_str(),
        ] {
            let (result, n) = run_url(url);
            assert_eq!(result, Err(REFUSE_URL.to_string()), "{url:?}");
            assert_eq!(n, 0);
        }
    }

    #[test]
    fn a_refusal_never_repeats_the_target() {
        let (result, _) = run_url("http://evil.example/\u{1b}[31mred");
        assert!(!result.unwrap_err().contains("evil"));
        let (result, _) = run(Path::new("-oProxyCommand=touch /tmp/pwned"), &[PathBuf::from("/")]);
        assert!(!result.unwrap_err().contains("Proxy"));
    }

    #[test]
    fn a_launcher_that_fails_says_so_in_fixed_words() {
        let s = Scratch::new("fail");
        let file = s.file("a.png");
        let mut launch = |_: &str, _: &OsStr| Err(io::Error::other("boom /secret"));
        let error = open_path_with(&mut launch, &file, std::slice::from_ref(&s.0)).unwrap_err();
        assert_eq!(error, "could not start the opener");
        let mut launch = |_: &str, _: &OsStr| Err(io::Error::other("boom"));
        assert_eq!(open_url_with(&mut launch, "https://example.com").unwrap_err(), "could not start the opener");
    }
}

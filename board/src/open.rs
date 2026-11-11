//! The one place the board launches anything: a file or folder in the platform's opener, or a link in
//! the browser. The program is run with its arguments as separate arguments, never through a shell; a path
//! must exist and lie under a folder the board may open from; a link must be a plain `https://` one.
//! Anything else is refused with a fixed sentence that never repeats the target.
//!
//! Stage containers write the files the board shows, so a file is never handed to its default handler
//! (`open` runs `.command` files, `.terminal` and `.inetloc` files and executables): it is revealed in the
//! file manager, except for a short list of kinds that are inert to view.

use std::{
    ffi::{OsStr, OsString},
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

/// What the refusal says about a link: its scheme when it has a plain one (`http`), so the person knows what to change.
fn refusal(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, _)) if !scheme.eq_ignore_ascii_case("https") && !scheme.is_empty() && scheme.len() <= 10 && scheme.chars().all(|c| c.is_ascii_alphabetic()) => format!("{REFUSE_URL} (this one is {})", scheme.to_ascii_lowercase()),
        _ => REFUSE_URL.to_string(),
    }
}
const STARTING: &str = "could not start the opener";
pub(crate) const REFUSE_NO_OPENER: &str = "no opener on this system";

/// What launches a target: `(program, arguments)`. Tests record the call instead of spawning.
pub(crate) type Launch<'a> = &'a mut dyn FnMut(&str, &[OsString]) -> io::Result<()>;

/// The launcher the app owns.
pub(crate) type Launcher = Box<dyn FnMut(&str, &[OsString]) -> io::Result<()>>;

/// What a launched path came to: opened with its default handler, or shown in the file manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Opened {
    Opened,
    Revealed,
}

/// Kinds a viewer shows without running anything: images, video, plain text, JSON, CSV, PDF. `html`, `svg` and archives are not here.
const VIEWABLE: [&str; 15] = ["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "txt", "log", "md", "json", "jsonl", "csv", "pdf"];

/// Folder-like packages the OS launches or installs when asked to open them.
const BUNDLES: [&str; 15] = ["app", "bundle", "framework", "plugin", "kext", "prefpane", "workflow", "action", "qlgenerator", "saver", "wdgt", "xpc", "appex", "pkg", "mpkg"];

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

/// Spawns `program args` detached: no shell, output discarded, and a thread reaps the child so none lingers.
pub(crate) fn spawn_detached(program: &str, args: &[OsString]) -> io::Result<()> {
    let mut child = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The directories no root may be, once normalised: the disk, the system's own folders and the places homes live.
/// A folder deeper inside any of them (a worktree under `/private/tmp/x/y`, a repo under `$HOME/dev/app`) is fine.
const BROAD_ROOTS: [&str; 18] = [
    "/", "/etc", "/var", "/tmp", "/private", "/private/etc", "/private/var", "/private/tmp", "/usr", "/bin", "/sbin", "/opt", "/System", "/Library", "/Applications", "/Users", "/home", "/Volumes",
];

/// `path` without macOS's data-volume prefix: `/System/Volumes/Data/Users/me` is `/Users/me` spelled the long way.
fn strip_data_volume(path: &Path) -> PathBuf {
    match path.strip_prefix("/System/Volumes/Data") {
        Ok(rest) => Path::new("/").join(rest),
        Err(_) => path.to_path_buf(),
    }
}

/// A path as the checks see it: canonical, and without the data-volume prefix.
fn normalised(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok().map(|real| strip_data_volume(&real))
}

/// Whether a normalised `root` is one of the system directories, the home folder, or an ancestor of the home folder.
fn broad_root(root: &Path, home: Option<&Path>) -> bool {
    BROAD_ROOTS.iter().any(|dir| root == Path::new(dir)) || home.is_some_and(|home| home.starts_with(root))
}

/// A root the board may open from: an absolute, canonical directory at least two folders deep that is neither a system
/// directory nor the home folder or any ancestor of it. Judged after normalising (`..`, symlinks, the data-volume prefix).
fn usable_root(root: &Path) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).and_then(|h| normalised(Path::new(&h)));
    usable_root_in(root, home.as_deref())
}

fn usable_root_in(root: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let real = normalised(root)?;
    let depth = real.components().filter(|c| matches!(c, std::path::Component::Normal(_))).count();
    (real.is_absolute() && real.is_dir() && depth >= 2 && !broad_root(&real, home)).then_some(real)
}

/// Whether a folder name has an extension: a `.` after its first character (`.git` and `.orc` are hidden, not extended).
fn has_extension(name: &OsStr) -> bool {
    name.to_string_lossy().chars().skip(1).any(|c| c == '.')
}

/// Whether the folder `real`, or a folder between it and `root`, has an extension: `.app`, `.playground`, `.xcodeproj`, `v1.2`.
/// What lies above the root does not count.
fn extension_below(real: &Path, root: &Path) -> bool {
    let below = real.strip_prefix(root).unwrap_or(real);
    below.components().any(|c| matches!(c, std::path::Component::Normal(name) if has_extension(name))) || (below.as_os_str().is_empty() && real.file_name().is_some_and(has_extension))
}

/// Whether `name` ends in a package extension (case-insensitive).
fn is_bundle_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    BUNDLES.iter().any(|ext| name.strip_suffix(ext).is_some_and(|rest| rest.ends_with('.') && rest.len() > 1))
}

/// Whether any folder of `real` (or its own name) is a package.
fn inside_bundle(real: &Path) -> bool {
    real.components().any(|c| matches!(c, std::path::Component::Normal(name) if is_bundle_name(name)))
}

/// Whether the default handler may be given this file: a regular file, executable by no one, of a kind that is inert to view.
fn viewable(real: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::metadata(real) else { return false };
    let kind = real.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    meta.is_file() && meta.permissions().mode() & 0o111 == 0 && kind.is_some_and(|k| VIEWABLE.contains(&k.as_str()))
}

/// Shows `real` in the file manager: `open -R` selects it in Finder; elsewhere its folder opens.
fn reveal(launch: Launch, program: &str, real: &Path) -> Result<Opened, String> {
    let args: Vec<OsString> = if cfg!(target_os = "macos") {
        vec![OsString::from("-R"), real.as_os_str().to_os_string()]
    } else {
        vec![real.parent().unwrap_or(real).as_os_str().to_os_string()]
    };
    launch(program, &args).map(|()| Opened::Revealed).map_err(|_| STARTING.to_string())
}

/// Opens or reveals `path` (a file or a folder) when it is absolute, exists and, with symlinks and `..` resolved, lies under one of `roots`.
/// A folder opens unless it, or a folder between it and its root, has an extension (a package, a project, `v1.2`); a file opens
/// only when it is a plain viewable kind outside a package; everything else is revealed.
pub(crate) fn open_path_with(launch: Launch, path: &Path, roots: &[PathBuf]) -> Result<Opened, String> {
    let program = opener().ok_or(REFUSE_NO_OPENER)?;
    if !path.is_absolute() {
        return Err(REFUSE_RELATIVE.into());
    }
    // Canonical: it proves the path exists, and settles `..` and symlinks before the root check.
    let real = normalised(path).ok_or_else(|| REFUSE_MISSING.to_string())?;
    let Some(root) = roots.iter().filter_map(|root| usable_root(root)).find(|root| real.starts_with(root)) else {
        return Err(REFUSE_OUTSIDE.into());
    };
    let plain = if real.is_dir() { !extension_below(&real, &root) } else { !inside_bundle(&real) && viewable(&real) };
    if plain {
        launch(program, &[real.as_os_str().to_os_string()]).map(|()| Opened::Opened).map_err(|_| STARTING.to_string())
    } else {
        reveal(launch, program, &real)
    }
}

/// Whether the host of an `https://` link is one the board will hand to a browser: a name, ASCII, not punycode, not an address.
fn plain_host(rest: &str) -> bool {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    let host = host.to_ascii_lowercase();
    let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    !host.is_empty()
        && host.is_ascii()
        && !host.contains("xn--")
        && !host.starts_with('[')
        && host.parse::<std::net::IpAddr>().is_err()
        && !last.is_empty()
        && !last.chars().all(|c| c.is_ascii_digit())
        && !last.starts_with("0x")
}

/// Opens `url` in the browser when it is a plain `https://` link.
pub(crate) fn open_url_with(launch: Launch, url: &str) -> Result<(), String> {
    let program = opener().ok_or(REFUSE_NO_OPENER)?;
    let plain = url.starts_with("https://") && url.len() > "https://".len() && url.len() <= MAX_URL && !url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) && plain_host(&url["https://".len()..]);
    if !plain {
        return Err(refusal(url));
    }
    launch(program, &[OsString::from(url)]).map_err(|_| STARTING.to_string())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{symlink, PermissionsExt};

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

    type Calls = Vec<(String, Vec<OsString>)>;

    fn run(path: &Path, roots: &[PathBuf]) -> (Result<Opened, String>, Calls) {
        let mut calls = Vec::new();
        let mut launch = |program: &str, args: &[OsString]| {
            calls.push((program.to_string(), args.to_vec()));
            Ok(())
        };
        let result = open_path_with(&mut launch, path, roots);
        (result, calls)
    }

    fn run_url(url: &str) -> (Result<(), String>, usize) {
        let mut n = 0;
        let mut launch = |_: &str, _: &[OsString]| {
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
        assert_eq!(result, Ok(Opened::Opened));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, opener().unwrap());
        assert_eq!(calls[0].1, vec![fs::canonicalize(&file).unwrap().into_os_string()]);
    }

    #[test]
    fn shell_metacharacters_in_a_name_reach_the_opener_untouched() {
        let s = Scratch::new("meta");
        let file = s.file("a;rm -rf $(echo x)`id`.png");
        let (result, calls) = run(&file, std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(Opened::Opened));
        assert_eq!(calls[0].1, vec![fs::canonicalize(&file).unwrap().into_os_string()]);
    }

    #[test]
    fn a_folder_under_a_root_opens() {
        let s = Scratch::new("folder");
        s.file("qa/one.png");
        let (result, calls) = run(&s.0.join("qa"), std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(Opened::Opened));
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
        let mut launch = |program: &str, args: &[OsString]| {
            got.push((program.to_string(), args.to_vec()));
            Ok(())
        };
        assert_eq!(open_url_with(&mut launch, "https://github.com/acme/app/pull/412?x=a;b&y=$(id)"), Ok(()));
        assert_eq!(got, vec![(opener().unwrap().to_string(), vec![OsString::from("https://github.com/acme/app/pull/412?x=a;b&y=$(id)")])]);
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
            "https://github.com@evil.example/x",
            "https://user:pw@example.com/",
            "https://xn--e1afmkfd.example/",
            "https://XN--e1afmkfd.example/",
            "https://exämple.com/",
            "https:///path",
            "https://:443/",
            "https://127.0.0.1/",
            "https://127.0.0.1:8080/x",
            "https://[::1]/x",
            "https://2130706433/",
            "--help",
            "",
            long.as_str(),
        ] {
            let (result, n) = run_url(url);
            assert!(result.as_ref().is_err_and(|why| why.starts_with(REFUSE_URL)), "{url:?}: {result:?}");
            assert_eq!(n, 0);
        }
        assert_eq!(run_url("http://example.com").0, Err("refused: only https links open (this one is http)".to_string()));
        assert_eq!(run_url("https://example.com/a b").0, Err(REFUSE_URL.to_string()), "an https link with a space is not called http");
        assert_eq!(run_url("--help").0, Err(REFUSE_URL.to_string()));
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
        let mut launch = |_: &str, _: &[OsString]| Err(io::Error::other("boom /secret"));
        let error = open_path_with(&mut launch, &file, std::slice::from_ref(&s.0)).unwrap_err();
        assert_eq!(error, "could not start the opener");
        let mut launch = |_: &str, _: &[OsString]| Err(io::Error::other("boom"));
        assert_eq!(open_url_with(&mut launch, "https://example.com").unwrap_err(), "could not start the opener");
    }

    fn one(path: &Path, roots: &[PathBuf]) -> (Result<Opened, String>, Vec<OsString>) {
        let (result, calls) = run(path, roots);
        assert!(calls.len() <= 1, "{calls:?}");
        (result, calls.into_iter().next().map(|(_, args)| args).unwrap_or_default())
    }

    fn revealed_args(real: &Path) -> Vec<OsString> {
        if cfg!(target_os = "macos") {
            vec![OsString::from("-R"), real.as_os_str().to_os_string()]
        } else {
            vec![real.parent().unwrap().as_os_str().to_os_string()]
        }
    }

    #[test]
    fn files_that_run_or_act_when_opened_are_revealed_not_opened() {
        let s = Scratch::new("hostile");
        for name in ["run.command", "x.terminal", "link.inetloc", "a.html", "b.svg", "c.zip", "d.jar", "e.pkg", "f.webloc", "bin/setup", "UPPER.COMMAND"] {
            let file = s.file(name);
            let (result, args) = one(&file, std::slice::from_ref(&s.0));
            assert_eq!(result, Ok(Opened::Revealed), "{name}");
            assert_eq!(args, revealed_args(&fs::canonicalize(&file).unwrap()), "{name}");
        }
    }

    #[test]
    fn a_plain_viewable_file_opens_and_an_executable_one_is_revealed() {
        let s = Scratch::new("viewable");
        for name in ["shot.png", "SHOT.PNG", "a.jpg", "v.mp4", "n.txt", "x.log", "r.md", "d.json", "d.jsonl", "t.csv", "p.pdf"] {
            let file = s.file(name);
            let (result, args) = one(&file, std::slice::from_ref(&s.0));
            assert_eq!(result, Ok(Opened::Opened), "{name}");
            assert_eq!(args, vec![fs::canonicalize(&file).unwrap().into_os_string()], "{name}");
        }
        let exec = s.file("notes.txt");
        fs::set_permissions(&exec, fs::Permissions::from_mode(0o755)).unwrap();
        let (result, args) = one(&exec, std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(Opened::Revealed));
        assert_eq!(args, revealed_args(&fs::canonicalize(&exec).unwrap()));
        let group = s.file("group.txt");
        fs::set_permissions(&group, fs::Permissions::from_mode(0o610)).unwrap();
        assert_eq!(one(&group, std::slice::from_ref(&s.0)).0, Ok(Opened::Revealed), "executable by anyone counts");
    }

    #[test]
    fn a_file_inside_a_bundle_is_revealed_and_so_is_the_bundle_folder() {
        let s = Scratch::new("bundle");
        let inside = s.file("X.app/Contents/shot.png");
        let (result, args) = one(&inside, std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(Opened::Revealed));
        assert_eq!(args, revealed_args(&fs::canonicalize(&inside).unwrap()));
        let folder = s.0.join("Evil.APP");
        fs::create_dir_all(&folder).unwrap();
        let (result, args) = one(&folder, std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(Opened::Revealed));
        assert_eq!(args, revealed_args(&fs::canonicalize(&folder).unwrap()));
        for ext in ["bundle", "framework", "plugin", "kext", "prefPane", "workflow", "action", "qlgenerator", "saver", "wdgt", "xpc", "appex", "pkg", "mpkg"] {
            let dir = s.0.join(format!("a.{ext}"));
            fs::create_dir_all(&dir).unwrap();
            assert_eq!(one(&dir, std::slice::from_ref(&s.0)).0, Ok(Opened::Revealed), "{ext}");
        }
        let near = s.0.join("app");
        fs::create_dir_all(&near).unwrap();
        assert_eq!(one(&near, std::slice::from_ref(&s.0)).0, Ok(Opened::Opened), "a folder merely named app is a folder");
    }

    #[test]
    fn a_normal_folder_opens() {
        let s = Scratch::new("plainfolder");
        s.file("qa/shot.png");
        let (result, args) = one(&s.0.join("qa"), std::slice::from_ref(&s.0));
        assert_eq!(result, Ok(Opened::Opened));
        assert_eq!(args, vec![fs::canonicalize(s.0.join("qa")).unwrap().into_os_string()]);
    }

    #[test]
    fn roots_that_are_too_broad_open_nothing() {
        let (result, calls) = run(Path::new("/etc/hosts"), &[PathBuf::from("/")]);
        assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()));
        assert!(calls.is_empty());
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let s = Scratch::new("broad");
        let file = s.file("a.png");
        for root in [PathBuf::from("/"), PathBuf::from("/Users"), PathBuf::from("/home"), home.clone(), PathBuf::from("relative/dir")] {
            let (result, calls) = run(&file, std::slice::from_ref(&root));
            assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()), "{root:?}");
            assert!(calls.is_empty());
        }
        let (result, _) = run(&file, &[PathBuf::from("/"), s.0.clone()]);
        assert_eq!(result, Ok(Opened::Opened), "a good root next to a bad one still works");
    }

    fn home_dir() -> PathBuf {
        fs::canonicalize(std::env::var("HOME").unwrap()).unwrap()
    }

    #[test]
    fn the_macos_data_volume_prefix_is_stripped_before_a_root_is_judged() {
        assert_eq!(strip_data_volume(Path::new("/System/Volumes/Data/Users/me")), PathBuf::from("/Users/me"));
        assert_eq!(strip_data_volume(Path::new("/System/Volumes/Data")), PathBuf::from("/"));
        assert_eq!(strip_data_volume(Path::new("/System/Volumes/Datafoo/x")), PathBuf::from("/System/Volumes/Datafoo/x"));
        assert_eq!(strip_data_volume(Path::new("/Users/me")), PathBuf::from("/Users/me"));
    }

    #[test]
    fn the_system_directories_are_not_roots_but_a_folder_deeper_in_them_is() {
        for dir in ["/", "/etc", "/var", "/tmp", "/private", "/private/etc", "/private/var", "/private/tmp", "/usr", "/bin", "/sbin", "/opt", "/System", "/Library", "/Applications", "/Users", "/home", "/Volumes"] {
            assert!(broad_root(Path::new(dir), None), "{dir} is too broad to be a root");
        }
        for dir in ["/private/tmp/x/y", "/tmp/x/y", "/var/folders/ab/cd/T/x", "/opt/tool", "/Users/me/dev"] {
            assert!(!broad_root(Path::new(dir), None), "{dir} is a fine root");
        }
    }

    #[test]
    fn the_home_folder_and_every_ancestor_of_it_are_not_roots() {
        let home = Path::new("/Users/me");
        for dir in ["/Users/me", "/Users", "/"] {
            assert!(broad_root(Path::new(dir), Some(home)), "{dir}");
        }
        for dir in ["/Users/me/dev/app", "/Users/me/dev", "/Users/other"] {
            assert!(!broad_root(Path::new(dir), Some(home)), "{dir}");
        }
    }

    #[test]
    fn a_root_in_the_home_folder_works_and_the_home_folder_itself_does_not() {
        let s = Scratch::new("fakehome");
        let home = fs::canonicalize(&s.0).unwrap();
        let app = home.join("dev/app");
        fs::create_dir_all(&app).unwrap();
        assert_eq!(usable_root_in(&app, Some(&home)), Some(app.clone()), "$HOME/dev/app is a root");
        assert_eq!(usable_root_in(&home, Some(&home)), None);
        assert_eq!(usable_root_in(home.parent().unwrap(), Some(&home)), None, "an ancestor of home is no root");
        assert_eq!(usable_root_in(&home.join("dev/../dev/.."), Some(&home)), None, "dotdot is settled first");
    }

    #[test]
    fn the_data_volume_spelling_of_the_home_folder_or_the_disk_is_refused() {
        let data = Path::new("/System/Volumes/Data");
        if !data.join("Users").exists() {
            return;
        }
        let home = home_dir();
        let spelled = data.join(home.strip_prefix("/").unwrap());
        assert_eq!(usable_root_in(&spelled, Some(&home)), None, "{spelled:?}");
        assert_eq!(usable_root_in(data, Some(&home)), None);
        assert_eq!(usable_root_in(&data.join("Users"), Some(&home)), None);
    }

    #[test]
    fn etc_and_var_open_nothing() {
        for root in ["/etc", "/var", "/private/etc"] {
            if !Path::new(root).exists() {
                continue;
            }
            let (result, calls) = run(Path::new("/etc/hosts"), &[PathBuf::from(root)]);
            assert_eq!(result, Err(REFUSE_OUTSIDE.to_string()), "{root}");
            assert!(calls.is_empty());
        }
    }

    #[test]
    fn a_folder_with_an_extension_is_revealed_and_a_hidden_or_plain_one_opens() {
        let s = Scratch::new("extensions");
        for name in ["App.playground", "x.xcodeproj", "v1.2", "notes.scptd", "a.", "weird.thing"] {
            let dir = s.0.join(name);
            fs::create_dir_all(&dir).unwrap();
            let (result, args) = one(&dir, std::slice::from_ref(&s.0));
            assert_eq!(result, Ok(Opened::Revealed), "{name}");
            assert_eq!(args, revealed_args(&fs::canonicalize(&dir).unwrap()), "{name}");
        }
        for name in [".git", ".orc", "plain", "app", "my runs"] {
            let dir = s.0.join(name);
            fs::create_dir_all(&dir).unwrap();
            assert_eq!(one(&dir, std::slice::from_ref(&s.0)).0, Ok(Opened::Opened), "{name}");
        }
    }

    #[test]
    fn a_folder_under_a_folder_with_an_extension_is_revealed_too() {
        let s = Scratch::new("ancestor-ext");
        let deep = s.0.join("Proj.xcodeproj/inner/deeper");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(one(&deep, std::slice::from_ref(&s.0)).0, Ok(Opened::Revealed));
    }

    #[test]
    fn the_extension_check_stops_at_the_root() {
        let s = Scratch::new("under-app");
        let root = s.0.join("Foo.app/work");
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let (result, args) = one(&plain, std::slice::from_ref(&root));
        assert_eq!(result, Ok(Opened::Opened), "a root that sits under Foo.app opens a plain folder inside it");
        assert_eq!(args, vec![fs::canonicalize(&plain).unwrap().into_os_string()]);
    }

    #[test]
    fn a_link_with_a_plain_host_still_opens() {
        for url in ["https://github.com/acme/app/pull/1?a=b#c", "https://acme.atlassian.net/browse/PLAT-1", "https://example.com:8443/x", "https://app.slack.com/client/T1/C1?x=a@b", "https://v6.example.com/"] {
            assert_eq!(run_url(url), (Ok(()), 1), "{url}");
        }
    }
}

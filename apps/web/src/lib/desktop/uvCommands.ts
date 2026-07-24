// v0.4 S3 chunk 4 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 4 + §App-data layout) — pure uv command builders. TS owns
// {args,env} construction (unit-tested here, zero Tauri imports); Rust
// owns spawning (S3 chunk 3's run_uv, apps/desktop/src-tauri/src/uv.rs) —
// architecture decision 2. Every function here is a plain, deterministic
// mapping from DesktopPaths (+ nothing else) to a UvCommand — no IO, no
// Tauri, no invoke() calls; chunk 5's runner is the only thing that ever
// actually invoke()s these.
//
// Version pins verified directly against the pinned uv 0.11.28 binary
// (apps/desktop/src-tauri/binaries/uv-<triple>, chunk 2) at S3 chunk-4
// implementation time (2026-07-12): `uv python install --help` accepts a
// bare version as a positional TARGET; `uv venv --help`'s "Python
// options" section documents `-p, --python <PYTHON>`; `uv pip install
// --help` documents both `-p/--python <PYTHON>` and `-r/--requirements
// <REQUIREMENTS>`; and `UV_PYTHON_PREFERENCE`'s possible values (visible
// in the binary's own embedded clap value strings) are exactly
// `only-managed`/`managed`/`system`/`only-system` — "only-managed" matches
// the blueprint's App-data layout section verbatim.

/** Mirrors S3 chunk 3's Rust `AppPaths` (apps/desktop/src-tauri/src/
 *  paths.rs) exactly, field-for-field, as it crosses the `app_paths()`
 *  IPC boundary (Tauri auto-camelCases the Rust snake_case fields; every
 *  PathBuf becomes a plain string). TS never constructs or hardcodes any
 *  of these paths itself — chunk 5's runner is expected to get this
 *  object from a single `invoke("app_paths")` call and thread it through
 *  unchanged. */
export interface DesktopPaths {
  appData: string;
  pythonInstallDir: string;
  uvCacheDir: string;
  venvDir: string;
  venvPython: string;
  modelsDir: string;
  scriptPath: string;
  requirementsPath: string;
  diarRequirementsPath: string;
  logPath: string;
  markerPath: string;
  /** S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
   *  R1) — the separate, hash-locked MLX venv beside the base `venvDir`
   *  above (parakeet's own isolated venv: airtight isolation from the
   *  base whisper venv per §C R1's numba-conflict note). Worker A2
   *  tightened this from optional to required (§C L1 prelude's own
   *  fields were optional only because paths.rs's `AppPaths` hadn't
   *  grown the matching `mlx_venv_dir` field yet) — every DesktopPaths
   *  fixture across this repo (uvCommands/provisionMachine/
   *  provisionRunner/bootstrap/jobsBridge test files, DesktopWizard's
   *  own render/bootstrap tests, and NOT_DESKTOP_PATHS) already carries
   *  a real value for all three mlx fields as of the S12a prelude's
   *  forward-consistency commit, so tightening compiles clean
   *  repo-wide; worker A1's paths.rs is expected to land the matching
   *  required `mlx_venv_dir`/`mlx_venv_python`/
   *  `mlx_requirements_lock_path` fields before release (this is a
   *  TS-side type only — it doesn't itself change what a real
   *  `app_paths()` IPC round-trip returns). */
  mlxVenvDir: string;
  /** mlxVenvDir's own venv/bin/python (mac) equivalent — see
   *  mlxVenvDir's doc above. */
  mlxVenvPython: string;
  /** The bundled, hash-pinned `requirements-mlx.lock` resource path
   *  (§C R1's lock strategy — `uv pip compile --generate-hashes`, the
   *  lockfile IS the SBOM) — same "bundled Tauri resource" shape as
   *  `requirementsPath`/`diarRequirementsPath` above. See mlxVenvDir's
   *  doc above. */
  mlxRequirementsLockPath: string;
}

/** {args,env} — exactly what S3 chunk 3's `run_uv(args, env)` command
 *  expects (apps/desktop/src-tauri/src/uv.rs's own arg[0]/env-key
 *  allowlists accept precisely the shapes these builders produce). */
export interface UvCommand {
  args: string[];
  env: Record<string, string>;
}

/** Pin the Python minor uv installs/creates the venv against — single
 *  source of truth reused by provisionMachine.ts's marker-writing (the
 *  `py` field records this same value, not a re-typed copy). */
export const PINNED_PYTHON_MINOR = "3.12";

/** Every uv call carries these four (blueprint's App-data layout
 *  section, verbatim): nothing ever leaks to ~/.local or system Python —
 *  UV_PYTHON_INSTALL_DIR/UV_CACHE_DIR keep both the interpreter and uv's
 *  own download/build cache fully inside this app's app-data dir,
 *  UV_PYTHON_PREFERENCE=only-managed refuses to fall back to whatever
 *  Python the user's system happens to have, and UV_NO_MODIFY_PATH keeps
 *  uv from ever touching a shell rc file — this app always invokes the
 *  venv's own python by absolute path (architecture decision 3), never
 *  relies on $PATH. */
export function uvEnv(paths: DesktopPaths): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir,
    UV_CACHE_DIR: paths.uvCacheDir,
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_MODIFY_PATH: "1",
  };
}

export function pythonInstall(paths: DesktopPaths): UvCommand {
  return { args: ["python", "install", PINNED_PYTHON_MINOR], env: uvEnv(paths) };
}

/** `uv venv <venvDir> --python 3.12 [--clear]` — the base whisper venv's
 *  own CREATE_VENV build step (provisionMachine.ts's STEP_ORDER):
 *  `clear:true` is the RETRY arm (`--clear` wipes and recreates the
 *  target directory instead of erroring on an already-populated one),
 *  used only when a PRIOR attempt already failed — see bootstrap.ts's
 *  own drive() loop (v0.5.1 field-test fix: an app closed mid `uv venv`
 *  leaves a half-written venvDir behind, so a bare retry against it
 *  exits code 2, "a virtual environment already exists", forever), which
 *  self-heals the SAME way bootstrap.ts's own ensureMlxExtras already
 *  does for the separate mlx venv: trying once WITHOUT --clear, then
 *  once WITH it.
 *  `clear` defaults to false (a fresh install never needs it — the
 *  target directory doesn't exist yet). Mirrors venvCreateMlx below —
 *  same opts shape, same doc-comment structure — kept as two separate
 *  functions (not a shared helper) since they target two different
 *  DesktopPaths fields. */
export function venvCreate(paths: DesktopPaths, opts: { clear?: boolean } = {}): UvCommand {
  const args = ["venv", paths.venvDir, "--python", PINNED_PYTHON_MINOR];
  if (opts.clear) args.push("--clear");
  return { args, env: uvEnv(paths) };
}

export function pipInstall(paths: DesktopPaths): UvCommand {
  return {
    args: ["pip", "install", "--python", paths.venvPython, "-r", paths.requirementsPath],
    env: uvEnv(paths),
  };
}

/** v0.4 S5 chunk 0 — installs the optional diarization add-on
 *  (sidecar/requirements-diar.txt, bundled as its own Tauri resource —
 *  see paths.rs's `diar_requirements_path`) into the SAME already-
 *  provisioned venv `pipInstall` targets. A near-clone of `pipInstall`
 *  by design: it rides the exact SAME validated Rust shape (uv.rs's
 *  `validate_uv_args` `pip install --python <venv_python> -r
 *  <requirements>` match arm), and that shape already allows the
 *  requirements operand to resolve under `resource_dir` (not just
 *  `app_data`) — so this needs zero Rust change, only a second bundled
 *  requirements file + this second builder. See docs/design-
 *  explorations/s5-diarization-addon-blueprint.md's Anchors section +
 *  decision B. */
export function pipInstallDiar(paths: DesktopPaths): UvCommand {
  return {
    args: ["pip", "install", "--python", paths.venvPython, "-r", paths.diarRequirementsPath],
    env: uvEnv(paths),
  };
}

// ---------------------------------------------------------------------
// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C R1 +
// Provision) — the separate, hash-locked MLX venv's own builders.
// Unlike pipInstallDiar above (which installs INTO the already-
// provisioned BASE venv), these three target `paths.mlxVenvDir`/
// `mlxVenvPython` — a wholly separate venv (§C F8's redesign: airtight
// isolation from the base whisper venv, no shared numpy/numba pins to
// conflict over). CROSS-LANE CONTRACT pinned for worker A1 (Rust,
// uv.rs's validate_uv_args) at S12a implementation time: venvCreateMlx's
// optional trailing `--clear` arg and pipCheckMlx's new `pip check`
// subcommand shape were both new call shapes run_uv's validator didn't
// accept yet — this file only builds {args,env}; A1's uv.rs grew the
// matching match arms before either could spawn for real. Both landed
// since: uv.rs's own `--clear` match arm validates GENERICALLY (any
// `venv_dir` under app-data, not just the mlx one — `[sub, venv_dir,
// flag, version, clear_flag]`), so the BASE venvCreate() builder above
// picked up the identical optional `{clear}` retry arg (v0.5.1
// field-test self-heal fix — see its own doc comment) with zero further
// Rust changes needed. `uv venv --help`/`uv pip check --help` verified
// live against the same pinned 0.11.28 uv this repo's other builders
// were verified against (see this file's own header comment): `-c,
// --clear` is a bare flag (no value) on `uv venv`; `uv pip check` takes
// `-p/--python <PYTHON>`, no positional operand.
// ---------------------------------------------------------------------

/** `uv venv <mlxVenvDir> --python 3.12 [--clear]` — §C Provision's
 *  transactional venv build step (1): `clear:true` is the RETRY arm
 *  (`--clear` wipes and recreates the target directory instead of
 *  erroring on an already-populated one), used only when a PRIOR
 *  attempt already failed — see bootstrap.ts's own ensureMlxExtras,
 *  which discharges the uv-venv retry-poisoning debt
 *  (V040-VERIFICATION-RUNPLAN.md:35) by trying once WITHOUT --clear,
 *  then once WITH it. `clear` defaults to false (a fresh install never
 *  needs it — the target directory doesn't exist yet). */
export function venvCreateMlx(paths: DesktopPaths, opts: { clear?: boolean } = {}): UvCommand {
  const args = ["venv", paths.mlxVenvDir, "--python", PINNED_PYTHON_MINOR];
  if (opts.clear) args.push("--clear");
  return { args, env: uvEnv(paths) };
}

/** `pip install --python <mlxVenvPython> -r <mlxRequirementsLockPath>`
 *  — §C Provision's transactional venv build step (2): installs the
 *  hash-pinned `requirements-mlx.lock` (§C R1's `uv pip compile
 *  --generate-hashes` lockfile, the SBOM) into the mlx venv just
 *  created by venvCreateMlx above. Named "…Lock" (not a bare
 *  "…Mlx", mirroring pipInstall/pipInstallDiar's own naming) to make
 *  the hash-pinned-lockfile-not-a-loose-.txt distinction explicit at
 *  every call site. */
export function pipInstallMlxLock(paths: DesktopPaths): UvCommand {
  return {
    args: ["pip", "install", "--python", paths.mlxVenvPython, "-r", paths.mlxRequirementsLockPath],
    env: uvEnv(paths),
  };
}

/** `uv pip check --python <mlxVenvPython>` — §C Provision's
 *  transactional venv build step (3)'s second half (alongside the
 *  separate `mlx_import_preflight` Rust command's own real-import
 *  check — see bootstrap.ts's ensureMlxExtras): verifies the mlx
 *  venv's installed packages have no unmet/conflicting dependency
 *  requirements (belt-and-suspenders on top of the lockfile's own
 *  hash-pinned resolution — catches a corrupted/partial install
 *  `pip install`'s own exit code alone might miss). */
export function pipCheckMlx(paths: DesktopPaths): UvCommand {
  return { args: ["pip", "check", "--python", paths.mlxVenvPython], env: uvEnv(paths) };
}

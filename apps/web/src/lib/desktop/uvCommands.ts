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
   *  base whisper venv per §C R1's numba-conflict note). Optional
   *  because paths.rs's `AppPaths` doesn't grow the matching
   *  `mlx_venv_dir` field until worker A1 lands it — a real
   *  `app_paths()` round-trip omits this key entirely until then, so
   *  marking it required here would lie about what's actually on the
   *  wire today. */
  mlxVenvDir?: string;
  /** mlxVenvDir's own venv/bin/python (mac) equivalent — see
   *  mlxVenvDir's doc above for why this stays optional pending worker
   *  A1's paths.rs `mlx_venv_python` field. */
  mlxVenvPython?: string;
  /** The bundled, hash-pinned `requirements-mlx.lock` resource path
   *  (§C R1's lock strategy — `uv pip compile --generate-hashes`, the
   *  lockfile IS the SBOM) — same "bundled Tauri resource" shape as
   *  `requirementsPath`/`diarRequirementsPath` above. Optional pending
   *  worker A1's paths.rs `mlx_requirements_lock_path` field; see
   *  mlxVenvDir's doc above for the same rationale. */
  mlxRequirementsLockPath?: string;
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

export function venvCreate(paths: DesktopPaths): UvCommand {
  return { args: ["venv", paths.venvDir, "--python", PINNED_PYTHON_MINOR], env: uvEnv(paths) };
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

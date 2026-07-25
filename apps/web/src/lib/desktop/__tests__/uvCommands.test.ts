// S3 chunk 4 — pure builder coverage, zero Tauri imports (matches
// provisionMachine.test.ts's own purity contract).
import { describe, expect, it } from "vitest";

import {
  pipCheckMlx,
  pipInstall,
  pipInstallDiar,
  pipInstallMlxLock,
  pythonInstall,
  uvEnv,
  venvCreate,
  venvCreateMlx,
  type DesktopPaths,
} from "../uvCommands";

const paths: DesktopPaths = {
  appData: "/fake/AppData",
  pythonInstallDir: "/fake/AppData/python",
  uvCacheDir: "/fake/AppData/uv-cache",
  venvDir: "/fake/AppData/venv",
  venvPython: "/fake/AppData/venv/bin/python",
  modelsDir: "/fake/AppData/models",
  scriptPath: "/fake/Resources/sidecar/whisper_server.py",
  requirementsPath: "/fake/Resources/sidecar/requirements-sidecar.txt",
  diarRequirementsPath: "/fake/Resources/sidecar/requirements-diar.txt",
  logPath: "/fake/Logs/whisper_server.log",
  markerPath: "/fake/AppData/.provisioned.json",
  mlxVenvDir: "/fake/AppData/mlx-venv",
  mlxVenvPython: "/fake/AppData/mlx-venv/bin/python",
  mlxRequirementsLockPath: "/fake/Resources/sidecar/requirements-mlx.lock",
};

describe("uvEnv", () => {
  it("carries exactly the four blueprint env vars, sourced from the given paths", () => {
    expect(uvEnv(paths)).toEqual({
      UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir,
      UV_CACHE_DIR: paths.uvCacheDir,
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_NO_MODIFY_PATH: "1",
    });
  });

  it("never leaks any other DesktopPaths field into the env", () => {
    expect(Object.keys(uvEnv(paths)).sort()).toEqual(
      ["UV_CACHE_DIR", "UV_NO_MODIFY_PATH", "UV_PYTHON_INSTALL_DIR", "UV_PYTHON_PREFERENCE"].sort(),
    );
  });
});

describe("pythonInstall", () => {
  it("pins the python minor to 3.12 and carries uvEnv(paths)", () => {
    expect(pythonInstall(paths)).toEqual({
      args: ["python", "install", "3.12"],
      env: uvEnv(paths),
    });
  });
});

describe("venvCreate", () => {
  it("targets paths.venvDir with the pinned python minor, no --clear by default", () => {
    expect(venvCreate(paths)).toEqual({
      args: ["venv", paths.venvDir, "--python", "3.12"],
      env: uvEnv(paths),
    });
  });

  it("uses whatever venvDir the given paths carry — never a hardcoded path", () => {
    const other: DesktopPaths = { ...paths, venvDir: "/elsewhere/venv" };
    expect(venvCreate(other).args).toEqual(["venv", "/elsewhere/venv", "--python", "3.12"]);
  });

  // v0.5.1 field-test fix — mirrors venvCreateMlx's own {clear} cases
  // below exactly (same opts shape).
  it("clear:false explicitly is identical to the default (no --clear)", () => {
    expect(venvCreate(paths, { clear: false }).args).toEqual(["venv", paths.venvDir, "--python", "3.12"]);
  });

  it("clear:true appends a trailing --clear flag", () => {
    expect(venvCreate(paths, { clear: true })).toEqual({
      args: ["venv", paths.venvDir, "--python", "3.12", "--clear"],
      env: uvEnv(paths),
    });
  });
});

describe("pipInstall", () => {
  it("installs --python paths.venvPython -r paths.requirementsPath", () => {
    expect(pipInstall(paths)).toEqual({
      args: ["pip", "install", "--python", paths.venvPython, "-r", paths.requirementsPath],
      env: uvEnv(paths),
    });
  });

  it("uses whatever venvPython/requirementsPath the given paths carry — never hardcoded", () => {
    const other: DesktopPaths = {
      ...paths,
      venvPython: "/elsewhere/venv/bin/python",
      requirementsPath: "/elsewhere/requirements-sidecar.txt",
    };
    expect(pipInstall(other).args).toEqual([
      "pip",
      "install",
      "--python",
      "/elsewhere/venv/bin/python",
      "-r",
      "/elsewhere/requirements-sidecar.txt",
    ]);
  });
});

describe("pipInstallDiar", () => {
  it("installs --python paths.venvPython -r paths.diarRequirementsPath", () => {
    expect(pipInstallDiar(paths)).toEqual({
      args: ["pip", "install", "--python", paths.venvPython, "-r", paths.diarRequirementsPath],
      env: uvEnv(paths),
    });
  });

  it("uses whatever venvPython/diarRequirementsPath the given paths carry — never hardcoded", () => {
    const other: DesktopPaths = {
      ...paths,
      venvPython: "/elsewhere/venv/bin/python",
      diarRequirementsPath: "/elsewhere/requirements-diar.txt",
    };
    expect(pipInstallDiar(other).args).toEqual([
      "pip",
      "install",
      "--python",
      "/elsewhere/venv/bin/python",
      "-r",
      "/elsewhere/requirements-diar.txt",
    ]);
  });

  it("targets the same venvPython as pipInstall, but a different requirements file", () => {
    expect(pipInstallDiar(paths).args[3]).toEqual(pipInstall(paths).args[3]);
    expect(pipInstallDiar(paths).args[5]).not.toEqual(pipInstall(paths).args[5]);
  });
});

// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C R1 +
// Provision) — the separate, hash-locked MLX venv's own builders.
describe("venvCreateMlx", () => {
  it("targets paths.mlxVenvDir with the pinned python minor, no --clear by default", () => {
    expect(venvCreateMlx(paths)).toEqual({
      args: ["venv", paths.mlxVenvDir, "--python", "3.12"],
      env: uvEnv(paths),
    });
  });

  it("clear:false explicitly is identical to the default (no --clear)", () => {
    expect(venvCreateMlx(paths, { clear: false }).args).toEqual(["venv", paths.mlxVenvDir, "--python", "3.12"]);
  });

  it("clear:true appends a trailing --clear flag", () => {
    expect(venvCreateMlx(paths, { clear: true })).toEqual({
      args: ["venv", paths.mlxVenvDir, "--python", "3.12", "--clear"],
      env: uvEnv(paths),
    });
  });

  it("uses whatever mlxVenvDir the given paths carry — never a hardcoded path", () => {
    const other: DesktopPaths = { ...paths, mlxVenvDir: "/elsewhere/mlx-venv" };
    expect(venvCreateMlx(other).args).toEqual(["venv", "/elsewhere/mlx-venv", "--python", "3.12"]);
  });

  it("targets a DIFFERENT directory than the base venvCreate — airtight isolation, never the shared base venv", () => {
    expect(venvCreateMlx(paths).args[1]).not.toEqual(venvCreate(paths).args[1]);
  });
});

describe("pipInstallMlxLock", () => {
  it("installs --python paths.mlxVenvPython -r paths.mlxRequirementsLockPath", () => {
    expect(pipInstallMlxLock(paths)).toEqual({
      args: ["pip", "install", "--python", paths.mlxVenvPython, "-r", paths.mlxRequirementsLockPath],
      env: uvEnv(paths),
    });
  });

  it("uses whatever mlxVenvPython/mlxRequirementsLockPath the given paths carry — never hardcoded", () => {
    const other: DesktopPaths = {
      ...paths,
      mlxVenvPython: "/elsewhere/mlx-venv/bin/python",
      mlxRequirementsLockPath: "/elsewhere/requirements-mlx.lock",
    };
    expect(pipInstallMlxLock(other).args).toEqual([
      "pip",
      "install",
      "--python",
      "/elsewhere/mlx-venv/bin/python",
      "-r",
      "/elsewhere/requirements-mlx.lock",
    ]);
  });

  it("targets a DIFFERENT venvPython than pipInstall/pipInstallDiar — the mlx venv, never the base venv", () => {
    expect(pipInstallMlxLock(paths).args[3]).not.toEqual(pipInstall(paths).args[3]);
    expect(pipInstallMlxLock(paths).args[3]).not.toEqual(pipInstallDiar(paths).args[3]);
  });
});

describe("pipCheckMlx", () => {
  it("checks --python paths.mlxVenvPython, no requirements operand", () => {
    expect(pipCheckMlx(paths)).toEqual({
      args: ["pip", "check", "--python", paths.mlxVenvPython],
      env: uvEnv(paths),
    });
  });

  it("uses whatever mlxVenvPython the given paths carry — never hardcoded", () => {
    const other: DesktopPaths = { ...paths, mlxVenvPython: "/elsewhere/mlx-venv/bin/python" };
    expect(pipCheckMlx(other).args).toEqual(["pip", "check", "--python", "/elsewhere/mlx-venv/bin/python"]);
  });
});

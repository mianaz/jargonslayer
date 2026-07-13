// S3 chunk 4 — pure builder coverage, zero Tauri imports (matches
// provisionMachine.test.ts's own purity contract).
import { describe, expect, it } from "vitest";

import {
  pipInstall,
  pipInstallDiar,
  pythonInstall,
  uvEnv,
  venvCreate,
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
  it("targets paths.venvDir with the pinned python minor", () => {
    expect(venvCreate(paths)).toEqual({
      args: ["venv", paths.venvDir, "--python", "3.12"],
      env: uvEnv(paths),
    });
  });

  it("uses whatever venvDir the given paths carry — never a hardcoded path", () => {
    const other: DesktopPaths = { ...paths, venvDir: "/elsewhere/venv" };
    expect(venvCreate(other).args).toEqual(["venv", "/elsewhere/venv", "--python", "3.12"]);
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

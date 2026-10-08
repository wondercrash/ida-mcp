import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  environmentKey,
  preparePythonEnvironment,
} from "./ida-mcp-environment.ts";

async function packageRoot(
  t: test.TestContext,
  name = "pkg",
): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "ida-mcp-environment-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, name);
  await mkdir(root);
  await writeFile(join(root, "pyproject.toml"), '[project]\nname = "x"\n');
  await writeFile(join(root, "uv.lock"), "version = 1\n");
  return { base, root };
}

test("environment key ignores file times", async (t) => {
  const { root } = await packageRoot(t);
  const before = await environmentKey(root);
  const later = new Date(Date.now() + 60_000);
  await utimes(join(root, "pyproject.toml"), later, later);
  await utimes(join(root, "uv.lock"), later, later);
  assert.equal(await environmentKey(root), before);
});

test("environment key follows the inputs that define the environment", async (t) => {
  const { base, root } = await packageRoot(t);
  const keys = new Set([await environmentKey(root)]);
  const changed = async () => {
    const key = await environmentKey(root);
    assert.equal(keys.has(key), false, "each input change needs a new key");
    keys.add(key);
  };

  await writeFile(join(root, "pyproject.toml"), '[project]\nname = "y"\n');
  await changed();
  await writeFile(join(root, "uv.lock"), "version = 2\n");
  await changed();
  await writeFile(join(root, ".python-version"), "3.12\n");
  await changed();
  await writeFile(join(root, ".python-version"), "3.13\n");
  await changed();

  // An identical copy elsewhere is a different editable install target.
  const copy = join(base, "copy");
  await mkdir(copy);
  for (const file of ["pyproject.toml", "uv.lock", ".python-version"]) {
    await writeFile(join(copy, file), await readFile(join(root, file)));
  }
  assert.equal(keys.has(await environmentKey(copy)), false);
});

test("environment key uses the canonical package root", async (t) => {
  const { base, root } = await packageRoot(t);
  const link = join(base, "link");
  await symlink(root, link, "junction");
  assert.equal(await environmentKey(link), await environmentKey(root));
});

test("a ready environment is reused without running uv", async (t) => {
  const { base, root } = await packageRoot(t);
  // Unparseable project metadata: any uv invocation would fail.
  await writeFile(join(root, "pyproject.toml"), "not toml [");
  const cacheRoot = join(base, "cache");
  const directory = join(cacheRoot, "published");
  const python =
    process.platform === "win32"
      ? join(directory, "Scripts", "python.exe")
      : join(directory, "bin", "python");
  await mkdir(join(python, ".."), { recursive: true });
  await writeFile(python, "");
  await writeFile(
    join(cacheRoot, `${await environmentKey(root)}.ready`),
    "published",
  );

  assert.deepEqual(await preparePythonEnvironment(root, { cacheRoot }), {
    directory,
    python,
    prepared: false,
  });
});

test("waiting for another preparation can be abandoned", async (t) => {
  const { base, root } = await packageRoot(t);
  const cacheRoot = join(base, "cache");
  await mkdir(cacheRoot);
  // A live preparation elsewhere holds the lock.
  await writeFile(join(cacheRoot, `${await environmentKey(root)}.lock`), "");

  const controller = new AbortController();
  const preparation = preparePythonEnvironment(root, {
    cacheRoot,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(preparation, { name: "AbortError" });
});

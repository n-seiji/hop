import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TermPort } from "../domain/ports.ts";
import { createFsPort } from "../infra/fs.ts";
import { createGitPort } from "../infra/git.ts";
import { runHop } from "../testing/cli.ts";
import { createTestRepo, type TestRepo } from "../testing/repo.ts";
import { clean, type CleanOptions } from "./clean.ts";
import { jump } from "./jump.ts";

const git = createGitPort();
const fs = createFsPort();

let repo: TestRepo;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  repo = await createTestRepo();
  savedEnv = { ...process.env };
  Object.assign(process.env, repo.env);
});

afterEach(async () => {
  process.env = savedEnv;
  await repo.cleanup();
});

const recordingTerm = (overrides: Partial<TermPort> = {}) => {
  const logs: string[] = [];
  const term: TermPort = {
    isTTY: () => false,
    logStderr: (message) => {
      logs.push(message);
    },
    confirm: () => Promise.resolve(false),
    ...overrides,
  };
  return { term, logs };
};

const cleanOptions = (overrides: Partial<CleanOptions> = {}): CleanOptions => ({
  cwd: repo.repoPath,
  ext: false,
  withBranch: false,
  dryRun: false,
  yes: true,
  ...overrides,
});

const createMergedWorktree = async (branch: string): Promise<string> => {
  await repo.git(["checkout", "-b", branch]);
  await repo.git(["checkout", "main"]);
  await repo.git(["merge", branch]);
  const created = await jump(git, fs, {
    cwd: repo.repoPath,
    target: branch,
    create: true,
  });
  if (created.path === undefined) {
    throw new Error("expected jump to report a path");
  }
  return created.path;
};

const progressLines = (logs: readonly string[]): string[] =>
  logs.filter((line) => line.startsWith("["));

describe("clean の進捗表示 (stderr)", () => {
  it("--yes で 2 つの worktree を削除する場合、削除の直前に [i/N] removing <branch> を順に出す", async () => {
    await createMergedWorktree("feat/first");
    await createMergedWorktree("feat/second");
    const { term, logs } = recordingTerm();

    const result = await clean(git, fs, term, cleanOptions());

    expect(result.ok).toBe(true);
    const order = (result.data?.candidates ?? []).map((candidate) => candidate.branch);
    expect(order.toSorted()).toEqual(["feat/first", "feat/second"]);
    expect(logs).toEqual([`[1/2] removing ${order[0]}`, `[2/2] removing ${order[1]}`]);
    expect(result.data?.removed).toEqual(order);
  });

  it("各行は対応する worktree の削除が始まる時点で出る", async () => {
    await createMergedWorktree("feat/first");
    await createMergedWorktree("feat/second");
    const { term, logs } = recordingTerm();
    const removedWhenLogged: string[][] = [];
    const observingGit = {
      ...git,
      removeWorktree: async (cwd: string, path: string, force: boolean) => {
        removedWhenLogged.push([...logs]);
        await git.removeWorktree(cwd, path, force);
      },
    };

    await clean(observingGit, fs, term, cleanOptions());

    expect(removedWhenLogged.map((seen) => seen.length)).toEqual([1, 2]);
  });

  it("--dry-run の場合、進捗行を出さない", async () => {
    await createMergedWorktree("feat/first");
    await createMergedWorktree("feat/second");
    const { term, logs } = recordingTerm();

    const result = await clean(git, fs, term, cleanOptions({ dryRun: true, yes: false }));

    expect(result.data?.candidates).toHaveLength(2);
    expect(logs).toEqual([]);
  });

  it("削除する候補がない場合、進捗行を出さない", async () => {
    const { term, logs } = recordingTerm();

    const result = await clean(git, fs, term, cleanOptions());

    expect(result.data?.removed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("y/N で確認した場合も、再検証を通った候補だけを数えて進捗行を出す", async () => {
    await createMergedWorktree("feat/first");
    const secondPath = await createMergedWorktree("feat/second");
    const { term, logs } = recordingTerm({
      isTTY: () => true,
      confirm: async () => {
        await writeFile(join(secondPath, "dirty.txt"), "edited after the list was shown");
        return true;
      },
    });

    const result = await clean(git, fs, term, cleanOptions({ yes: false }));

    expect(result.data?.candidates).toHaveLength(2);
    expect(result.data?.removed).toEqual(["feat/first"]);
    expect(progressLines(logs)).toEqual(["[1/1] removing feat/first"]);
    expect(result.warnings).toEqual([`Skipped ${secondPath}: no longer a clean-up candidate.`]);
  });

  it("y/N で拒否した場合、進捗行を出さない", async () => {
    await createMergedWorktree("feat/first");
    const { term, logs } = recordingTerm({
      isTTY: () => true,
      confirm: () => Promise.resolve(false),
    });

    const result = await clean(git, fs, term, cleanOptions({ yes: false }));

    expect(result.data?.removed).toEqual([]);
    expect(progressLines(logs)).toEqual([]);
  });

  it("削除に失敗した候補も削除の直前に進捗行を出し、失敗は従来どおり warning で返す", async () => {
    const failingPath = await createMergedWorktree("feat/fails");
    await createMergedWorktree("feat/ok");
    const { term, logs } = recordingTerm();
    const failingGit = {
      ...git,
      removeWorktree: async (cwd: string, path: string, force: boolean) => {
        if (path === failingPath) {
          throw new Error("refused by git");
        }
        await git.removeWorktree(cwd, path, force);
      },
    };

    const result = await clean(failingGit, fs, term, cleanOptions());

    const order = (result.data?.candidates ?? []).map((candidate) => candidate.branch);
    expect(logs).toEqual([`[1/2] removing ${order[0]}`, `[2/2] removing ${order[1]}`]);
    expect(result.data?.removed).toEqual(["feat/ok"]);
    expect(result.warnings).toEqual([expect.stringContaining(`Failed to remove ${failingPath}`)]);
  });

  it("branch を持たない (detached) candidate の場合、branch の代わりに path を出す", async () => {
    const detachedPath = join(repo.rootDir, "_worktree", "repo", "detached-wt");
    await repo.git(["worktree", "add", "--detach", detachedPath]);
    await rm(detachedPath, { recursive: true, force: true });
    const { term, logs } = recordingTerm();

    const result = await clean(git, fs, term, cleanOptions());

    const [candidate] = result.data?.candidates ?? [];
    expect(candidate?.branch).toBe("");
    expect(logs).toEqual([`[1/1] removing ${candidate?.path}`]);
  });
});

describe("hop clean の stdout / stderr の分離 (CLI プロセス)", () => {
  it("--yes --json の場合、進捗は stderr だけに出て stdout は JSON のままである", async () => {
    await createMergedWorktree("feat/first");
    await createMergedWorktree("feat/second");

    const run = await runHop(["clean", "--yes", "--json"], repo.repoPath, repo.env);

    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout) as {
      command: string;
      data: { candidates: { branch: string }[]; removed: string[] };
    };
    expect(envelope.command).toBe("clean");
    expect(envelope.data.removed).toHaveLength(2);
    const order = envelope.data.candidates.map((candidate) => candidate.branch);
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `[1/2] removing ${order[0]}`,
      `[2/2] removing ${order[1]}`,
    ]);
  });
});

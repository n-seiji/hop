import { afterEach, describe, expect, it } from "bun:test";
import { colorEnabled } from "./term.ts";

describe("colorEnabled", () => {
  const original = process.env["NO_COLOR"];
  afterEach(() => {
    if (original === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = original;
    }
  });

  it("TTY で NO_COLOR が未設定または空の場合、true になる", () => {
    delete process.env["NO_COLOR"];
    expect(colorEnabled({ isTTY: true })).toBe(true);
    process.env["NO_COLOR"] = "";
    expect(colorEnabled({ isTTY: true })).toBe(true);
  });

  it("NO_COLOR が空でない場合、false になる", () => {
    process.env["NO_COLOR"] = "1";
    expect(colorEnabled({ isTTY: true })).toBe(false);
  });

  it("TTY でない場合、false になる", () => {
    delete process.env["NO_COLOR"];
    expect(colorEnabled({ isTTY: false })).toBe(false);
    expect(colorEnabled({})).toBe(false);
  });
});

describe("createTermPort().confirm", () => {
  const TERM_MODULE = new URL("term.ts", import.meta.url).pathname;
  const SCRIPT = `import { createTermPort } from ${JSON.stringify(TERM_MODULE)};
process.stdout.write(String(await createTermPort().confirm("Remove?")));`;

  const answer = async (input: string): Promise<string> => {
    const child = Bun.spawn(["bun", "-e", SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    child.stdin.write(input);
    await child.stdin.end();
    return new Response(child.stdout).text();
  };

  it("y と答えた場合、true になる", async () => {
    expect(await answer("y\n")).toBe("true");
    expect(await answer("Y\n")).toBe("true");
  });

  it("y 以外を答えた場合、false になる", async () => {
    expect(await answer("n\n")).toBe("false");
    expect(await answer("\n")).toBe("false");
  });

  it("答えずに入力が閉じた場合、false になる", async () => {
    expect(await answer("")).toBe("false");
  });
});

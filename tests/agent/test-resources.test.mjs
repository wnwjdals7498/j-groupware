import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runIsolatedTests } from "../../scripts/run-isolated-tests.mjs";

test("isolated job lease rejects concurrent jobs, reaps children and removes only successful job files", async () => {
  const root = await mkdtemp(tmpdir() + "/jgw-job-test-");
  try {
    const first = runIsolatedTests(
      [
        [
          process.execPath,
          "-e",
          "require('fs').writeFileSync(process.env.TMPDIR+'/owned','ok');setTimeout(()=>{},250)",
        ],
      ],
      { root },
    );
    let owner;
    for (let i = 0; i < 100; i++) {
      try {
        owner = JSON.parse(await readFile(root + "/active/owner.json", "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(owner);
    await assert.rejects(
      runIsolatedTests([[process.execPath, "-e", "process.exit(0)"]], { root }),
      { code: "test_resource_busy" },
    );
    assert.equal(await first, 0);
    assert.deepEqual(await readdir(root), []);
    assert.equal(
      await runIsolatedTests(
        [
          [
            process.execPath,
            "-e",
            "require('fs').writeFileSync(process.env.TMPDIR+'/evidence','failure');process.exit(7)",
          ],
        ],
        { root },
      ),
      7,
    );
    const [retained] = await readdir(root);
    assert(retained.startsWith("run-"));
    assert.equal(
      await readFile(root + "/" + retained + "/evidence", "utf8"),
      "failure",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

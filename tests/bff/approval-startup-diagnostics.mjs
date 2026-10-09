// Isolated fixture diagnostics only: classify dependency failures without
// printing SQL, connection options, paths, error messages or credentials.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Server } from "node:net";
const { Pool } = createRequire(
  new URL("../../../j-approval/package.json", import.meta.url),
)("pg");

if (process.env.JAP_TEST_RUNTIME !== "isolated-cloud")
  throw new Error("Isolated approval diagnostic required.");
const record = (phase, error) => {
  const code =
    typeof error?.code === "string" && /^[A-Z0-9_]{3,40}$/.test(error.code)
      ? error.code
      : "UNCLASSIFIED";
  process.stderr.write(
    JSON.stringify({ kind: "approval_fixture_startup", phase, code }) + "\n",
  );
};
const query = Pool.prototype.query;
Pool.prototype.query = function (...args) {
  const result = query.apply(this, args);
  return result && typeof result.catch === "function"
    ? result.catch((error) => {
        record("database", error);
        throw error;
      })
    : result;
};
const read = fs.promises.readFile;
fs.promises.readFile = async function (...args) {
  try {
    return await read.apply(this, args);
  } catch (error) {
    record("private_file", error);
    throw error;
  }
};
syncBuiltinESMExports();
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.prependListener("error", (error) => record("listen", error));
  return listen.apply(this, args);
};

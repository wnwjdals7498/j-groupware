import { readFile, realpath } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  applyGateway,
  envsubst,
  externalPath,
  nginxCommands,
  renderGateway,
} from "./gateway.mjs";

try {
  const [operation, envFile, root, ...extra] = process.argv.slice(2);
  if (
    !["validate", "apply"].includes(operation) ||
    extra.length ||
    !envFile ||
    !root
  )
    throw new Error();
  externalPath(envFile);
  if ((await realpath(envFile)) !== envFile) throw new Error();
  const env = parseEnv(await readFile(envFile, "utf8"));
  const files = await renderGateway(env, root, envsubst);
  const result = await applyGateway(root, files, nginxCommands(root), {
    reload: operation === "apply",
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(
    (error.code?.match(/^[a-z_]+$/) ? error.code : "gateway_failed") + "\n",
  );
  process.exitCode = 1;
}

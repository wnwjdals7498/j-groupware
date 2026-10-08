import { readFileSync } from "node:fs";
import { lookup } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
if (process.env.JGW_TEST_RUNTIME !== "isolated-cloud")
  throw new Error("Test resolver requires isolated cloud.");
const ca = [
  process.env.JAUTH_TLS_CERTIFICATE,
  process.env.JGW_TLS_CERTIFICATE,
].map((file) => readFileSync(file, "utf8"));
if (process.env.JGW_TEST_APPROVAL_CA)
  ca.push(readFileSync(process.env.JGW_TEST_APPROVAL_CA, "utf8"));
setGlobalDispatcher(
  new Agent({
    connect: {
      ca,
      lookup: (host, options, callback) => {
        if (host.endsWith(".jgw.test")) {
          if (options.all)
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        } else lookup(host, options, callback);
      },
    },
  }),
);

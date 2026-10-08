import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
if (process.env.JGW_TEST_RUNTIME !== "isolated-cloud")
  throw new Error("Explicit isolated customer-auth DNS required.");
const original = dns.lookup;
dns.lookup = (host, options, callback) => {
  if (host === "auth.jgw.test") {
    if (typeof options === "function") options(null, "127.0.0.1", 4);
    else if (options?.all)
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  } else original(host, options, callback);
};
syncBuiltinESMExports();

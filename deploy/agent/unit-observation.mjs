import { ProvisionError } from "./provision-error.mjs";
export function parseUnitObservation(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4096)
    throw new ProvisionError("invalid_unit_observation");
  const rows = text.trim().split("\n"),
    result = {};
  for (const row of rows) {
    const equals = row.indexOf("=");
    const name = row.slice(0, equals),
      value = row.slice(equals + 1);
    if (
      equals < 1 ||
      !["LoadState", "FragmentPath", "ActiveState"].includes(name) ||
      Object.hasOwn(result, name) ||
      /[\x00-\x1f]/.test(value)
    )
      throw new ProvisionError("invalid_unit_observation");
    result[name] = value;
  }
  if (
    Object.keys(result).length !== 3 ||
    !["loaded", "not-found"].includes(result.LoadState) ||
    ![
      "active",
      "inactive",
      "failed",
      "activating",
      "deactivating",
      "reloading",
      "refreshing",
    ].includes(result.ActiveState)
  )
    throw new ProvisionError("invalid_unit_observation");
  return result;
}

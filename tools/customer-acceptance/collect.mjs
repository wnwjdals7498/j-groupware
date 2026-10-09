#!/usr/bin/env node
import {
  collectAcceptanceReport,
  loadProfile,
  missingProfileReport,
} from "./collector.mjs";

function profileArgument(argv) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--profile" || !argv[1]) return false;
  return argv[1];
}

async function main(argv) {
  const profilePath = profileArgument(argv);
  if (profilePath === false) {
    process.stdout.write(
      `${JSON.stringify(missingProfileReport("arguments_invalid"), null, 2)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (profilePath === null) {
    process.stdout.write(
      `${JSON.stringify(missingProfileReport(), null, 2)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const loaded = await loadProfile(profilePath);
  if (!loaded.ok) {
    process.stdout.write(
      `${JSON.stringify(missingProfileReport(loaded.code), null, 2)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const report = await collectAcceptanceReport(loaded.profile);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.collectorStatus === "blocked") process.exitCode = 2;
  else if (
    report.serviceResults.some(
      (service) => service.status === "preflight_failed",
    )
  )
    process.exitCode = 1;
}

await main(process.argv.slice(2));

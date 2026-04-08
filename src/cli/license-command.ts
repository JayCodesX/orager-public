/**
 * license-command.ts — CLI handler for `orager license` subcommand.
 *
 * Subcommands:
 *   orager license activate <key>   — activate a license key
 *   orager license status           — show current license tier and details
 *   orager license deactivate       — remove the license key
 */

import {
  getLicenseInfo,
  activateLicense,
  deactivateLicense,
} from "../license.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

function fmtDate(iso: string): string {
  if (!iso) return "none";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ── Subcommand handlers ─────────────────────────────────────────────────────

function handleStatus(): void {
  const info = getLicenseInfo();

  printLine("");
  printLine(`orager license status`);
  printLine(`─────────────────────────────────`);
  printLine(`Tier:    ${info.tier.toUpperCase()}`);
  printLine(`Valid:   ${info.valid ? "yes" : "no"}`);

  if (info.seat) {
    printLine(`Seat:    ${info.seat}`);
  }
  if (info.exp) {
    printLine(`Expires: ${fmtDate(info.exp)}`);
  }
  if (!info.valid && info.reason) {
    printLine(`Reason:  ${info.reason}`);
  }

  if (info.tier === "free") {
    printLine("");
    printLine("The agent works fully in free mode.");
    printLine("Pro features (OMLS, confidence routing, --learn) require a license key.");
    printLine("Activate with: orager license activate <key>");
  }
  printLine("");
}

function handleActivate(argv: string[]): void {
  const key = argv[0];
  if (!key) {
    printErr("Usage: orager license activate <key>");
    process.exit(1);
  }

  const info = activateLicense(key);

  if (info.valid) {
    printLine("");
    printLine(`License activated successfully!`);
    printLine(`Tier:    ${info.tier.toUpperCase()}`);
    printLine(`Seat:    ${info.seat}`);
    printLine(`Expires: ${fmtDate(info.exp)}`);
    printLine("");
  } else {
    printErr("");
    printErr(`License key saved but validation failed: ${info.reason}`);
    printErr("The key has been written to ~/.orager/license.json for inspection.");
    printErr("Please check the key and try again.");
    process.exit(1);
  }
}

function handleDeactivate(): void {
  deactivateLicense();
  printLine("License deactivated. Tier reset to FREE.");
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Entry point for `orager license [subcommand] [args...]`.
 * argv should be the args after "license".
 */
export async function handleLicenseSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "status":
    case undefined:
      handleStatus();
      break;
    case "activate":
      handleActivate(rest);
      break;
    case "deactivate":
    case "remove":
      handleDeactivate();
      break;
    default:
      printLine("Usage: orager license <subcommand>");
      printLine("");
      printLine("Subcommands:");
      printLine("  status               Show current license tier and details");
      printLine("  activate <key>       Activate a license key");
      printLine("  deactivate           Remove the license key");
      printLine("");
      if (sub !== "--help" && sub !== "help") {
        printErr(`Unknown subcommand: '${sub}'`);
        process.exit(1);
      }
      break;
  }
}

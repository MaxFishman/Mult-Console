/*
 * electron-builder afterPack hook.
 *
 * electron-builder leaves the app with the default (broken, linker-only)
 * Electron signature when no Developer ID is available, which macOS reports as
 * "damaged." Re-seal the bundle with a proper ad-hoc signature so the app runs
 * (recipients still right-click → Open once, since it isn't notarized).
 */
const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  try {
    execFileSync("xattr", ["-cr", appPath]);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath]);
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
    console.log(`  • ad-hoc signed and verified  ${appPath}`);
  } catch (err) {
    console.error("  ⨯ afterPack ad-hoc signing failed:", err.message);
    throw err;
  }
};

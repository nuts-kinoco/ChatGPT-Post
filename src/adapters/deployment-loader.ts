/** Explicitly chosen local executable configuration. Never accept its path from an HTTP body.
 * Trust includes all transitive imports; this is equivalent to executing host-owned local code.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export async function openTrustedDeployment<T>(path: string): Promise<T> {
  if (!isAbsolute(path) || !path.endsWith(".mjs")) throw new Error("deployment_path_required");
  const file = resolve(path);
  if ((await realpath(file)) !== file) throw new Error("deployment_symlink_denied");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("deployment_file_untrusted");
  if (process.platform !== "win32") {
    if ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.())
      throw new Error("deployment_file_untrusted");
    let parent = dirname(file);
    for (;;) {
      const directory = await lstat(parent);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.uid !== 0 && directory.uid !== process.getuid?.()) ||
        (directory.mode & 0o022) !== 0
      )
        throw new Error("deployment_directory_untrusted");
      if (parent === dirname(parent)) break;
      parent = dirname(parent);
    }
  } else {
    // A Windows trusted module is an explicit host code execution choice. This loader cannot
    // inspect NTFS ACL inheritance; require the native platform trust verifier before activation.
    throw new Error("deployment_windows_acl_verifier_unavailable");
  }
  const module = (await import(pathToFileURL(file).href)) as { openDeployment?: () => Promise<T> };
  if (typeof module.openDeployment !== "function") throw new Error("deployment_factory_missing");
  return module.openDeployment();
}

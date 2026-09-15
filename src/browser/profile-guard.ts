import { closeSync, openSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export interface ProfileGuardEnv {
  LOCALAPPDATA?: string | undefined;
  APPDATA?: string | undefined;
  HOME?: string | undefined;
}

/** 15-SECURITY §5: canonical paths that must never be automated. */
export function forbiddenProfileRoots(env: ProfileGuardEnv = process.env): string[] {
  const roots: string[] = [];
  if (env.LOCALAPPDATA) {
    roots.push(join(env.LOCALAPPDATA, "Google", "Chrome", "User Data"));
    roots.push(join(env.LOCALAPPDATA, "Microsoft", "Edge", "User Data"));
    roots.push(join(env.LOCALAPPDATA, "Chromium", "User Data"));
  }
  if (env.APPDATA) roots.push(join(env.APPDATA, "Mozilla", "Firefox", "Profiles"));
  if (env.HOME) {
    roots.push(join(env.HOME, ".config", "google-chrome"));
    roots.push(join(env.HOME, ".config", "chromium"));
    roots.push(join(env.HOME, "Library", "Application Support", "Google", "Chrome"));
  }
  return roots;
}

function norm(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function isWithin(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + sep);
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** Walk from `p` up to the volume root; true if any existing component is a symlink/junction. */
async function hasReparsePoint(p: string): Promise<string | null> {
  let current = resolve(p);
  const root = parse(current).root;
  while (true) {
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) return current;
    } catch {
      /* not created yet: keep walking to the parent */
    }
    const parent = dirname(current);
    if (parent === current || norm(current) === norm(root)) break;
    current = parent;
  }
  return null;
}

export type ProfilePathVerdict = { ok: true; canonical: string } | { ok: false; cause: string };

/**
 * FR-015 / Codex F-01: realpath-based comparison against forbidden roots, plus fail-closed
 * rejection of any reparse point (symlink / junction) on the path or its ancestors.
 */
export async function checkProfilePath(
  profileDir: string,
  env: ProfileGuardEnv = process.env,
): Promise<ProfilePathVerdict> {
  const reparse = await hasReparsePoint(profileDir);
  if (reparse)
    return { ok: false, cause: `profile path contains a symlink or junction: ${reparse}` };

  // realpath the deepest existing ancestor (profile dir may not exist yet)
  let probe = resolve(profileDir);
  let suffix: string[] = [];
  let real: string | null = null;
  while (true) {
    real = await safeRealpath(probe);
    if (real !== null) break;
    const parent = dirname(probe);
    if (parent === probe) break;
    suffix = [probe.slice(parent.length + 1), ...suffix];
    probe = parent;
  }
  const canonical = real ? join(real, ...suffix) : resolve(profileDir);

  for (const rootPath of forbiddenProfileRoots(env)) {
    const rootReal = (await safeRealpath(rootPath)) ?? rootPath;
    if (isWithin(canonical, rootReal) || isWithin(canonical, rootPath)) {
      return { ok: false, cause: `profile path points at a regular browser profile: ${rootPath}` };
    }
  }
  return { ok: true, canonical };
}

export type ProfileOccupancy = { free: true } | { free: false; cause: string };

/**
 * 10-ARCHITECTURE §5: Chrome holds `<profile>/lockfile` open exclusively while running.
 * We only open and close it; nothing is read. Absence means free.
 */
export async function checkProfileFree(profileDir: string): Promise<ProfileOccupancy> {
  const lockfile = join(profileDir, "lockfile");
  try {
    await stat(lockfile);
  } catch {
    return { free: true };
  }
  try {
    const fd = openSync(lockfile, "r+");
    closeSync(fd);
    return { free: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      return { free: false, cause: `profile lockfile is held by another process (${code})` };
    }
    return { free: true };
  }
}

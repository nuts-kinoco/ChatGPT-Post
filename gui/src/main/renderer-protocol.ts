import path from "node:path";

export const RENDERER_SCHEME = "bridge-gui";
const RENDERER_HOST = "app";
export const PRODUCTION_RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

export function resolveRendererUrl(isPackaged: boolean, developmentUrl: string | undefined): string {
  return !isPackaged && developmentUrl ? developmentUrl : PRODUCTION_RENDERER_URL;
}

export function rendererFilePath(requestUrl: string, rendererDirectory: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.hostname !== RENDERER_HOST) return null;

  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (requestedPath.includes("\0")) return null;

  const relativeRequestPath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  const pathToServe = path.resolve(rendererDirectory, relativeRequestPath);
  const relativePath = path.relative(rendererDirectory, pathToServe);
  const isSafe = relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  return isSafe ? pathToServe : null;
}

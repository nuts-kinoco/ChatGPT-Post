export function portableExecutablePath(value: string | undefined): string | undefined {
  const portablePath = value?.trim();
  return portablePath || undefined;
}

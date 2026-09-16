export function isSupportedCliNodeVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (
    major >= 24 ||
    (major === 23 && minor >= 5) ||
    (major === 22 && minor >= 13) ||
    (major === 20 && minor >= 17)
  );
}

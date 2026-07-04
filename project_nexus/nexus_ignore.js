import path from "path";

export const DEFAULT_IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "cache",
  "backup",
  ".next",
  ".vite",
  "__pycache__",
  "logs",
  "storage/users",
  "orbitale_memory_data"
];

export const DEFAULT_IGNORE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".svg",
  ".svgz",
  ".bmp",
  ".tif",
  ".tiff",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".flac",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".pdf",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".db3",
  ".log",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".wasm",
  ".pyc",
  ".dat",
  ".dump",
  ".bak",
  ".onnx",
  ".pt",
  ".pth",
  ".safetensors"
];

function normalizeForMatch(filePath) {
  return filePath.split(path.sep).join("/");
}

export function shouldIgnorePath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;

  const normalized = normalizeForMatch(filePath);
  const lower = normalized.toLowerCase();
  const basename = path.basename(lower);
  const extension = path.extname(lower);

  if (DEFAULT_IGNORE_EXTENSIONS.includes(extension)) return true;

  return DEFAULT_IGNORE_DIRS.some((ignoredDir) => {
    const ignored = ignoredDir.toLowerCase();
    return (
      lower === ignored ||
      lower.endsWith(`/${ignored}`) ||
      lower.includes(`/${ignored}/`) ||
      basename === ignored
    );
  });
}

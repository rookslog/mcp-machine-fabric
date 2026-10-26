// Release installer filesystem operations. Node is already required to build;
// using rename here also avoids the GNU/BSD mv symlink-directory differences.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync, renameSync } from "node:fs";
import path from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function entry(root, name) {
  const file = path.join(root, name);
  const stat = lstatSync(file);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return [name, mode, "link", readlinkSync(file)];
  if (stat.isFile()) return [name, mode, "file", hash(readFileSync(file))];
  if (stat.isDirectory()) return [name, mode, "directory"];
  throw new Error(`unsupported file type: ${name}`);
}
function tree(root, prefix = "") {
  return readdirSync(path.join(root, prefix)).sort().flatMap((name) => {
    const relative = path.join(prefix, name);
    const row = entry(root, relative);
    return row[2] === "directory" ? [row, ...tree(root, relative)] : [row];
  });
}
function present(file) {
  // existsSync alone misses dangling symlinks, which must not be overwritten.
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

const [operation, first, second] = process.argv.slice(2);
try {
  if (operation === "source") {
    const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .toString().split("\0").filter(Boolean);
    const rows = [...new Set(names)].sort().map((name) => present(name) ? entry(".", name) : [name, "deleted"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
    console.log(hash(JSON.stringify([head, rows])));
  } else if (operation === "install") {
    if (present(second)) {
      if (!lstatSync(second).isDirectory() || lstatSync(second).isSymbolicLink()
          || JSON.stringify(tree(first)) !== JSON.stringify(tree(second))) {
        throw new Error("existing release differs from candidate; left untouched");
      }
      console.log(`reusing ${second}`);
    } else {
      renameSync(first, second);
    }
  } else if (operation === "switch") {
    if (present(second) && !lstatSync(second).isSymbolicLink()) {
      throw new Error("current exists and is not a symlink; left untouched");
    }
    renameSync(first, second);
  } else {
    throw new Error("unknown release operation");
  }
} catch (error) {
  console.error(`install-release.sh: ${error.message}`);
  process.exit(1);
}

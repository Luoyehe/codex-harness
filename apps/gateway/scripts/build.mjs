import { readdir, readFile, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The package build runs the full protocol-aware typecheck first. Emitting
// source files individually keeps dist/index.js stable while type-only
// imports refer to generated .ts sources outside this package.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src");
const output = path.join(root, "dist");
const checkedRoot = await realpath(root);
try {
  const existingOutput = await realpath(output);
  if (path.dirname(existingOutput) !== checkedRoot || path.basename(existingOutput) !== "dist") {
    throw new Error("refusing to clean dist outside the gateway package");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await rm(output, { recursive: true, force: true });

async function emit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await emit(file); continue; }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    const result = ts.transpileModule(await readFile(file, "utf8"), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true },
    });
    const target = path.join(output, path.relative(source, file).replace(/\.ts$/, ".js"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, result.outputText);
  }
}
await emit(source);

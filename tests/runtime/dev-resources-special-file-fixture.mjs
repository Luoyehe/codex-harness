import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The parent test supplies current source transformed into an isolated folder.
// Keep special-file reads in this disposable process: a regression must not
// exhaust the test runner's filesystem thread pool.
const root = process.cwd();
const { devResource } = await import(pathToFileURL(process.argv[2]));
const baseline = await devResource(root, 'resource/skill/read', { path: path.join(root, 'regular', 'SKILL.md') }, []);
const reads = [];
for (let index = 0; index < 4; index++) {
  reads.push(devResource(root, 'resource/skill/read', { path: path.join(root, `special-${index}`, 'SKILL.md') }, []).then(
    () => ({ rejected: false }), error => ({ rejected: true, code: error.code }),
  ));
  await new Promise(resolve => setTimeout(resolve, 20));
}
const unrelatedFile = await readFile(path.join(root, 'marker.txt'), 'utf8');
console.log(JSON.stringify({ baseline: baseline.text, reads: await Promise.all(reads), unrelatedFile }));

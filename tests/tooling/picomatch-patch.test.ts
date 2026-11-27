import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

type Options = Record<string, unknown>;
type Picomatch = {
  (pattern: string, options?: Options): (name: string) => boolean;
  makeRe(pattern: string, options?: Options): RegExp;
};
// Resolve the real transitive instance used by the test runner, not a copied
// implementation. All subjects below are fixed, short ordinary filenames.
const dependency = createRequire(realpathSync('node_modules/vitest/package.json'));
const picomatch = dependency('picomatch') as Picomatch;
const compile = (pattern: string, options: Options = {}) => picomatch.makeRe(pattern, options);
const matches = (pattern: string, names: string[], options: Options = {}) => {
  if (names.some(name => name.length > 32)) throw Error('Ordinary filename test bound exceeded');
  const match = picomatch(pattern, options);
  // The matcher has an optional second argument; never pass it to Array.filter
  // directly, because filter's index would request a diagnostic result object.
  return names.filter(name => match(name));
};

test.each([
  ['+(*)', '^(?:(?=.)(?:[^/]*?))$'],
  ['*(*)', '^(?:(?=.)(?:[^/]*?)?)$'],
  ['+(*a)', '^(?:(?=.)(?:[^/]*?a))$'],
  ['*(*a)', '^(?:(?=.)(?:[^/]*?a)?)$'],
])('the compiled %s body has no surrounding unbounded repetition', (pattern, source) => {
  expect(compile(pattern!).source).toBe(source);
});

test('shared-prefix or suffix alternatives retain both adjacent literals and optionality', () => {
  const names = ['prea.js.txt', 'preb.ts.txt', 'pre.txt', 'a.js.txt', 'b.ts.txt', 'prea.js', 'preb.ts', 'a.js', 'b.ts'];
  expect(compile('pre+(*.js|*.ts).txt').source).toBe('^(?:pre(?:[^/]*?\\.js|[^/]*?\\.ts)\\.txt)$');
  expect(matches('pre+(*.js|*.ts).txt', names)).toEqual(['prea.js.txt', 'preb.ts.txt']);
  expect(matches('pre*(*.js|*.ts).txt', names)).toEqual(['prea.js.txt', 'preb.ts.txt', 'pre.txt']);
  expect(matches('pre+(a*|b*).txt', ['prea.txt', 'preb.txt', 'prec.txt', 'a.txt', 'preb'])).toEqual(['prea.txt', 'preb.txt']);
});

test('single-segment normalization retains dot, Unicode, bounded wildcards and separator rules', () => {
  expect(matches('+(*a)', ['', 'a', 'ba', 'b', '.a', 'dir/a', 'dir\\a'])).toEqual(['a', 'ba', '.a', 'dir\\a']);
  expect(matches('+(a?*)', ['a', 'ab', 'app', 'b', 'a/file'])).toEqual(['ab', 'app']);
  expect(matches('+(*文件)', ['文件', '新文件', '文件.ts', '目录/文件'])).toEqual(['文件', '新文件']);
  expect(matches('+(*.js)', ['.js', 'app.js', 'app.ts', 'src/app.js'], { dot: true })).toEqual(['.js', 'app.js']);
  expect(matches('pre*(*a).txt', ['pre.txt', 'prea.txt', 'preb.txt'])).toEqual(['pre.txt', 'prea.txt']);
});

test.each([false, 0, 1, 100])('the new repeat guard remains active with recursion setting %s', maxExtglobRecursion => {
  expect(compile('+(*a)', { maxExtglobRecursion }).source).toBe('^(?:(?=.)(?:[^/]*?a))$');
  expect(() => compile('+(*a|b)', { maxExtglobRecursion })).toThrow(expect.objectContaining({ code: 'PICOMATCH_UNSAFE_REPEAT' }));
});

test.each(['+(*a|b)', '+(a*.js|b*.ts)', '+(@(a|b))', '+([ab]*)', '+(dir/*a)', '+(a{1,3})', '+(*\\(a)'])('unsupported variable-length body %s is rejected during compilation', pattern => {
  // Compilation only: no subject is submitted to these unsupported expressions.
  expect(() => compile(pattern, { maxExtglobRecursion: false })).toThrow(expect.objectContaining({ code: 'PICOMATCH_UNSAFE_REPEAT' }));
});

test('escaped literals and fixed-width bodies are not mistaken for variable repetition', () => {
  expect(compile('+(\\(?a)').source).toBe('^(?:(?=.)(?:\\([^/]a)+)$');
  expect(compile('+(\\*)').source).toContain('\\*');
});

test.each([{ capture: true }, { capture: 1 }, { bash: true }])('unsupported repeat options fail explicitly while ordinary matching is preserved: %j', options => {
  expect(() => compile('+(*a)', options)).toThrow(expect.objectContaining({ code: 'PICOMATCH_UNSAFE_REPEAT' }));
  expect(matches('+(foo|bar)', ['foo', 'bar', 'foobar', 'file'], options)).toEqual(['foo', 'bar', 'foobar']);
  expect(compile('*.js', options).test('app.js')).toBe(true);
});

test('ordinary extglobs, upstream safe reductions and build-tool glob syntax remain available', () => {
  const names = ['foo', 'bar', 'foobar', 'file'];
  expect(matches('+(foo|bar)', names)).toEqual(['foo', 'bar', 'foobar']);
  expect(matches('@(foo|bar)', names)).toEqual(['foo', 'bar']);
  expect(matches('?(foo|bar)', names)).toEqual(['foo', 'bar']);
  expect(matches('+(*(a)|*(b))', ['a', 'b', 'ab', 'file'])).toEqual(['a', 'b', 'ab']);
  expect(matches('**/*.{js,ts}', ['app.js', 'src/app.ts', 'app.css', '.env'])).toEqual(['app.js', 'src/app.ts']);
  expect(matches('**/node_modules/**', ['node_modules/a.js', 'src/node_modules/b.js', 'src/app.js'])).toEqual(['node_modules/a.js', 'src/node_modules/b.js']);
  expect(matches('+(foo|bar)', names, { noextglob: true })).toEqual([]);
  expect(() => compile('+(file)', { maxLength: 4 })).toThrow(/Input length/);
});

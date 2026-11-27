"""Select the Harness inputs from a freshly generated, pinned Codex protocol.

Usage: python3 reference/select-protocol.py <generated-dir> <empty-output-dir>
The generated directory contains json/ and ts/. Run from any working directory.
"""
import argparse
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = 'codex_app_server_protocol.v2.schemas.json'
# Runtime composes these validation names from the selected operation. Literal
# names in implementations and the protocol responses they reference are discovered below.
DYNAMIC = {
    'Project': ('Create', 'Update', 'Delete', 'Move', 'Import'),
    'ThreadSection': ('Create', 'Update', 'Delete'),
}
LITERAL = re.compile(r"""['"]([A-Z][A-Za-z0-9_]*)['"]""")
TS_IMPORT = re.compile(r"""\b(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]""")


def schema_references(value):
    if isinstance(value, list):
        for child in value:
            yield from schema_references(child)
    elif isinstance(value, dict):
        for key, child in value.items():
            if key == '$ref':
                prefix = '#/definitions/'
                if not isinstance(child, str) or not child.startswith(prefix) or '/' in child[len(prefix):]:
                    raise ValueError(f'Unexpected schema reference: {child}')
                yield child[len(prefix):]
            else:
                yield from schema_references(child)


def select_definitions(generated, output):
    document = json.loads((generated / 'json' / BUNDLE).read_text())
    definitions = document['definitions']
    standalone = {path.stem for path in (generated / 'json').glob('*.json')}
    literals = set()
    for source in (ROOT / 'src').rglob('*.ts'):
        literals.update(LITERAL.findall(source.read_text()))
    roots = literals & (standalone | definitions.keys())
    # Realtime and attachment code use literal operation prefixes. The project
    # and section dispatchers build theirs from the method's action.
    prefixes = literals | {family + action for family, actions in DYNAMIC.items() for action in actions}
    for suffix in ('Params', 'Response'):
        roots.update(name for prefix in prefixes if (name := prefix + suffix) in definitions or name in standalone)

    dest = output / 'json'
    dest.mkdir()
    for name in sorted(roots - definitions.keys()):
        shutil.copyfile(generated / 'json' / (name + '.json'), dest / (name + '.json'))
    needed = set()
    pending = list(roots & definitions.keys())
    while pending:
        name = pending.pop()
        if name in needed:
            continue
        needed.add(name)
        pending.extend(schema_references(definitions[name]))
    document['definitions'] = {name: value for name, value in definitions.items() if name in needed}
    (dest / BUNDLE).write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n')
    return len(needed)


def select_types(generated, output):
    source_root = generated / 'ts'
    pending = []
    for directory in ('src', 'web', 'tests'):
        for source in (ROOT / directory).rglob('*.ts*'):
            if source.suffix not in ('.ts', '.tsx') or 'node_modules' in source.parts or 'dist' in source.parts:
                continue
            for name in TS_IMPORT.findall(source.read_text()):
                if '/protocol/ts/' in name:
                    pending.append(name.split('/protocol/ts/', 1)[1])
    visited = set()
    while pending:
        relative = Path(pending.pop()).with_suffix('.ts')
        file = (source_root / relative).resolve(strict=True)
        relative = file.relative_to(source_root)
        if relative in visited:
            continue
        visited.add(relative)
        dest = output / 'ts' / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, dest)
        for name in TS_IMPORT.findall(file.read_text()):
            if name.startswith('.'):
                pending.append(relative.parent / name)
    return len(visited)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('generated', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    generated, output = args.generated.resolve(strict=True), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error('output directory must be empty')
    definitions = select_definitions(generated, output)
    types = select_types(generated, output)
    print(f'{definitions} bundled definitions, {len(list((output / "json").glob("*.json"))) - 1} standalone schemas, {types} TypeScript files')


if __name__ == '__main__':
    main()

"""Emit reverse static dependencies between deployment tests without importing their code."""
import ast
import json
import sys
from pathlib import Path


def reverse_imports(root):
    modules = {'.'.join(path.relative_to(root).with_suffix('').parts): path
               for path in sorted((root / 'tests/deploy').rglob('test_*.py'))}
    dependents = {}
    for module, path in modules.items():
        referenced = set()
        for node in ast.walk(ast.parse(path.read_bytes(), filename=str(path))):
            if isinstance(node, ast.Import):
                referenced.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                prefix = node.module or ''
                if node.level:
                    package = module.split('.')[:-node.level]
                    prefix = '.'.join(package + ([prefix] if prefix else []))
                referenced.add(prefix)
                referenced.update(prefix + '.' + alias.name for alias in node.names)
        for dependency in sorted(referenced.intersection(modules) - {module}):
            source = modules[dependency].relative_to(root).as_posix()
            dependents.setdefault(source, []).append(path.relative_to(root).as_posix())
    return dependents


if __name__ == '__main__':
    print(json.dumps(reverse_imports(Path(sys.argv[1])), sort_keys=True))

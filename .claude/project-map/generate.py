#!/usr/bin/env python3
"""
generate.py — Babel Fish
Stack-agnostic introspection script for the babel-fish codebase mapper plugin.
Produces a split-section project map under .claude/project-map/sections/

Usage:
    python generate.py [--force] [--project-root PATH] [--stack-json PATH]
"""
from __future__ import annotations

import ast
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# ── Try optional deps ────────────────────────────────────────────────────────
try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).parent
MAP_DIR      = SCRIPT_DIR
SECTIONS_DIR = MAP_DIR / "sections"
CHECKSUMS    = MAP_DIR / "checksums.json"
LEARNED_VOC  = MAP_DIR / "learned-vocabulary.json"

# Resolve project root: two levels up from .claude/project-map/
PROJECT_ROOT = MAP_DIR.parent.parent

SECTIONS_DIR.mkdir(parents=True, exist_ok=True)

# ── Secrets guard ────────────────────────────────────────────────────────────
SECRET_PATTERNS = re.compile(
    r'(?i)(password|secret|token|api_key|apikey|private_key|auth_token|'
    r'access_key|secret_key|client_secret|db_pass|database_password|'
    r'stripe_key|twilio_auth|sendgrid_key|aws_secret)\s*[=:]\s*\S+'
)

def redact_secrets(text: str) -> str:
    return SECRET_PATTERNS.sub(r'[REDACTED]', text)


# ── Checksum logic ───────────────────────────────────────────────────────────
WATCHED_EXTENSIONS = {
    '.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.java', '.kt',
    '.yaml', '.yml', '.toml', '.json', '.prisma', '.sql', '.env',
}
WATCHED_NAMES = {
    'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.dev.yml',
    'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod',
    'Cargo.toml', 'pom.xml', 'Gemfile', 'Makefile',
}
IGNORE_DIRS = {
    '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
    'dist', 'build', '.next', '.nuxt', 'target', 'vendor', '.cache',
    '.claude', '.planning',
}

def collect_watched_files() -> list[Path]:
    result = []
    for path in sorted(PROJECT_ROOT.rglob('*')):
        if any(p in IGNORE_DIRS for p in path.parts):
            continue
        if path.is_file() and (path.suffix in WATCHED_EXTENSIONS or path.name in WATCHED_NAMES):
            result.append(path)
    return result

def compute_checksum(files: list[Path]) -> str:
    h = hashlib.sha256()
    for f in files:
        h.update(str(f).encode())
        try:
            h.update(str(f.stat().st_mtime_ns).encode())
        except OSError:
            pass
    return h.hexdigest()

def load_checksums() -> dict:
    if CHECKSUMS.exists():
        try:
            return json.loads(CHECKSUMS.read_text())
        except Exception:
            pass
    return {}

def save_checksums(data: dict) -> None:
    CHECKSUMS.write_text(json.dumps(data, indent=2))

def is_unchanged(checksum: str) -> bool:
    stored = load_checksums()
    return stored.get('input_hash') == checksum


# ── Stack detection (reads stack.json if present, else fallback) ─────────────
def load_stack(stack_json_path: Path | None = None) -> dict:
    candidates = [
        stack_json_path,
        MAP_DIR / "stack.json",
        PROJECT_ROOT / ".claude" / "stack.json",
    ]
    for path in candidates:
        if path and path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                pass
    return {
        "name": PROJECT_ROOT.name,
        "slug": re.sub(r'[^a-z0-9]', '-', PROJECT_ROOT.name.lower()).strip('-'),
        "language": "unknown",
        "framework": "unknown",
        "database": "unknown",
        "orm": "unknown",
        "auth": "unknown",
        "package_manager": "unknown",
        "infrastructure": "none",
        "project_root": str(PROJECT_ROOT),
    }


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PARSERS                                                                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝

# ── Python / FastAPI / Django / Flask ────────────────────────────────────────

class PythonRouteParser:
    """Extract routes from Python routers using ast."""

    DECORATOR_PATTERNS = re.compile(
        r'@(router|app|api_router|blueprint)\.(get|post|put|patch|delete|head|options|websocket)\s*\('
    )

    def parse(self, files: list[Path]) -> list[dict]:
        routes = []
        for f in files:
            if f.suffix != '.py':
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
                tree = ast.parse(source, filename=str(f))
                routes.extend(self._extract_routes(tree, f, source))
            except SyntaxError:
                pass
        return routes

    def _extract_routes(self, tree: ast.AST, filepath: Path, source: str) -> list[dict]:
        routes = []
        lines = source.splitlines()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                info = self._parse_decorator(decorator, lines, node.lineno)
                if info:
                    info['file'] = str(filepath.relative_to(PROJECT_ROOT))
                    info['line'] = node.lineno
                    info['function'] = node.name
                    routes.append(info)
        return routes

    def _parse_decorator(self, decorator: ast.expr, lines: list[str], lineno: int) -> dict | None:
        if isinstance(decorator, ast.Call):
            func = decorator.func
            if isinstance(func, ast.Attribute) and func.attr in (
                'get','post','put','patch','delete','head','options','websocket'
            ):
                method = func.attr.upper()
                path = ''
                if decorator.args:
                    arg = decorator.args[0]
                    if isinstance(arg, ast.Constant):
                        path = str(arg.value)
                return {'method': method, 'path': path}
        return None


class PythonModelParser:
    """Extract SQLAlchemy / Django ORM models using ast."""

    def parse(self, files: list[Path]) -> list[dict]:
        models = []
        for f in files:
            if f.suffix != '.py':
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
                tree = ast.parse(source, filename=str(f))
                models.extend(self._extract_models(tree, f))
            except SyntaxError:
                pass
        return models

    def _extract_models(self, tree: ast.AST, filepath: Path) -> list[dict]:
        models = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            bases = [self._base_name(b) for b in node.bases]
            is_model = any(
                b in ('Base', 'Model', 'BaseModel', 'DeclarativeBase', 'AbstractModel')
                or 'Model' in b
                for b in bases if b
            )
            if not is_model:
                continue
            columns = self._extract_columns(node)
            models.append({
                'name': node.name,
                'file': str(filepath.relative_to(PROJECT_ROOT)),
                'line': node.lineno,
                'bases': bases,
                'columns': columns,
            })
        return models

    def _base_name(self, node: ast.expr) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return ''

    def _extract_columns(self, class_node: ast.ClassDef) -> list[dict]:
        cols = []
        for node in ast.walk(class_node):
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                cols.append({
                    'name': node.target.id,
                    'type': ast.unparse(node.annotation) if hasattr(ast, 'unparse') else '?',
                })
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        if isinstance(node.value, ast.Call):
                            func_name = ''
                            if isinstance(node.value.func, ast.Name):
                                func_name = node.value.func.id
                            elif isinstance(node.value.func, ast.Attribute):
                                func_name = node.value.func.attr
                            if func_name in ('Column', 'Field', 'CharField', 'IntegerField',
                                             'TextField', 'BooleanField', 'ForeignKey',
                                             'ManyToManyField', 'DateTimeField', 'mapped_column'):
                                cols.append({'name': target.id, 'type': func_name})
        return cols


class PythonSchemaParser:
    """Extract Pydantic schemas / Django serializers using ast."""

    def parse(self, files: list[Path]) -> list[dict]:
        schemas = []
        for f in files:
            if f.suffix != '.py':
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
                tree = ast.parse(source, filename=str(f))
                schemas.extend(self._extract_schemas(tree, f))
            except SyntaxError:
                pass
        return schemas

    def _extract_schemas(self, tree: ast.AST, filepath: Path) -> list[dict]:
        schemas = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            bases = [self._base_name(b) for b in node.bases]
            is_schema = any(
                b in ('BaseModel', 'Schema', 'Serializer', 'ModelSerializer',
                       'TypedDict', 'NamedTuple')
                or 'Schema' in b or 'Serializer' in b
                for b in bases if b
            )
            if not is_schema:
                continue
            fields = [
                n.target.id
                for n in ast.walk(node)
                if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)
            ]
            schemas.append({
                'name': node.name,
                'file': str(filepath.relative_to(PROJECT_ROOT)),
                'line': node.lineno,
                'fields': fields,
            })
        return schemas

    def _base_name(self, node: ast.expr) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return ''


# ── TypeScript / JavaScript ──────────────────────────────────────────────────

class TSRouteParser:
    """Extract routes from Next.js, Express, NestJS via regex."""

    NEXT_APP_ROUTE   = re.compile(r'export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(')
    NEXT_PAGES_ROUTE = re.compile(r'export\s+default\s+(?:async\s+)?function\s+handler')
    EXPRESS_ROUTE    = re.compile(r'(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*[\'"]([^\'"]+)[\'"]')
    NEST_DECORATOR   = re.compile(r'@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:[\'"]([^\'"]*)[\'"])?\s*\)')

    def parse(self, files: list[Path]) -> list[dict]:
        routes = []
        for f in files:
            if f.suffix not in ('.ts', '.tsx', '.js', '.jsx'):
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
            except Exception:
                continue
            rel = str(f.relative_to(PROJECT_ROOT))

            # Next.js App Router
            for m in self.NEXT_APP_ROUTE.finditer(source):
                line = source[:m.start()].count('\n') + 1
                path = self._infer_next_path(f)
                routes.append({'method': m.group(1), 'path': path, 'file': rel, 'line': line})

            # Express
            for m in self.EXPRESS_ROUTE.finditer(source):
                line = source[:m.start()].count('\n') + 1
                routes.append({'method': m.group(1).upper(), 'path': m.group(2), 'file': rel, 'line': line})

            # NestJS
            for m in self.NEST_DECORATOR.finditer(source):
                line = source[:m.start()].count('\n') + 1
                routes.append({'method': m.group(1).upper(), 'path': m.group(2) or '/', 'file': rel, 'line': line})

        return routes

    def _infer_next_path(self, f: Path) -> str:
        """Infer URL path from Next.js file location."""
        parts = f.parts
        try:
            # app router: after 'app/'
            app_idx = parts.index('app') if 'app' in parts else None
            if app_idx:
                seg = parts[app_idx+1:]
                seg = [s for s in seg if not s.startswith('(') and s not in ('route.ts','route.js','page.tsx','page.ts')]
                return '/' + '/'.join(seg) if seg else '/'
            # pages router
            pages_idx = parts.index('pages') if 'pages' in parts else None
            if pages_idx:
                seg = list(parts[pages_idx+1:])
                seg[-1] = re.sub(r'\.(ts|tsx|js|jsx)$', '', seg[-1])
                if seg[-1] in ('index',):
                    seg = seg[:-1]
                return '/' + '/'.join(seg) if seg else '/'
        except (ValueError, IndexError):
            pass
        return f'/{f.stem}'


class TSModelParser:
    """Extract Prisma schema entities and TypeORM entities via regex."""

    PRISMA_MODEL  = re.compile(r'^model\s+(\w+)\s*\{([^}]+)\}', re.MULTILINE)
    PRISMA_FIELD  = re.compile(r'^\s+(\w+)\s+(\w+)', re.MULTILINE)
    TYPEORM_ENTITY = re.compile(r'@Entity\s*\(')
    CLASS_NAME    = re.compile(r'class\s+(\w+)')

    def parse(self, files: list[Path]) -> list[dict]:
        models = []
        for f in files:
            rel = str(f.relative_to(PROJECT_ROOT))
            # Prisma
            if f.suffix == '.prisma':
                try:
                    source = f.read_text(encoding='utf-8', errors='replace')
                    for m in self.PRISMA_MODEL.finditer(source):
                        fields = [
                            {'name': fm.group(1), 'type': fm.group(2)}
                            for fm in self.PRISMA_FIELD.finditer(m.group(2))
                        ]
                        models.append({'name': m.group(1), 'file': rel, 'columns': fields})
                except Exception:
                    pass
            # TypeORM / NestJS entities
            elif f.suffix in ('.ts', '.tsx'):
                try:
                    source = f.read_text(encoding='utf-8', errors='replace')
                    if self.TYPEORM_ENTITY.search(source):
                        cm = self.CLASS_NAME.search(source)
                        if cm:
                            models.append({'name': cm.group(1), 'file': rel, 'columns': []})
                except Exception:
                    pass
        return models


# ── Go ───────────────────────────────────────────────────────────────────────

class GoRouteParser:
    GIN    = re.compile(r'(?:router|r|v\d+|api)\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"')
    CHI    = re.compile(r'r\.(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"')
    STD    = re.compile(r'(?:mux|http)\.HandleFunc\s*\(\s*"([^"]+)"')

    def parse(self, files: list[Path]) -> list[dict]:
        routes = []
        for f in files:
            if f.suffix != '.go':
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
            except Exception:
                continue
            rel = str(f.relative_to(PROJECT_ROOT))
            for m in self.GIN.finditer(source):
                line = source[:m.start()].count('\n') + 1
                routes.append({'method': m.group(1), 'path': m.group(2), 'file': rel, 'line': line})
            for m in self.CHI.finditer(source):
                line = source[:m.start()].count('\n') + 1
                routes.append({'method': m.group(1).upper(), 'path': m.group(2), 'file': rel, 'line': line})
            for m in self.STD.finditer(source):
                line = source[:m.start()].count('\n') + 1
                routes.append({'method': 'ANY', 'path': m.group(1), 'file': rel, 'line': line})
        return routes


class GoModelParser:
    STRUCT = re.compile(r'type\s+(\w+)\s+struct\s*\{([^}]+)\}', re.DOTALL)
    FIELD  = re.compile(r'^\s+(\w+)\s+(\S+)', re.MULTILINE)

    def parse(self, files: list[Path]) -> list[dict]:
        models = []
        for f in files:
            if f.suffix != '.go':
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
            except Exception:
                continue
            rel = str(f.relative_to(PROJECT_ROOT))
            for m in self.STRUCT.finditer(source):
                # Only include structs that look like data models (have db/json tags)
                body = m.group(2)
                if 'db:' in body or 'json:' in body or 'gorm:' in body:
                    fields = [
                        {'name': fm.group(1), 'type': fm.group(2)}
                        for fm in self.FIELD.finditer(body)
                        if not fm.group(1).startswith('//')
                    ]
                    models.append({'name': m.group(1), 'file': rel, 'columns': fields})
        return models


# ── Docker Compose ───────────────────────────────────────────────────────────

class DockerComposeParser:
    def parse(self) -> list[dict]:
        services = []
        candidates = [
            'docker-compose.yml', 'docker-compose.yaml',
            'docker-compose.dev.yml', 'docker-compose.development.yml',
            'docker-compose.prod.yml', 'docker-compose.production.yml',
        ]
        for name in candidates:
            path = PROJECT_ROOT / name
            if not path.exists():
                continue
            try:
                data = self._load(path)
                if data and isinstance(data.get('services'), dict):
                    for svc_name, svc in data['services'].items():
                        services.append({
                            'name': svc_name,
                            'image': svc.get('image', svc.get('build', '(build)')),
                            'ports': svc.get('ports', []),
                            'depends_on': svc.get('depends_on', []),
                            'environment_keys': list(svc.get('environment', {}).keys())
                                if isinstance(svc.get('environment'), dict)
                                else [],
                            'source_file': name,
                        })
            except Exception:
                pass
        return services

    def _load(self, path: Path) -> dict | None:
        text = path.read_text(encoding='utf-8', errors='replace')
        if HAS_YAML:
            return yaml.safe_load(text)
        # Regex fallback: extract service names at minimum
        services: dict = {'services': {}}
        in_services = False
        indent = 0
        for line in text.splitlines():
            if re.match(r'^services\s*:', line):
                in_services = True
                continue
            if in_services:
                m = re.match(r'^(\s+)(\w[\w-]*)\s*:', line)
                if m:
                    lvl = len(m.group(1))
                    if indent == 0:
                        indent = lvl
                    if lvl == indent:
                        services['services'][m.group(2)] = {}
        return services


# ── Env Parser ───────────────────────────────────────────────────────────────

class EnvParser:
    SECRET_KEYS = re.compile(
        r'(?i)(password|secret|token|key|auth|credential|private|cert)'
    )

    def parse(self) -> list[dict]:
        entries = []
        candidates = ['.env', '.env.example', '.env.local', '.env.development', '.env.sample']
        for name in candidates:
            path = PROJECT_ROOT / name
            if not path.exists():
                continue
            for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line:
                    continue
                key, _, raw_val = line.partition('=')
                key = key.strip()
                val = raw_val.strip()
                is_secret = bool(self.SECRET_KEYS.search(key))
                entries.append({
                    'key': key,
                    'value': '[SECRET]' if is_secret else val[:80],
                    'is_secret': is_secret,
                    'source': name,
                })
        return entries


# ── Migration Parser ─────────────────────────────────────────────────────────

class MigrationParser:
    def parse(self) -> list[dict]:
        migrations = []
        # Alembic
        alembic_dirs = list(PROJECT_ROOT.rglob('versions'))
        for d in alembic_dirs:
            if not d.is_dir():
                continue
            for f in sorted(d.glob('*.py')):
                try:
                    source = f.read_text(encoding='utf-8', errors='replace')
                    rev = re.search(r'revision\s*=\s*[\'"]([^\'"]+)[\'"]', source)
                    down = re.search(r'down_revision\s*=\s*[\'"]?([^\'")\n]+)[\'"]?', source)
                    msg = re.search(r'Create Date.*\n.*"""(.+?)"""', source, re.DOTALL)
                    tables = re.findall(r'op\.(?:create_table|drop_table|add_column)\s*\(\s*[\'"]([^\'"]+)[\'"]', source)
                    migrations.append({
                        'revision': rev.group(1) if rev else f.stem,
                        'down_revision': down.group(1).strip() if down else None,
                        'tables_affected': list(set(tables)),
                        'file': str(f.relative_to(PROJECT_ROOT)),
                        'type': 'alembic',
                    })
                except Exception:
                    pass

        # SQL files
        for f in sorted(PROJECT_ROOT.rglob('*.sql')):
            if any(p in IGNORE_DIRS for p in f.parts):
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')[:2000]
                tables = re.findall(r'(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)', source, re.IGNORECASE)
                if tables:
                    migrations.append({
                        'revision': f.stem,
                        'tables_affected': list(set(tables)),
                        'file': str(f.relative_to(PROJECT_ROOT)),
                        'type': 'sql',
                    })
            except Exception:
                pass

        return migrations


# ── Frontend Feature Scanner ─────────────────────────────────────────────────

class FrontendScanner:
    FEATURE_DIRS = {'features', 'pages', 'views', 'screens', 'modules', 'app'}
    COMPONENT_EXTS = {'.tsx', '.jsx'}
    HOOK_PATTERN = re.compile(r'^use[A-Z]')

    def scan(self) -> list[dict]:
        features = []
        for feat_dir_name in self.FEATURE_DIRS:
            feat_dir = PROJECT_ROOT / feat_dir_name
            if not feat_dir.exists():
                # try nested src/
                feat_dir = PROJECT_ROOT / 'src' / feat_dir_name
            if not feat_dir.is_dir():
                continue
            for entry in sorted(feat_dir.iterdir()):
                if entry.is_dir() and not entry.name.startswith('.'):
                    stats = self._scan_feature_dir(entry)
                    stats['name'] = entry.name
                    stats['path'] = str(entry.relative_to(PROJECT_ROOT))
                    features.append(stats)
        return features

    def _scan_feature_dir(self, d: Path) -> dict:
        components, hooks, stores, api_files = [], [], [], []
        for f in d.rglob('*'):
            if f.suffix in self.COMPONENT_EXTS:
                if self.HOOK_PATTERN.match(f.stem):
                    hooks.append(f.name)
                else:
                    components.append(f.name)
            elif 'store' in f.name.lower() or 'slice' in f.name.lower():
                stores.append(f.name)
            elif 'api' in f.name.lower() or 'service' in f.name.lower() or 'client' in f.name.lower():
                api_files.append(f.name)
        return {
            'components': components,
            'hooks': hooks,
            'stores': stores,
            'api_files': api_files,
            'component_count': len(components),
            'hook_count': len(hooks),
        }


# ── Import Chain Tracer ───────────────────────────────────────────────────────

class ImportChainTracer:
    MAX_DEPTH = 5

    def trace(self, routes: list[dict]) -> list[dict]:
        chains = []
        for route in routes[:30]:  # limit to first 30 routes
            f = PROJECT_ROOT / route.get('file', '')
            if not f.exists() or f.suffix != '.py':
                continue
            chain = self._trace_file(f, depth=0)
            if len(chain) > 1:
                chains.append({
                    'route': f"{route.get('method','?')} {route.get('path','?')}",
                    'chain': ' → '.join(chain),
                    'file': route.get('file'),
                })
        return chains

    def _trace_file(self, f: Path, depth: int) -> list[str]:
        if depth > self.MAX_DEPTH or not f.exists():
            return []
        result = [str(f.relative_to(PROJECT_ROOT))]
        try:
            source = f.read_text(encoding='utf-8', errors='replace')
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    if isinstance(node, ast.ImportFrom) and node.module:
                        # Attempt to resolve local import
                        parts = node.module.split('.')
                        candidate = PROJECT_ROOT / Path(*parts).with_suffix('.py')
                        if candidate.exists() and depth < self.MAX_DEPTH:
                            sub = self._trace_file(candidate, depth + 1)
                            if sub:
                                result.extend(sub[1:])
                                break
        except Exception:
            pass
        return result


# ── Vocabulary Builder ────────────────────────────────────────────────────────

class VocabularyBuilder:
    SKIP_WORDS = {'index', 'main', 'base', 'common', 'utils', 'helpers', 'types',
                  'constants', 'config', 'lib', 'api', 'app', 'src', 'test', 'tests'}

    def build(
        self,
        routes: list[dict],
        models: list[dict],
        schemas: list[dict],
        features: list[dict],
        stack: dict,
    ) -> list[dict]:
        vocab: dict[str, dict] = {}

        # From features
        for feat in features:
            name = feat['name']
            if name.lower() in self.SKIP_WORDS:
                continue
            aliases = self._name_to_aliases(name)
            for alias in aliases:
                self._add(vocab, alias, 'feature', feat.get('path', ''), f"{feat['component_count']} components")

        # From models
        for model in models:
            aliases = self._name_to_aliases(model['name'])
            for alias in aliases:
                self._add(vocab, alias, 'model', model.get('file', ''), f"table/model: {model['name']}")

        # From routes (group by path prefix)
        route_groups: dict[str, list] = {}
        for route in routes:
            prefix = route.get('path', '/').split('/')[1] if '/' in route.get('path', '/') else route.get('path', '')
            if prefix and prefix not in self.SKIP_WORDS:
                route_groups.setdefault(prefix, []).append(route)
        for prefix, group in route_groups.items():
            aliases = self._name_to_aliases(prefix)
            file_ex = group[0].get('file', '')
            for alias in aliases:
                self._add(vocab, alias, 'api', file_ex, f"{len(group)} routes")

        # Merge learned vocabulary
        learned = self._load_learned()
        for alias, data in learned.items():
            if alias not in vocab and data.get('score', 0) >= 5:
                vocab[alias] = {
                    'alias': alias,
                    'type': 'learned',
                    'location': ', '.join(data.get('targets', [])),
                    'notes': f"learned from session (score: {data['score']:.1f})",
                }

        return list(vocab.values())

    def _name_to_aliases(self, name: str) -> list[str]:
        """Generate human aliases from a code name."""
        # camelCase / PascalCase → words
        words = re.sub(r'([A-Z])', r' \1', name).lower().split()
        words = [w for w in words if w and w not in self.SKIP_WORDS]
        if not words:
            return []
        phrase = ' '.join(words)
        aliases = [phrase, name.lower()]
        # e.g. 'deal-pipeline' → 'deal pipeline'
        if '-' in name or '_' in name:
            clean = re.sub(r'[-_]', ' ', name).lower()
            aliases.append(clean)
        return list(dict.fromkeys(aliases))  # dedupe, preserve order

    def _add(self, vocab: dict, alias: str, type_: str, location: str, notes: str) -> None:
        if alias and alias not in vocab:
            vocab[alias] = {'alias': alias, 'type': type_, 'location': location, 'notes': notes}

    def _load_learned(self) -> dict:
        if LEARNED_VOC.exists():
            try:
                return json.loads(LEARNED_VOC.read_text())
            except Exception:
                pass
        return {}


# ── Tools & Commands Scanner ──────────────────────────────────────────────────

class ToolsScanner:
    def scan(self) -> list[dict]:
        tools = []

        # npm scripts
        pkg = PROJECT_ROOT / 'package.json'
        if pkg.exists():
            try:
                data = json.loads(pkg.read_text())
                for name, cmd in (data.get('scripts') or {}).items():
                    tools.append({'name': name, 'command': f'npm run {name}', 'description': cmd, 'source': 'package.json'})
            except Exception:
                pass

        # Makefile targets
        makefile = PROJECT_ROOT / 'Makefile'
        if makefile.exists():
            for line in makefile.read_text(encoding='utf-8', errors='replace').splitlines():
                m = re.match(r'^([a-zA-Z][a-zA-Z0-9_-]+)\s*:', line)
                if m and not m.group(1).startswith('.'):
                    tools.append({'name': m.group(1), 'command': f'make {m.group(1)}', 'description': '', 'source': 'Makefile'})

        # Poetry / pip scripts
        for cfg in ['pyproject.toml', 'setup.cfg']:
            path = PROJECT_ROOT / cfg
            if path.exists():
                text = path.read_text(encoding='utf-8', errors='replace')
                for m in re.finditer(r'^\[tool\.poetry\.scripts\]\s*\n((?:\w.*\n)*)', text, re.MULTILINE):
                    for line in m.group(1).splitlines():
                        if '=' in line:
                            name = line.split('=')[0].strip()
                            tools.append({'name': name, 'command': name, 'description': '', 'source': cfg})

        # Shell scripts at root
        for f in PROJECT_ROOT.glob('*.sh'):
            tools.append({'name': f.name, 'command': f'bash {f.name}', 'description': '', 'source': 'shell'})

        # .claude/skills
        skills_dir = PROJECT_ROOT / '.claude' / 'skills'
        if skills_dir.is_dir():
            for skill_dir in skills_dir.iterdir():
                if (skill_dir / 'SKILL.md').exists():
                    tools.append({'name': f'/{skill_dir.name}', 'command': f'/{skill_dir.name}', 'description': 'Claude skill', 'source': 'skills'})

        return tools


# ── Auth Config Scanner ───────────────────────────────────────────────────────

class AuthScanner:
    def scan(self) -> dict:
        info: dict[str, Any] = {'provider': 'unknown', 'files': [], 'patterns': []}

        patterns_map = {
            'supabase': ['supabase', 'createClient', 'auth.signIn'],
            'next-auth': ['NextAuth', 'getSession', 'useSession', 'SessionProvider'],
            'clerk': ['ClerkProvider', 'useUser', '@clerk'],
            'auth0': ['Auth0Provider', 'useAuth0', '@auth0'],
            'jwt': ['jwt.sign', 'jwt.verify', 'create_access_token', 'decode_token'],
            'passport': ['passport.use', 'passport.authenticate'],
            'firebase': ['initializeApp', 'getAuth', 'signInWithEmailAndPassword'],
        }

        for f in PROJECT_ROOT.rglob('*'):
            if any(p in IGNORE_DIRS for p in f.parts):
                continue
            if f.suffix not in ('.py', '.ts', '.tsx', '.js', '.jsx'):
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
            except Exception:
                continue
            for provider, patterns in patterns_map.items():
                if any(p in source for p in patterns):
                    info['provider'] = provider
                    rel = str(f.relative_to(PROJECT_ROOT))
                    if rel not in info['files']:
                        info['files'].append(rel)
                    info['patterns'].extend([p for p in patterns if p in source and p not in info['patterns']])

        return info


# ── Reverse Proxy Scanner ─────────────────────────────────────────────────────

class ReverseProxyScanner:
    def scan(self) -> list[dict]:
        rules = []
        # nginx
        for f in PROJECT_ROOT.rglob('*.conf'):
            if any(p in IGNORE_DIRS for p in f.parts):
                continue
            try:
                source = f.read_text(encoding='utf-8', errors='replace')
                for m in re.finditer(r'location\s+([^\s{]+)\s*\{[^}]*proxy_pass\s+([^;]+);', source, re.DOTALL):
                    rules.append({'type': 'nginx', 'location': m.group(1).strip(), 'upstream': m.group(2).strip(), 'file': str(f.relative_to(PROJECT_ROOT))})
            except Exception:
                pass
        # Caddyfile
        caddyfile = PROJECT_ROOT / 'Caddyfile'
        if caddyfile.exists():
            try:
                source = caddyfile.read_text(encoding='utf-8', errors='replace')
                for m in re.finditer(r'reverse_proxy\s+([^\n]+)', source):
                    rules.append({'type': 'caddy', 'location': '*', 'upstream': m.group(1).strip(), 'file': 'Caddyfile'})
            except Exception:
                pass
        return rules


# ── Dead Code Detector ────────────────────────────────────────────────────────

class DeadCodeDetector:
    def detect(self, vocab: list[dict]) -> list[dict]:
        candidates = []
        cutoff_date = '--since=6 months ago'

        low_score_files = set()
        if LEARNED_VOC.exists():
            try:
                learned = json.loads(LEARNED_VOC.read_text())
                for alias, data in learned.items():
                    if data.get('score', 999) < 2:
                        low_score_files.update(data.get('targets', []))
            except Exception:
                pass

        for filepath_str in low_score_files:
            path = PROJECT_ROOT / filepath_str
            if not path.exists():
                continue
            try:
                result = subprocess.run(
                    ['git', '-C', str(PROJECT_ROOT), 'log', cutoff_date, '--', filepath_str],
                    capture_output=True, text=True, timeout=5
                )
                if not result.stdout.strip():
                    candidates.append({
                        'file': filepath_str,
                        'reason': 'No commits in 6 months + low vocabulary score',
                    })
            except Exception:
                pass

        return candidates


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  SECTION WRITERS                                                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝

def write_section(num: str, name: str, content: str) -> Path:
    filename = f"{num}-{name}.md"
    path = SECTIONS_DIR / filename
    path.write_text(content, encoding='utf-8')
    return path

def section_size_kb(path: Path) -> float:
    return path.stat().st_size / 1024 if path.exists() else 0.0


def build_vocabulary_section(vocab: list[dict]) -> str:
    lines = [
        "# Section 01 — Vocabulary Translation Layer\n",
        "> Maps human language to exact code locations. Auto-generated.\n\n",
        "| Alias | Type | Location | Notes |",
        "|-------|------|----------|-------|",
    ]
    for v in sorted(vocab, key=lambda x: x.get('alias', '')):
        alias    = v.get('alias', '').replace('|', '\\|')
        type_    = v.get('type', '').replace('|', '\\|')
        location = v.get('location', '').replace('|', '\\|')
        notes    = v.get('notes', '').replace('|', '\\|')
        lines.append(f"| {alias} | {type_} | {location} | {notes} |")
    if not vocab:
        lines.append("| _(no vocabulary generated yet — add source code to populate)_ | | | |")
    return '\n'.join(lines) + '\n'


def build_topology_section(services: list[dict]) -> str:
    lines = [
        "# Section 02 — Service Topology\n",
        "> Docker services, ports, and dependencies.\n\n",
    ]
    if not services:
        lines.append("_No docker-compose services detected._\n")
        return '\n'.join(lines)
    lines += ["| Service | Image | Ports | Depends On |",
              "|---------|-------|-------|------------|"]
    for svc in services:
        ports = ', '.join(str(p) for p in svc.get('ports', []))
        deps  = ', '.join(svc.get('depends_on', []) if isinstance(svc.get('depends_on'), list)
                         else list(svc.get('depends_on', {}).keys()))
        img   = str(svc.get('image', '?'))[:50]
        lines.append(f"| {svc['name']} | {img} | {ports} | {deps} |")
    return '\n'.join(lines) + '\n'


def build_environment_section(env_entries: list[dict]) -> str:
    lines = [
        "# Section 03 — Environment Variables\n",
        "> Key names and non-sensitive values only. Secrets are redacted.\n\n",
    ]
    if not env_entries:
        lines.append("_No .env files found._\n")
        return '\n'.join(lines)
    lines += ["| Key | Value | Source |",
              "|-----|-------|--------|"]
    for e in env_entries:
        val = '[SECRET]' if e.get('is_secret') else str(e.get('value', ''))[:60]
        lines.append(f"| `{e['key']}` | `{val}` | {e.get('source', '')} |")
    return '\n'.join(lines) + '\n'


def build_routes_section(routes: list[dict]) -> str:
    lines = [
        "# Section 04 — API Routes\n\n",
        "| Method | Path | File | Line |",
        "|--------|------|------|------|",
    ]
    for r in sorted(routes, key=lambda x: (x.get('path',''), x.get('method',''))):
        lines.append(f"| `{r.get('method','?')}` | `{r.get('path','?')}` | {r.get('file','')} | {r.get('line','')} |")
    if not routes:
        lines.append("| _(no routes detected yet)_ | | | |")
    return '\n'.join(lines) + '\n'


def build_models_section(models: list[dict]) -> str:
    lines = ["# Section 05 — Data Models\n\n"]
    if not models:
        lines.append("_No data models detected yet._\n")
        return '\n'.join(lines)
    for model in models:
        lines.append(f"## {model['name']}")
        lines.append(f"- **File**: `{model.get('file','?')}`")
        cols = model.get('columns', [])
        if cols:
            lines.append("- **Fields**:")
            for c in cols[:20]:
                lines.append(f"  - `{c.get('name','?')}` ({c.get('type','?')})")
        lines.append('')
    return '\n'.join(lines)


def build_schemas_section(schemas: list[dict]) -> str:
    lines = ["# Section 06 — Schemas / DTOs\n\n"]
    if not schemas:
        lines.append("_No schemas detected yet._\n")
        return '\n'.join(lines)
    for s in schemas:
        lines.append(f"## {s['name']}")
        lines.append(f"- **File**: `{s.get('file','?')}`")
        fields = s.get('fields', [])
        if fields:
            lines.append(f"- **Fields**: {', '.join(f'`{f}`' for f in fields[:15])}")
        lines.append('')
    return '\n'.join(lines)


def build_services_section(routes: list[dict], models: list[dict]) -> str:
    lines = ["# Section 07 — Services\n\n",
             "_Service discovery is inferred from directory structure and imports._\n\n"]
    # Collect unique directories containing routes or models
    dirs: dict[str, int] = {}
    for item in routes + models:
        f = item.get('file', '')
        d = str(Path(f).parent) if f else ''
        if d and d != '.':
            dirs[d] = dirs.get(d, 0) + 1
    if dirs:
        lines += ["| Directory | Items |", "|-----------|-------|"]
        for d, count in sorted(dirs.items(), key=lambda x: -x[1]):
            lines.append(f"| `{d}` | {count} |")
    return '\n'.join(lines) + '\n'


def build_background_jobs_section() -> str:
    lines = ["# Section 08 — Background Jobs\n\n"]
    jobs = []
    # Celery
    for f in PROJECT_ROOT.rglob('*.py'):
        if any(p in IGNORE_DIRS for p in f.parts):
            continue
        try:
            source = f.read_text(encoding='utf-8', errors='replace')
            for m in re.finditer(r'@(?:app|celery)\.task|@shared_task', source):
                # Find function after decorator
                fn_m = re.search(r'def\s+(\w+)\s*\(', source[m.start():m.start()+200])
                if fn_m:
                    line = source[:m.start()].count('\n') + 1
                    jobs.append({'name': fn_m.group(1), 'type': 'celery', 'file': str(f.relative_to(PROJECT_ROOT)), 'line': line})
        except Exception:
            pass
    # Cron / APScheduler
    for f in PROJECT_ROOT.rglob('*.py'):
        if any(p in IGNORE_DIRS for p in f.parts):
            continue
        try:
            source = f.read_text(encoding='utf-8', errors='replace')
            for m in re.finditer(r'@scheduler\.scheduled_job|scheduler\.add_job|@cron', source):
                fn_m = re.search(r'def\s+(\w+)\s*\(', source[m.start():m.start()+200])
                if fn_m:
                    line = source[:m.start()].count('\n') + 1
                    jobs.append({'name': fn_m.group(1), 'type': 'scheduler', 'file': str(f.relative_to(PROJECT_ROOT)), 'line': line})
        except Exception:
            pass

    if not jobs:
        lines.append("_No background jobs detected._\n")
    else:
        lines += ["| Job | Type | File | Line |", "|-----|------|------|------|"]
        for j in jobs:
            lines.append(f"| `{j['name']}` | {j['type']} | {j['file']} | {j.get('line','')} |")
    return '\n'.join(lines) + '\n'


def build_frontend_section(features: list[dict]) -> str:
    lines = ["# Section 09 — Frontend Features\n\n"]
    if not features:
        lines.append("_No frontend feature directories detected._\n")
        return '\n'.join(lines)
    lines += ["| Feature | Components | Hooks | Stores | API Files |",
              "|---------|-----------|-------|--------|-----------|"]
    for f in features:
        lines.append(
            f"| `{f['path']}` | {f['component_count']} | {f['hook_count']} "
            f"| {len(f.get('stores',[]))} | {len(f.get('api_files',[]))} |"
        )
    return '\n'.join(lines) + '\n'


def build_tools_section(tools: list[dict]) -> str:
    lines = ["# Section 10 — Tools & Commands\n\n",
             "| Name | Command | Source |",
             "|------|---------|--------|"]
    for t in tools:
        lines.append(f"| `{t['name']}` | `{t['command']}` | {t.get('source','')} |")
    if not tools:
        lines.append("| _(no tools detected)_ | | |")
    return '\n'.join(lines) + '\n'


def build_migrations_section(migrations: list[dict]) -> str:
    lines = ["# Section 11 — Migrations\n\n"]
    if not migrations:
        lines.append("_No migrations detected._\n")
        return '\n'.join(lines)
    lines += ["| Revision | Tables Affected | Type | File |",
              "|----------|----------------|------|------|"]
    for m in migrations[-30:]:  # last 30
        tables = ', '.join(m.get('tables_affected', []))[:60]
        lines.append(f"| `{m.get('revision','?')}` | {tables} | {m.get('type','?')} | {m.get('file','')} |")
    return '\n'.join(lines) + '\n'


def build_import_chains_section(chains: list[dict]) -> str:
    lines = ["# Section 12 — Import Chains\n\n",
             "_Traces route → service → model → table for key endpoints._\n\n"]
    if not chains:
        lines.append("_No import chains traced (requires Python source files with routes)._\n")
        return '\n'.join(lines)
    for c in chains:
        lines.append(f"**{c['route']}**")
        lines.append(f"```\n{c['chain']}\n```\n")
    return '\n'.join(lines)


def build_frontend_backend_section(routes: list[dict], features: list[dict]) -> str:
    lines = ["# Section 13 — Frontend → Backend Map\n\n",
             "_Maps frontend API service calls to backend route paths._\n\n"]
    mappings = []
    api_calls: list[tuple[str,str]] = []

    for feat in features:
        for api_file in feat.get('api_files', []):
            full = PROJECT_ROOT / feat['path'] / api_file
            if full.exists():
                try:
                    source = full.read_text(encoding='utf-8', errors='replace')
                    for m in re.finditer(r'[\'"`](/api/[^\'"` \n]+)', source):
                        api_calls.append((m.group(1), str(full.relative_to(PROJECT_ROOT))))
                except Exception:
                    pass

    route_paths = {r.get('path',''): r for r in routes}
    for call, fe_file in api_calls:
        if call in route_paths:
            be = route_paths[call]
            mappings.append({'frontend': fe_file, 'url': call, 'backend': be.get('file','?')})

    if not mappings:
        lines.append("_No frontend→backend mappings detected yet._\n")
    else:
        lines += ["| Frontend File | URL | Backend File |",
                  "|--------------|-----|--------------|"]
        for m in mappings:
            lines.append(f"| {m['frontend']} | `{m['url']}` | {m['backend']} |")
    return '\n'.join(lines) + '\n'


def build_proxy_section(proxy_rules: list[dict]) -> str:
    lines = ["# Section 14 — Reverse Proxy\n\n"]
    if not proxy_rules:
        lines.append("_No reverse proxy configuration detected._\n")
        return '\n'.join(lines)
    lines += ["| Type | Location | Upstream | File |",
              "|------|----------|----------|------|"]
    for r in proxy_rules:
        lines.append(f"| {r['type']} | `{r['location']}` | `{r['upstream']}` | {r['file']} |")
    return '\n'.join(lines) + '\n'


def build_auth_section(auth_info: dict) -> str:
    lines = ["# Section 15 — Auth Configuration\n\n",
             f"**Provider**: {auth_info.get('provider','unknown')}\n\n"]
    files = auth_info.get('files', [])
    if files:
        lines.append("**Auth files:**")
        for f in files[:10]:
            lines.append(f"- `{f}`")
    patterns = auth_info.get('patterns', [])
    if patterns:
        lines.append(f"\n**Detected patterns**: {', '.join(f'`{p}`' for p in patterns[:10])}")
    return '\n'.join(lines) + '\n'


def build_infra_section(stack: dict, services: list[dict]) -> str:
    lines = ["# Section 16 — Infrastructure Profile\n\n",
             f"| Property | Value |",
             "|----------|-------|",
             f"| **Language** | {stack.get('language','?')} |",
             f"| **Framework** | {stack.get('framework','?')} |",
             f"| **Database** | {stack.get('database','?')} |",
             f"| **ORM** | {stack.get('orm','?')} |",
             f"| **Auth** | {stack.get('auth','?')} |",
             f"| **Package Manager** | {stack.get('package_manager','?')} |",
             f"| **Infrastructure** | {stack.get('infrastructure','?')} |",
             f"| **Services** | {len(services)} docker services |",
             ""]
    return '\n'.join(lines)


def build_learned_vocab_section() -> str:
    lines = ["# Section 17 — Learned Vocabulary\n\n",
             "_Aliases mined from Claude Code session history. Score = frequency × recency._\n\n"]
    learned = {}
    if LEARNED_VOC.exists():
        try:
            learned = json.loads(LEARNED_VOC.read_text())
        except Exception:
            pass
    if not learned:
        lines.append("_No session-mined vocabulary yet. Accumulates over time._\n")
        return '\n'.join(lines)
    lines += ["| Alias | Score | Targets | Last Seen |",
              "|-------|-------|---------|-----------|"]
    for alias, data in sorted(learned.items(), key=lambda x: -x[1].get('score', 0)):
        if data.get('score', 0) >= 2:
            targets = ', '.join(data.get('targets', []))[:60]
            lines.append(f"| {alias} | {data.get('score',0):.1f} | {targets} | {data.get('last_seen','?')} |")
    return '\n'.join(lines) + '\n'


def build_dead_code_section(candidates: list[dict]) -> str:
    lines = ["# Section 18 — Dead Code Candidates\n\n",
             "> Files flagged for human review: no recent commits AND low vocabulary score.\n",
             "> **Do not auto-delete.** Review before removing.\n\n"]
    if not candidates:
        lines.append("_No dead code candidates detected._\n")
        return '\n'.join(lines)
    for c in candidates:
        lines.append(f"- `{c['file']}` — {c.get('reason','')}")
    return '\n'.join(lines) + '\n'


def build_doc_pointers_section() -> str:
    lines = ["# Section 19 — Documentation Pointers\n\n"]
    docs = []
    doc_dirs = ['docs', 'doc', 'documentation', 'wiki', '.docs']
    doc_exts = {'.md', '.rst', '.txt', '.adoc'}

    for doc_dir in doc_dirs:
        d = PROJECT_ROOT / doc_dir
        if d.is_dir():
            for f in sorted(d.rglob('*')):
                if f.is_file() and f.suffix in doc_exts:
                    docs.append(str(f.relative_to(PROJECT_ROOT)))

    # Root-level docs
    for f in PROJECT_ROOT.glob('*.md'):
        docs.append(str(f.relative_to(PROJECT_ROOT)))

    if not docs:
        lines.append("_No documentation files found._\n")
    else:
        for d in docs[:30]:
            lines.append(f"- [`{d}`]({d})")
    return '\n'.join(lines) + '\n'


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROJECT MAP TOC                                                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝

def build_project_map(
    stack: dict,
    routes: list[dict],
    models: list[dict],
    schemas: list[dict],
    features: list[dict],
    migrations: list[dict],
    services: list[dict],
    vocab: list[dict],
    section_files: list[tuple[str, Path]],
) -> str:
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    name = stack.get('name', PROJECT_ROOT.name)
    slug = stack.get('slug', name)

    lines = [
        f"# {name} — Project Map\n",
        f"> Auto-generated by `generate.py` on {now}. Do not edit manually.\n\n",
        f"## Stats\n",
        f"| Metric | Count |",
        f"|--------|-------|",
        f"| API Routes | {len(routes)} |",
        f"| Data Models | {len(models)} |",
        f"| Schemas/DTOs | {len(schemas)} |",
        f"| Frontend Features | {len(features)} |",
        f"| Migrations | {len(migrations)} |",
        f"| Docker Services | {len(services)} |",
        f"| Vocabulary Entries | {len(vocab)} |",
        f"| Stack | {stack.get('language','?')} / {stack.get('framework','?')} |",
        "",
        "## Section Index\n",
        "| # | Section | Size | When to Read |",
        "|---|---------|------|--------------|",
    ]

    WHEN_TO_READ = {
        '01': 'Any task — start here if you don\'t know where the code lives',
        '02': 'Debugging connectivity, adding a service, understanding ports',
        '03': 'Environment setup, missing vars, config issues',
        '04': 'Adding/editing API endpoints, checking what routes exist',
        '05': 'Changing database schema, adding fields, understanding relations',
        '06': 'Adding DTOs, changing request/response shapes',
        '07': 'Adding service logic, understanding service boundaries',
        '08': 'Working with background jobs, queues, scheduled tasks',
        '09': 'Frontend feature work, understanding UI structure',
        '10': 'Available commands, scripts, developer tooling',
        '11': 'Database migrations, schema history',
        '12': 'Tracing data flow from HTTP request to DB',
        '13': 'Understanding which frontend calls which backend endpoint',
        '14': 'Proxy routing, nginx/caddy config',
        '15': 'Auth flow, sessions, permissions',
        '16': 'Infrastructure overview, tech stack summary',
        '17': 'Vocabulary learned from past sessions',
        '18': 'Dead code review',
        '19': 'Finding documentation, READMEs, wikis',
    }

    for name_part, path in section_files:
        num = name_part.split('-')[0]
        display = name_part.replace('-', ' ').title()
        size_kb = section_size_kb(path)
        when = WHEN_TO_READ.get(num, '')
        lines.append(f"| [{num}](sections/{path.name}) | {display} | {size_kb:.1f} KB | {when} |")

    lines += [
        "",
        "## Quick Routing\n",
        "| Task | Read Sections |",
        "|------|--------------|",
        "| Feature / UX work | 01 → 09 → 04 |",
        "| Add model or field | 05 → 06 → 12 |",
        "| Troubleshoot error | 02 → 03 → 14 |",
        "| Infrastructure / scaling | 16 → 02 |",
        "| Auth / security | 15 → 19 |",
        "| What tools exist | 10 |",
        "| Background jobs | 08 |",
        "| Migration history | 11 |",
        "",
        f"## Regenerate\n",
        "```bash",
        "python .claude/project-map/generate.py          # skip if unchanged",
        "python .claude/project-map/generate.py --force  # always regenerate",
        "```",
    ]
    return '\n'.join(lines) + '\n'


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  MAIN                                                                    ║
# ╚══════════════════════════════════════════════════════════════════════════╝

def main() -> None:
    parser = argparse.ArgumentParser(description='Babel Fish — generate project map')
    parser.add_argument('--force', action='store_true', help='Force regeneration even if checksums match')
    parser.add_argument('--project-root', type=Path, default=None, help='Override project root')
    parser.add_argument('--stack-json', type=Path, default=None, help='Path to stack.json from detect-stack.sh')
    args = parser.parse_args()

    global PROJECT_ROOT
    if args.project_root:
        PROJECT_ROOT = args.project_root.resolve()

    print(f"[generate] Project root: {PROJECT_ROOT}")

    # 1. Checksum check
    watched = collect_watched_files()
    checksum = compute_checksum(watched)

    if not args.force and is_unchanged(checksum):
        print("[generate] ✓ No changes detected — skipping regeneration (use --force to override)")
        sys.exit(0)

    # 2. Load stack
    stack = load_stack(args.stack_json)
    print(f"[generate] Stack: {stack['language']} / {stack['framework']}")

    # 3. Collect all relevant files
    py_files  = [f for f in watched if f.suffix == '.py']
    ts_files  = [f for f in watched if f.suffix in ('.ts','.tsx','.js','.jsx')]
    go_files  = [f for f in watched if f.suffix == '.go']

    # 4. Parse
    print("[generate] Parsing routes...")
    routes: list[dict] = []
    if stack['language'] in ('python', 'unknown'):
        routes.extend(PythonRouteParser().parse(py_files))
    if stack['language'] in ('typescript', 'javascript', 'unknown'):
        routes.extend(TSRouteParser().parse(ts_files))
    if stack['language'] in ('go', 'unknown'):
        routes.extend(GoRouteParser().parse(go_files))

    print("[generate] Parsing models...")
    models: list[dict] = []
    if stack['language'] in ('python', 'unknown'):
        models.extend(PythonModelParser().parse(py_files))
    if stack['language'] in ('typescript', 'javascript', 'unknown'):
        models.extend(TSModelParser().parse(ts_files + [f for f in watched if f.suffix == '.prisma']))
    if stack['language'] in ('go', 'unknown'):
        models.extend(GoModelParser().parse(go_files))

    print("[generate] Parsing schemas...")
    schemas = PythonSchemaParser().parse(py_files)

    print("[generate] Scanning environment...")
    services = DockerComposeParser().parse()
    env_entries = EnvParser().parse()
    migrations = MigrationParser().parse()
    features = FrontendScanner().scan()
    tools = ToolsScanner().scan()
    auth_info = AuthScanner().scan()
    proxy_rules = ReverseProxyScanner().scan()

    print("[generate] Building vocabulary...")
    vocab = VocabularyBuilder().build(routes, models, schemas, features, stack)

    print("[generate] Tracing import chains...")
    chains = ImportChainTracer().trace(routes)

    print("[generate] Detecting dead code candidates...")
    dead_code = DeadCodeDetector().detect(vocab)

    # 5. Write sections
    print("[generate] Writing sections...")
    section_files: list[tuple[str, Path]] = [
        ('01-vocabulary',          write_section('01', 'vocabulary',          build_vocabulary_section(vocab))),
        ('02-service-topology',    write_section('02', 'service-topology',    build_topology_section(services))),
        ('03-environment',         write_section('03', 'environment',         build_environment_section(env_entries))),
        ('04-api-routes',          write_section('04', 'api-routes',          build_routes_section(routes))),
        ('05-data-models',         write_section('05', 'data-models',         build_models_section(models))),
        ('06-schemas',             write_section('06', 'schemas',             build_schemas_section(schemas))),
        ('07-services',            write_section('07', 'services',            build_services_section(routes, models))),
        ('08-background-jobs',     write_section('08', 'background-jobs',     build_background_jobs_section())),
        ('09-frontend-features',   write_section('09', 'frontend-features',   build_frontend_section(features))),
        ('10-tools-commands',      write_section('10', 'tools-commands',      build_tools_section(tools))),
        ('11-migrations',          write_section('11', 'migrations',          build_migrations_section(migrations))),
        ('12-import-chains',       write_section('12', 'import-chains',       build_import_chains_section(chains))),
        ('13-frontend-backend-map',write_section('13', 'frontend-backend-map',build_frontend_backend_section(routes, features))),
        ('14-reverse-proxy',       write_section('14', 'reverse-proxy',       build_proxy_section(proxy_rules))),
        ('15-auth-config',         write_section('15', 'auth-config',         build_auth_section(auth_info))),
        ('16-infra-profile',       write_section('16', 'infra-profile',       build_infra_section(stack, services))),
        ('17-learned-vocabulary',  write_section('17', 'learned-vocabulary',  build_learned_vocab_section())),
        ('18-dead-code',           write_section('18', 'dead-code',           build_dead_code_section(dead_code))),
        ('19-doc-pointers',        write_section('19', 'doc-pointers',        build_doc_pointers_section())),
    ]

    # 6. Write PROJECT_MAP.md
    print("[generate] Writing PROJECT_MAP.md...")
    project_map = build_project_map(stack, routes, models, schemas, features, migrations, services, vocab, section_files)
    (MAP_DIR / 'PROJECT_MAP.md').write_text(project_map, encoding='utf-8')

    # 7. Update checksums
    save_checksums({'input_hash': checksum, 'generated_at': datetime.now().isoformat(), 'route_count': len(routes), 'model_count': len(models)})

    # 8. Ensure learned-vocabulary.json exists
    if not LEARNED_VOC.exists():
        LEARNED_VOC.write_text('{}', encoding='utf-8')

    total_kb = sum(section_size_kb(p) for _, p in section_files)
    print(f"[generate] ✓ Done — {len(routes)} routes, {len(models)} models, {len(vocab)} vocab entries, {total_kb:.1f} KB total")


if __name__ == '__main__':
    main()

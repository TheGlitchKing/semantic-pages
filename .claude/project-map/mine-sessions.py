#!/usr/bin/env python3
"""
mine-sessions.py — Session Vocabulary Miner
Parses Claude Code conversation JSONL files from ~/.claude/projects/<slug>/
to extract user-language → file-path aliases.

Pattern: user said "the numbers page" → Claude opened DealAnalyzerV2.tsx
         = learned alias: "numbers page" → DealAnalyzerV2.tsx

Scoring: frequency × recency_weight
  - Sessions from last 30 days: weight 1.0
  - 31-60 days: weight 0.5
  - 61-90 days: weight 0.25
  - >90 days: dropped

Minimum score of 5 to appear in output (filters one-off mentions).

Usage:
    python mine-sessions.py [--project-root PATH] [--dry-run] [--verbose]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).parent
LEARNED_VOC  = SCRIPT_DIR / "learned-vocabulary.json"
PROJECT_ROOT = SCRIPT_DIR.parent.parent

# ── Config ───────────────────────────────────────────────────────────────────
MIN_SCORE        = 5.0     # Minimum score to include in vocabulary
RECENCY_WINDOWS  = [       # (days_threshold, weight)
    (30,  1.00),
    (60,  0.50),
    (90,  0.25),
]
MAX_ALIAS_WORDS  = 6       # Ignore user phrases longer than this
MIN_ALIAS_WORDS  = 1
STOP_WORDS = {
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its',
    'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
    'please', 'just', 'also', 'now', 'then', 'so', 'ok', 'yes', 'no',
    'what', 'how', 'why', 'when', 'where', 'which', 'who',
    'file', 'files', 'code', 'function', 'method', 'class', 'module',
    'here', 'there', 'look', 'see', 'check', 'let', 'make', 'get',
    'add', 'update', 'change', 'fix', 'show', 'find', 'help', 'need',
}

# Tool call names that indicate a file was opened/used
FILE_TOOL_NAMES = {
    'Read', 'Edit', 'Write', 'Grep', 'Glob',
    'read_file', 'edit_file', 'write_file',
}

# ── Recency weight ────────────────────────────────────────────────────────────

def recency_weight(session_date: datetime) -> float:
    now = datetime.now(tz=timezone.utc)
    if session_date.tzinfo is None:
        session_date = session_date.replace(tzinfo=timezone.utc)
    age_days = (now - session_date).days
    for threshold, weight in RECENCY_WINDOWS:
        if age_days <= threshold:
            return weight
    return 0.0  # Too old — drop


# ── Session discovery ─────────────────────────────────────────────────────────

def find_session_files(project_root: Path) -> list[Path]:
    """Find Claude Code JSONL session files for this project."""
    candidates: list[Path] = []

    # ~/.claude/projects/ uses a path-encoded slug
    # e.g. /mnt/e/the-glitch-kingdom/babel-fish → -mnt-e-the-glitch-kingdom-babel-fish
    encoded = str(project_root).replace('/', '-').lstrip('-')
    claude_projects = Path.home() / '.claude' / 'projects'

    if not claude_projects.exists():
        return []

    # Try exact match first
    exact = claude_projects / encoded
    if exact.is_dir():
        candidates.extend(sorted(exact.glob('*.jsonl')))

    # Also try fuzzy match on project name
    project_name = project_root.name.lower()
    for d in claude_projects.iterdir():
        if d.is_dir() and project_name in d.name.lower() and d != exact:
            candidates.extend(sorted(d.glob('*.jsonl')))

    return candidates


# ── JSONL parser ──────────────────────────────────────────────────────────────

def parse_session(path: Path) -> list[dict]:
    """Parse a JSONL session file into a list of message dicts."""
    messages = []
    try:
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                messages.append(obj)
            except json.JSONDecodeError:
                pass
    except Exception:
        pass
    return messages


def extract_session_date(messages: list[dict]) -> datetime | None:
    """Extract the timestamp of the first message in a session."""
    for msg in messages:
        ts = msg.get('timestamp') or msg.get('created_at') or msg.get('ts')
        if ts:
            try:
                return datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
            except ValueError:
                pass
    return None


# ── Alias extraction ──────────────────────────────────────────────────────────

def extract_file_paths_from_tool_calls(messages: list[dict]) -> list[str]:
    """Extract file paths from tool use calls in a message sequence."""
    paths = []
    for msg in messages:
        # Handle various JSONL formats
        content = msg.get('content') or []
        if isinstance(content, str):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') not in ('tool_use', 'tool_result'):
                continue
            tool_name = block.get('name', '')
            if tool_name not in FILE_TOOL_NAMES:
                continue
            # Extract file_path from input
            inp = block.get('input') or {}
            if isinstance(inp, dict):
                fp = inp.get('file_path') or inp.get('path') or inp.get('pattern')
                if fp and isinstance(fp, str):
                    # Normalize to relative path
                    try:
                        rel = Path(fp).relative_to(PROJECT_ROOT)
                        paths.append(str(rel))
                    except ValueError:
                        # Already relative or different root
                        if not fp.startswith('/'):
                            paths.append(fp)
    return paths


def extract_user_phrases(text: str) -> list[str]:
    """
    Extract candidate alias phrases from user message text.
    Returns noun phrases and quoted strings likely to be feature references.
    """
    phrases = []

    # Quoted strings are high-confidence aliases
    for m in re.finditer(r'["\']([^"\']{3,40})["\']', text):
        phrases.append(m.group(1).lower().strip())

    # "the X" / "the X page/screen/section/tab/view/panel/modal/form/button"
    for m in re.finditer(
        r'\bthe\s+([\w\s-]{2,40?}?)\s*(?:page|screen|section|tab|view|panel|modal|form|button|component|widget|dashboard|list|table|chart|graph|map|sidebar|header|footer|nav|menu)\b',
        text, re.IGNORECASE
    ):
        phrases.append(m.group(1).lower().strip())

    # "X feature" / "X functionality" / "X system" / "X module"
    for m in re.finditer(
        r'\b([\w\s-]{2,30?}?)\s+(?:feature|functionality|system|module|service|flow|workflow|pipeline|process)\b',
        text, re.IGNORECASE
    ):
        candidate = m.group(1).lower().strip()
        words = candidate.split()
        if 1 <= len(words) <= MAX_ALIAS_WORDS:
            phrases.append(candidate)

    # Filter: remove stop-word-only phrases, too short/long
    result = []
    for phrase in phrases:
        words = [w for w in phrase.split() if w not in STOP_WORDS and len(w) > 1]
        if MIN_ALIAS_WORDS <= len(words) <= MAX_ALIAS_WORDS:
            clean = ' '.join(words)
            if clean and clean not in result:
                result.append(clean)

    return result


# ── Core miner ────────────────────────────────────────────────────────────────

class SessionMiner:
    def __init__(self, project_root: Path, verbose: bool = False):
        self.project_root = project_root
        self.verbose = verbose
        # alias → {targets: set, raw_score: float, last_seen: str, count: int}
        self._data: dict[str, dict] = {}

    def mine(self, session_files: list[Path]) -> None:
        for path in session_files:
            self._mine_file(path)

    def _mine_file(self, path: Path) -> None:
        messages = parse_session(path)
        if not messages:
            return

        session_date = extract_session_date(messages)
        if session_date is None:
            session_date = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)

        weight = recency_weight(session_date)
        if weight == 0.0:
            if self.verbose:
                print(f"  [skip] {path.name} — too old")
            return

        if self.verbose:
            print(f"  [mine] {path.name} (weight={weight}, date={session_date.date()})")

        # Walk messages in pairs: look for user message followed by tool calls
        for i, msg in enumerate(messages):
            role = msg.get('role') or msg.get('type') or ''
            if role not in ('user', 'human'):
                continue

            # Extract text from this user message
            content = msg.get('content') or ''
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'text':
                        text_parts.append(block.get('text', ''))
                    elif isinstance(block, str):
                        text_parts.append(block)
                text = ' '.join(text_parts)
            else:
                text = str(content)

            if len(text) < 5:
                continue

            # Find tool calls in subsequent assistant messages (within next 3 messages)
            file_paths: list[str] = []
            for j in range(i + 1, min(i + 4, len(messages))):
                next_msg = messages[j]
                next_role = next_msg.get('role') or next_msg.get('type') or ''
                if next_role in ('user', 'human') and j > i + 1:
                    break  # New user turn — stop looking
                file_paths.extend(extract_file_paths_from_tool_calls([next_msg]))

            if not file_paths:
                continue

            # Extract phrases from user text and pair with opened files
            phrases = extract_user_phrases(text)
            for phrase in phrases:
                for fp in file_paths:
                    self._record(phrase, fp, weight, session_date)

    def _record(self, alias: str, target: str, weight: float, date: datetime) -> None:
        if alias not in self._data:
            self._data[alias] = {
                'targets': set(),
                'raw_score': 0.0,
                'last_seen': date.date().isoformat(),
                'count': 0,
            }
        entry = self._data[alias]
        entry['targets'].add(target)
        entry['raw_score'] += weight
        entry['count'] += 1
        if date.date().isoformat() > entry['last_seen']:
            entry['last_seen'] = date.date().isoformat()

    def results(self) -> dict[str, dict]:
        """Return aliases with score >= MIN_SCORE, serializable."""
        out = {}
        for alias, data in self._data.items():
            score = data['raw_score']
            if score >= MIN_SCORE:
                out[alias] = {
                    'targets': sorted(data['targets']),
                    'score': round(score, 2),
                    'count': data['count'],
                    'last_seen': data['last_seen'],
                    'source': 'session-mined',
                }
        return dict(sorted(out.items(), key=lambda x: -x[1]['score']))


# ── Merge with existing learned vocabulary ────────────────────────────────────

def merge_learned(existing: dict, new: dict) -> dict:
    """
    Merge new mined aliases into existing learned vocabulary.
    New entries add to score; existing entries are updated.
    Code-derived entries (source != 'session-mined') are never overwritten.
    """
    merged = dict(existing)
    for alias, data in new.items():
        if alias in merged:
            existing_entry = merged[alias]
            # Don't overwrite code-derived entries
            if existing_entry.get('source') != 'session-mined':
                continue
            # Merge scores and targets
            existing_entry['score'] = round(
                existing_entry.get('score', 0) + data['score'], 2
            )
            existing_entry['count'] = existing_entry.get('count', 0) + data['count']
            existing_entry['targets'] = sorted(
                set(existing_entry.get('targets', [])) | set(data['targets'])
            )
            if data['last_seen'] > existing_entry.get('last_seen', ''):
                existing_entry['last_seen'] = data['last_seen']
        else:
            merged[alias] = data
    return merged


def decay_old_entries(vocab: dict) -> dict:
    """Remove entries not seen in > 90 sessions / score below 1.0."""
    cutoff = (datetime.now() - timedelta(days=90)).date().isoformat()
    return {
        alias: data
        for alias, data in vocab.items()
        if data.get('source') != 'session-mined'
        or (data.get('last_seen', '0000-00-00') >= cutoff and data.get('score', 0) >= 1.0)
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Mine Claude Code sessions for vocabulary aliases')
    parser.add_argument('--project-root', type=Path, default=None)
    parser.add_argument('--dry-run', action='store_true', help='Print results without saving')
    parser.add_argument('--verbose', '-v', action='store_true', help='Show per-file details')
    args = parser.parse_args()

    global PROJECT_ROOT
    if args.project_root:
        PROJECT_ROOT = args.project_root.resolve()

    print(f"[mine-sessions] Project root: {PROJECT_ROOT}")

    # Find session files
    session_files = find_session_files(PROJECT_ROOT)
    if not session_files:
        print("[mine-sessions] No session files found in ~/.claude/projects/")
        print(f"  Looked for: ~/.claude/projects/*{PROJECT_ROOT.name.lower()}*/*.jsonl")
        print("  Sessions accumulate as you use Claude Code in this repo.")

        # Still update learned-vocabulary.json to ensure it exists and is valid
        if not LEARNED_VOC.exists():
            LEARNED_VOC.write_text('{}', encoding='utf-8')
            print("[mine-sessions] Created empty learned-vocabulary.json")
        sys.exit(0)

    print(f"[mine-sessions] Found {len(session_files)} session file(s)")

    # Mine
    miner = SessionMiner(PROJECT_ROOT, verbose=args.verbose)
    miner.mine(session_files)
    new_vocab = miner.results()

    print(f"[mine-sessions] Extracted {len(new_vocab)} alias(es) scoring >= {MIN_SCORE}")

    if args.verbose and new_vocab:
        print("\n  Top aliases:")
        for alias, data in list(new_vocab.items())[:10]:
            targets = ', '.join(data['targets'][:2])
            print(f"  {data['score']:5.1f}  {alias:<30}  → {targets}")
        print()

    if args.dry_run:
        print("[mine-sessions] Dry run — not saving")
        sys.exit(0)

    # Load existing, merge, decay, save
    existing: dict = {}
    if LEARNED_VOC.exists():
        try:
            existing = json.loads(LEARNED_VOC.read_text())
        except Exception:
            pass

    merged = merge_learned(existing, new_vocab)
    merged = decay_old_entries(merged)

    LEARNED_VOC.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f"[mine-sessions] ✓ Saved {len(merged)} total aliases to {LEARNED_VOC}")
    print(f"  (run 'python generate.py --force' to rebuild sections with updated vocabulary)")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Export Cursor agent transcripts (.jsonl) to Markdown.

Transcripts live under:
  %USERPROFILE%\\.cursor\\projects\\<project-slug>\\agent-transcripts\\<uuid>\\<uuid>.jsonl

Thinking / chain-of-thought:
  In JSONL on disk, Cursor usually replaces private reasoning with ``[REDACTED]`` inside the same
  ``type: "text"`` string as the visible preamble — there is often no separate JSON field.
  This script strips ``[REDACTED]`` and, when ``--keep-thinking`` is not set, drops content
  blocks whose ``type`` looks like thinking (e.g. ``thinking``, ``reasoning``) and removes
  common ``<thinking>...</thinking>``-style wrappers from assistant text.

Examples:
  python scripts/export_agent_transcript.py --search "6.4500" -o chat-transcript.md
  python scripts/export_agent_transcript.py --all-cursor-projects --search "chat app"
  python scripts/export_agent_transcript.py --project-slug c-Users-...-6-4500-chat-app --list
  python scripts/export_agent_transcript.py --uuid 3b5f36a0-f582-475a-a016-19f948d24f66
  python scripts/export_agent_transcript.py --file "C:/Users/.../agent-transcripts/<uuid>/<uuid>.jsonl"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator


def default_transcripts_root(project_slug: str | None = None) -> Path:
    home = Path.home()
    if project_slug:
        return home / ".cursor" / "projects" / project_slug / "agent-transcripts"
    # Cursor folder names are hashed paths (e.g. c-Users-...-6-4500-chat-app), not repo dirname.
    cwd = Path.cwd().resolve()
    slug = cwd.name.lower().replace(" ", "-")
    return home / ".cursor" / "projects" / slug / "agent-transcripts"


def all_cursor_transcript_roots() -> list[Path]:
    base = Path.home() / ".cursor" / "projects"
    if not base.is_dir():
        return []
    roots: list[Path] = []
    for child in sorted(base.iterdir()):
        at = child / "agent-transcripts"
        if at.is_dir():
            roots.append(at)
    return roots


def iter_transcript_jsonl_files(root: Path) -> Iterator[Path]:
    if not root.is_dir():
        return
    for p in sorted(root.rglob("*.jsonl")):
        if p.is_file():
            yield p


@dataclass(frozen=True)
class TranscriptHit:
    path: Path
    uuid: str
    preview: str

    @staticmethod
    def from_path(path: Path, preview_chars: int = 120) -> TranscriptHit:
        folder = path.parent.name
        preview = ""
        try:
            first = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
            data = json.loads(first)
            preview = _flatten_user_text(data)[:preview_chars]
        except (OSError, json.JSONDecodeError, IndexError):
            preview = ""
        return TranscriptHit(path=path, uuid=folder, preview=preview.replace("\n", " "))


def transcript_raw_snippet(path: Path, max_bytes: int = 400_000) -> str:
    """First chunk of file for substring search (paths and tool args often mention the project)."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            return f.read(max_bytes)
    except OSError:
        return ""


def hit_matches_search(hit: TranscriptHit, needle: str) -> bool:
    n = needle.lower()
    if n in hit.preview.lower() or n in hit.path.as_posix().lower():
        return True
    return n in transcript_raw_snippet(hit.path).lower()


def _flatten_user_text(entry: dict[str, Any]) -> str:
    if entry.get("role") != "user":
        return ""
    msg = entry.get("message") or {}
    parts: list[str] = []
    for block in msg.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "".join(parts)


def _strip_user_query_tags(text: str) -> str:
    text = text.strip()
    m = re.match(r"<user_query>\s*(.*?)\s*</user_query>\s*$", text, re.DOTALL)
    return m.group(1).strip() if m else text


_REDACTED = re.compile(r"\[REDACTED\]", re.IGNORECASE)

# If Cursor or a model API ever emits dedicated blocks, skip them when stripping thinking.
_THINKING_BLOCK_TYPES = frozenset(
    {
        "thinking",
        "reasoning",
        "chain_of_thought",
        "cot",
        "internal_thinking",
        "redacted_thinking",
    }
)

# Assistant-only: strip tagged segments sometimes used for scratch work (multiline).
_THINKING_TAG_PATTERNS = tuple(
    (
        re.compile(pat, re.IGNORECASE | re.DOTALL)
        for pat in (
            r"<thinking\b[^>]*>.*?</thinking>",
            r"<scratchpad\b[^>]*>.*?</scratchpad>",
            r"<reasoning\b[^>]*>.*?</reasoning>",
            r"<internal(?:_|-)?monologue\b[^>]*>.*?</internal(?:_|-)?monologue>",
        )
    )
)


def strip_redacted(text: str) -> str:
    """Remove Cursor placeholder segments and tidy blank runs left behind."""
    t = _REDACTED.sub("", text)
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def strip_tagged_thinking(text: str) -> str:
    t = text
    for pat in _THINKING_TAG_PATTERNS:
        t = pat.sub("", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _thinking_type(block: dict[str, Any]) -> str | None:
    t = block.get("type")
    if not isinstance(t, str):
        return None
    return t.lower().replace(" ", "_").replace("-", "_")


def format_content_block(
    block: dict[str, Any],
    *,
    include_tools: bool,
    strip_thinking: bool,
    message_role: str,
) -> str:
    btype = block.get("type")
    if strip_thinking:
        tt = _thinking_type(block)
        if tt and tt in _THINKING_BLOCK_TYPES:
            return ""

    if btype == "text":
        s = strip_redacted(str(block.get("text", "")))
        if strip_thinking and message_role == "assistant":
            s = strip_tagged_thinking(s)
        return s
    if btype == "tool_use" and include_tools:
        name = block.get("name", "?")
        inp = block.get("input")
        try:
            body = json.dumps(inp, indent=2, ensure_ascii=False) if inp is not None else ""
        except (TypeError, ValueError):
            body = repr(inp)
        return f"**Tool: `{name}`**\n\n```json\n{body}\n```"
    if btype == "tool_result" and include_tools:
        return f"**Tool result**\n\n```\n{block.get('content', '')}\n```"
    return ""


def line_to_markdown(
    line: str,
    *,
    role: str,
    include_tools: bool,
    strip_thinking: bool,
) -> str | None:
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return None

    r = entry.get("role", role)
    msg = entry.get("message") or {}
    content = msg.get("content") or []

    chunks: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                s = format_content_block(
                    block,
                    include_tools=include_tools,
                    strip_thinking=strip_thinking,
                    message_role=r,
                )
                if s:
                    chunks.append(s)
    elif isinstance(content, str):
        s = strip_redacted(content.strip())
        if strip_thinking and r == "assistant":
            s = strip_tagged_thinking(s)
        if s:
            chunks.append(s)

    body = "\n\n".join(chunks)
    if r == "user":
        body = _strip_user_query_tags(body)
    body = strip_redacted(body)
    if strip_thinking and r == "assistant":
        body = strip_tagged_thinking(body)

    label = "User" if r == "user" else "Assistant"
    if not body:
        return None
    return f"### {label}\n\n{body}\n"


def jsonl_to_markdown(
    lines: Iterable[str],
    *,
    title: str | None,
    include_tools: bool,
    strip_thinking: bool,
) -> str:
    sections: list[str] = []
    for line in lines:
        if not line.strip():
            continue
        md = line_to_markdown(
            line,
            role="unknown",
            include_tools=include_tools,
            strip_thinking=strip_thinking,
        )
        if md:
            sections.append(md.rstrip("\n"))

    head = f"# {title}\n\n" if title else ""
    if not sections:
        return head.rstrip() + ("\n" if head else "")
    body = "\n\n---\n\n".join(sections)
    return f"{head}{body}\n"


def collect_hits(roots: Iterable[Path]) -> list[TranscriptHit]:
    out: list[TranscriptHit] = []
    for root in roots:
        for p in iter_transcript_jsonl_files(root):
            out.append(TranscriptHit.from_path(p))
    return out


def pick_transcript(
    roots: list[Path],
    *,
    uuid: str | None,
    search: str | None,
    path: Path | None,
) -> Path:
    if path is not None:
        if not path.is_file():
            sys.exit(f"File not found: {path}")
        return path

    hits = collect_hits(roots)
    if not hits:
        roots_s = ", ".join(str(r) for r in roots) or "(none)"
        sys.exit(f"No .jsonl transcripts under: {roots_s}")

    if uuid:
        u = uuid.lower().replace("-", "")
        for h in hits:
            if h.uuid.lower().replace("-", "") == u or h.uuid.lower().startswith(uuid.lower()):
                return h.path
        sys.exit(f"No transcript matching uuid: {uuid}")

    if search:
        matched = [h for h in hits if hit_matches_search(h, search)]
        if len(matched) == 1:
            return matched[0].path
        if not matched:
            sys.exit(f"No transcript containing search string: {search!r}")
        sys.exit(
            "Multiple transcripts match; narrow with --uuid:\n"
            + "\n".join(f"  {h.uuid}\n    {h.preview[:100]}..." for h in matched)
        )

    if len(hits) == 1:
        return hits[0].path

    sys.exit(
        "Multiple transcripts found; use --search, --uuid, or --file:\n"
        + "\n".join(f"  {h.uuid}  {h.preview[:80]}..." for h in hits)
    )


def cmd_list(roots: list[Path]) -> None:
    hits = collect_hits(roots)
    if not hits:
        print(f"No transcripts under {roots}", file=sys.stderr)
        return
    for h in hits:
        print(f"{h.uuid}\t{h.path}")
        if h.preview:
            print(f"  {h.preview[:200]}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--root",
        type=Path,
        default=None,
        action="append",
        help="agent-transcripts directory (repeatable). Default: inferred folder, or all projects with --all-cursor-projects",
    )
    p.add_argument(
        "--project-slug",
        default=None,
        help="Cursor project folder name under ~/.cursor/projects/.../agent-transcripts",
    )
    p.add_argument(
        "--all-cursor-projects",
        action="store_true",
        help="Search ~/.cursor/projects/*/agent-transcripts (use with --search when slug is unknown)",
    )
    p.add_argument("--uuid", default=None, help="Transcript folder / session UUID")
    p.add_argument("--search", default=None, help="Substring to match first user message or path")
    p.add_argument("--file", type=Path, default=None, help="Explicit path to a .jsonl file")
    p.add_argument("-o", "--output", type=Path, default=None, help="Write markdown here (default: stdout)")
    p.add_argument("--title", default=None, help="Markdown H1 title (default: transcript UUID)")
    p.add_argument("--no-tools", action="store_true", help="Omit tool_use / tool_result blocks")
    p.add_argument(
        "--keep-thinking",
        action="store_true",
        help="Do not strip thinking-like content blocks or <thinking>...</thinking> segments",
    )
    p.add_argument("--list", action="store_true", help="List transcripts under --root and exit")
    args = p.parse_args(argv)

    if args.all_cursor_projects:
        roots = all_cursor_transcript_roots()
    elif args.root:
        roots = list(args.root)
    else:
        roots = [default_transcripts_root(args.project_slug)]

    if args.list:
        cmd_list(roots)
        return 0

    # Cursor project slug usually != repo folder; if inferred root is empty, search all projects.
    if not args.all_cursor_projects and not args.root and not args.file:
        inferred = roots[0]
        if not any(iter_transcript_jsonl_files(inferred)):
            roots = all_cursor_transcript_roots()

    transcript_path = pick_transcript(
        roots,
        uuid=args.uuid,
        search=args.search,
        path=args.file,
    )
    title = args.title or transcript_path.parent.name
    text = transcript_path.read_text(encoding="utf-8", errors="replace")
    md = jsonl_to_markdown(
        text.splitlines(),
        title=title,
        include_tools=not args.no_tools,
        strip_thinking=not args.keep_thinking,
    )

    if args.output:
        args.output.write_text(md, encoding="utf-8")
        print(f"Wrote {args.output}", file=sys.stderr)
    else:
        print(md, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

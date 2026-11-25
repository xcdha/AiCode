#!/usr/bin/env python3
"""Package the reviewed Guru-compatible plugin sources into individual ZIPs."""

from __future__ import annotations

import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1] / "plugin-adaptation"
OUTPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("dist/guru-plugins")
ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$")
PUBLISHER_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
LOCAL_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ROOT_KEYS = {
    "$schema", "manifestVersion", "id", "name", "version", "publisher", "repository",
    "description", "license", "engines", "runtime", "contributes", "configPage", "icon",
}
CONTRIBUTION_KEYS = {
    "skills", "agents", "workspaceTools", "uiEntries", "tools", "hooks", "mcp", "providers",
    "executionBackends", "workflows", "sessions", "shizuku", "overlay", "backup", "modelAccess", "configPage",
}
UI_SLOTS = {
    "settings.general", "settings.ai", "settings.environment", "settings.permissions", "settings.data",
    "settings.help", "drawer.footer", "chat.header.menu", "chat.welcome", "chat.session.menu",
    "files.tree.menu", "editor.selection.menu", "backup.data",
}
HOOK_EVENTS = {
    "app.started", "agent.run.started", "agent.run.finished", "agent.request.started", "agent.request.finished",
    "agent.tool.started", "agent.tool.finished", "agent.compaction", "agent.tool.before", "agent.tool.after",
    "agent.http.before", "agent.permission.review", "plugin.installed", "plugin.uninstalled",
    "plugin.enabled", "plugin.disabled", "backup.export.before", "backup.import.finished",
}
DIRECT = (
    "community.dev-tools",
    "community.modef",
    "jinghan.env-deps",
    "liulei92.gpt-gateway",
    "raccoon.gateway",
)
MODIFIED = (
    "bigorange.github-mcp",
    "jinghan.subagents-pack",
    "jinghan.toolbox",
    "yishuwanfeng.pojia-gateway",
)


def safe_name(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or not name:
        raise ValueError(f"unsafe archive path: {name!r}")


def validate_manifest(manifest: dict, file_exists) -> None:
    unknown_root = set(manifest) - ROOT_KEYS
    if unknown_root:
        raise ValueError(f"unknown manifest fields: {sorted(unknown_root)}")
    missing_root = ROOT_KEYS.intersection({"manifestVersion", "id", "name", "version", "publisher", "repository", "description", "license", "engines", "contributes"}) - set(manifest)
    if missing_root:
        raise ValueError(f"missing manifest fields: {sorted(missing_root)}")
    plugin_id = manifest.get("id", "")
    publisher = manifest.get("publisher", "")
    if not ID_RE.fullmatch(plugin_id):
        raise ValueError(f"invalid plugin id: {plugin_id!r}")
    if not PUBLISHER_RE.fullmatch(publisher) or plugin_id.partition(".")[0] != publisher:
        raise ValueError(f"invalid publisher for {plugin_id}: {publisher!r}")
    if manifest.get("manifestVersion") != 1:
        raise ValueError(f"unsupported manifestVersion: {plugin_id}")
    if (manifest.get("engines") or {}).get("pluginApi") != "^1.0.0":
        raise ValueError(f"unexpected pluginApi range: {plugin_id}")

    runtime = manifest.get("runtime") or {}
    if runtime.get("type") not in (None, "javascript", "python"):
        raise ValueError(f"unsupported runtime type for {plugin_id}: {runtime.get('type')}")
    if runtime.get("entry") and not file_exists(runtime["entry"]):
        raise ValueError(f"missing runtime entry for {plugin_id}: {runtime['entry']}")

    contributes = manifest.get("contributes") or {}
    unknown_contributions = set(contributes) - CONTRIBUTION_KEYS
    if unknown_contributions:
        raise ValueError(f"unknown contribution fields for {plugin_id}: {sorted(unknown_contributions)}")
    refs = [manifest.get("configPage"), contributes.get("configPage")]
    refs.extend(item.get("page") for item in contributes.get("uiEntries", []))
    refs.extend(item.get("pageFile") for item in contributes.get("workspaceTools", []))
    refs.extend(item.get("inputSchema") for item in contributes.get("tools", []))
    for key in ("skills", "agents", "mcp"):
        refs.extend(item.get("file") for item in contributes.get(key, []))
    for ref in filter(None, refs):
        safe_name(ref)
        if not file_exists(ref):
            raise ValueError(f"missing manifest file reference for {plugin_id}: {ref}")
    for tool in contributes.get("tools", []):
        if not LOCAL_ID_RE.fullmatch(tool.get("id", "")):
            raise ValueError(f"invalid tool id for {plugin_id}: {tool.get('id')!r}")
    for entry in contributes.get("uiEntries", []):
        if entry.get("slot") not in UI_SLOTS:
            raise ValueError(f"unsupported UI slot for {plugin_id}: {entry.get('slot')!r}")
        if bool(entry.get("page")) == bool(entry.get("handler")):
            raise ValueError(f"UI entry must declare exactly one page or handler: {plugin_id}/{entry.get('id')}")
    for hook in contributes.get("hooks", []):
        if hook.get("event") not in HOOK_EVENTS:
            raise ValueError(f"unsupported hook event for {plugin_id}: {hook.get('event')!r}")


def validate_zip(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        bad_crc = archive.testzip()
        if bad_crc:
            raise ValueError(f"bad CRC in {path}: {bad_crc}")
        names = set()
        for item in archive.infolist():
            safe_name(item.filename)
            if item.filename in names:
                raise ValueError(f"duplicate ZIP entry in {path}: {item.filename}")
            names.add(item.filename)
            if stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError(f"symlink in {path}: {item.filename}")
        raw = archive.read("plugin.json")
        manifest = json.loads(raw.decode("utf-8"))
        validate_manifest(manifest, lambda ref: ref in names)
        return manifest


def package_directory(source: Path, target: Path) -> None:
    manifest_path = source / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def file_exists(ref: str) -> bool:
        return (source / ref).is_file()

    validate_manifest(manifest, file_exists)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"symlink in source: {path}")
            if not path.is_file():
                continue
            relative = path.relative_to(source).as_posix()
            safe_name(relative)
            archive.write(path, relative)
    validate_zip(target)


def main() -> None:
    if not ROOT.is_dir():
        raise SystemExit(f"missing packaging source directory: {ROOT}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if any(OUTPUT.iterdir()):
        raise SystemExit(f"refusing to overwrite non-empty output directory: {OUTPUT}")

    for name in MODIFIED:
        source = ROOT / "modified" / name
        if not source.is_dir():
            raise SystemExit(f"missing adapted plugin source: {source}")
        manifest = json.loads((source / "plugin.json").read_text(encoding="utf-8"))
        target = OUTPUT / f"{manifest['id']}-guru-{manifest['version']}.zip"
        package_directory(source, target)
        print(f"PACKAGED {target.name}")

    for name in DIRECT:
        source = ROOT / "direct" / f"{name}.zip"
        if not source.is_file():
            raise SystemExit(f"missing unchanged plugin archive: {source}")
        manifest = validate_zip(source)
        target = OUTPUT / f"{manifest['id']}.zip"
        target.write_bytes(source.read_bytes())
        validate_zip(target)
        print(f"COPIED {target.name}")

    print(f"Verified {len(MODIFIED) + len(DIRECT)} Guru-compatible plugin archives in {OUTPUT}")


if __name__ == "__main__":
    main()

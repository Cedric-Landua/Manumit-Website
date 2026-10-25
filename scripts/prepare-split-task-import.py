#!/usr/bin/env python3
"""Create a D1 import SQL file from one account in the pre-edit CSV export."""

import argparse
import csv
import uuid
from datetime import datetime, timezone
from pathlib import Path


SETTINGS_COLUMNS = (
    "light_color", "dark_color", "color_palette", "is_dark_mode", "is_dim_mode",
    "theme_level", "week_calendar_days", "enable_animations", "confetti_enabled",
    "completion_sounds", "popup_overlay_enabled", "page_transitions_enabled",
    "smooth_dropdowns_enabled", "deletion_fade_enabled", "split_view_shift_enabled",
    "button_feedback_enabled", "split_task_page", "calendar_days", "week_start",
    "day_start", "day_end", "timeline_increment", "task_creation_increment",
    "future_recurrences", "use_military_time", "task_notifications",
    "event_notifications", "quick_add_only", "split_ratio", "delete_after_days",
    "task_deadline_push_enabled", "app_font", "updated_at",
)

ITEM_COLUMNS = (
    "id", "type", "title", "category_id", "item_date", "done", "finished_at",
    "notes", "deadline", "due_date", "start_time", "end_time", "location",
    "recurrence", "recurrence_id", "updated_at",
)


def read_csv(path):
    with path.open("r", newline="", encoding="utf-8-sig") as stream:
        return list(csv.DictReader(stream))


def sql_text(value):
    if value is None:
        return "NULL"
    encoded = str(value).encode("utf-8").hex()
    return f"CAST(X'{encoded}' AS TEXT)"


def insert(table, columns, values):
    names = ", ".join(f'"{column}"' for column in columns)
    literals = ", ".join(sql_text(value) for value in values)
    return f"INSERT INTO {table} ({names}) VALUES ({literals});"


def rows_for_user(rows, username):
    return [
        row for row in rows
        if (row.get("username") or "").strip().casefold() == username.casefold()
    ]


def require_one(rows, table, username):
    selected = rows_for_user(rows, username)
    if len(selected) != 1:
        raise ValueError(f"Expected exactly one {table} row for the selected account; found {len(selected)}.")
    return selected[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Folder containing the exported CSV files")
    parser.add_argument("--username", required=True, help="Exact account username to preserve")
    parser.add_argument("--output", required=True, type=Path, help="Destination SQL file (contains private account data)")
    parser.add_argument(
        "--wrapped-key-file",
        type=Path,
        help="Optional local file containing the WRAP1 secure-notes key from the old account/device",
    )
    parser.add_argument(
        "--note-metadata-file",
        type=Path,
        help="Optional CSV export with username,id,hidden,text_is_encrypted columns from the old D1",
    )
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_dir():
        parser.error(f"Source folder does not exist: {source}")
    if output.exists():
        parser.error(f"Refusing to overwrite existing file: {output}")

    users = read_csv(source / "users.csv")
    user = require_one(users, "users.csv", args.username)
    if not user.get("password_hash"):
        raise ValueError("Selected account is missing its existing credential hash.")
    username = user["username"].strip()
    wrapped_key = None
    if args.wrapped_key_file:
        wrapped_key = args.wrapped_key_file.read_text(encoding="utf-8").strip()
        if not wrapped_key.startswith("WRAP1."):
            raise ValueError("Wrapped secure-notes key must start with WRAP1.")
    note_metadata = {}
    if args.note_metadata_file:
        metadata_rows = rows_for_user(read_csv(args.note_metadata_file), username)
        for row in metadata_rows:
            note_id = str(row.get("id") or "")
            if not note_id or note_id in note_metadata:
                raise ValueError("Note metadata must contain unique, non-empty note IDs.")
            note_metadata[note_id] = row

    user_id = str(uuid.uuid4())
    identity_id = str(uuid.uuid4())
    normalized_username = username.casefold()
    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    statements = [
        insert(
            "users",
            ("id", "status", "created_at", "updated_at"),
            (user_id, "active", user.get("created_at") or imported_at, user.get("updated_at") or imported_at),
        ),
        insert(
            "user_identities",
            ("id", "user_id", "provider", "identifier", "normalized_identifier",
             "credential_hash", "credential_scheme", "created_at"),
            (identity_id, user_id, "username_password", username, normalized_username,
             user["password_hash"], "sha256-client-v1", user.get("created_at") or imported_at),
        ),
        insert("user_products", ("user_id", "product_key", "status"), (user_id, "split-task", "active")),
    ]

    settings_rows = rows_for_user(read_csv(source / "user_settings.csv"), username)
    if len(settings_rows) > 1:
        raise ValueError("Selected account has duplicate settings rows.")
    if settings_rows:
        row = settings_rows[0]
        values = [row.get(column) for column in SETTINGS_COLUMNS]
        statements.append(
            insert(
                "split_task_settings",
                ("user_id",) + SETTINGS_COLUMNS + ("secure_notes_wrapped_key",),
                (user_id,) + tuple(value if value != "" else None for value in values) + (wrapped_key,),
            )
        )
    else:
        statements.append(
            insert(
                "split_task_settings",
                ("user_id", "secure_notes_wrapped_key"),
                (user_id, wrapped_key),
            )
        )

    categories = rows_for_user(read_csv(source / "categories.csv"), username)
    for row in categories:
        statements.append(
            insert(
                "split_task_categories",
                ("id", "user_id", "name", "color", "updated_at"),
                (row["id"], user_id, row["name"], row["color"], row.get("updated_at") or imported_at),
            )
        )

    items = rows_for_user(read_csv(source / "items.csv"), username)
    for row in items:
        statements.append(
            insert(
                "split_task_items",
                ITEM_COLUMNS[:1] + ("user_id",) + ITEM_COLUMNS[1:],
                (row["id"], user_id) + tuple(
                    row.get(column) or (imported_at if column == "updated_at" else None)
                    for column in ITEM_COLUMNS[1:]
                ),
            )
        )

    notes = rows_for_user(read_csv(source / "notes.csv"), username)
    for row in notes:
        metadata = note_metadata.get(str(row["id"]), {})
        if args.note_metadata_file and not metadata:
            raise ValueError(f"Note metadata is missing note ID {row['id']!r}.")
        encrypted = 1 if (
            (row.get("text") or "").startswith("ENC1.")
            or metadata.get("text_is_encrypted") in ("1", "true", "TRUE")
        ) else 0
        hidden = 1 if metadata.get("hidden") in ("1", "true", "TRUE") else 0
        statements.append(
            insert(
                "split_task_notes",
                ("id", "user_id", "text", "category_id", "created_at", "updated_at",
                 "hidden", "text_is_encrypted"),
                (row["id"], user_id, row.get("text") or "", row.get("category_id") or None,
                 row.get("created_at") or imported_at, row.get("updated_at") or imported_at,
                 hidden, encrypted),
            )
        )

    versions = rows_for_user(read_csv(source / "user_versions.csv"), username)
    if len(versions) > 1:
        raise ValueError("Selected account has duplicate sync-version rows.")
    version = versions[0].get("version", "0") if versions else "0"
    statements.append(insert("split_task_sync_versions", ("user_id", "version"), (user_id, version)))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(statements) + "\n", encoding="ascii")
    encrypted_count = sum(1 for row in notes if (row.get("text") or "").startswith("ENC1."))
    print(f"Prepared one-account import: {len(categories)} categories, {len(items)} items, "
          f"{len(notes)} notes ({encrypted_count} encrypted).")
    print("The SQL file contains private account data and its legacy credential hash; keep it private.")
    print(f"Output: {output}")
    if encrypted_count and not wrapped_key:
        print("The CSV export omits the wrapped secure-notes key; recover/sync that key before retiring the old database.")
    if notes and not args.note_metadata_file:
        print("The CSV export omits hidden-note flags; the import defaults those flags to visible.")


if __name__ == "__main__":
    main()

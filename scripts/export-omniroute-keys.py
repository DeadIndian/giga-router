#!/usr/bin/env python3
"""Read only OmniRoute API-key accounts into a private import file. No sessions."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(errors='backslashreplace')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, default=Path.home() / '.omniroute/storage.sqlite')
    parser.add_argument('--output', type=Path, help='New file outside this repository (required unless --list)')
    parser.add_argument('--list', action='store_true', help='List API-key providers and account names without exporting secrets')
    args = parser.parse_args()
    if not args.list and not args.output:
        parser.error('--output is required unless --list is used')
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as database:
        database.row_factory = sqlite3.Row
        rows = database.execute("SELECT provider, name, api_key, default_model FROM provider_connections WHERE auth_type='apikey' AND api_key IS NOT NULL AND api_key != ''").fetchall()
    accounts = [{'catalogId': row['provider'], 'accountLabel': row['name'] or 'Imported', 'apiKey': row['api_key'], **({'defaultModel': row['default_model']} if row['default_model'] else {})} for row in rows]
    if args.list:
        for account in accounts:
            print(f"{account['catalogId']}: {account['accountLabel']}")
        print(f'{len(accounts)} API-key accounts. Browser/OAuth sessions excluded.')
        return
    output = args.output.expanduser().resolve()
    repository = Path(__file__).resolve().parent.parent
    if output.is_relative_to(repository):
        parser.error('Save exports outside the repository; they contain API keys.')
    # Exclusive creation prevents accidentally overwriting another file or symlink.
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump({'version': 1, 'source': 'giga-router-apikeys', 'accounts': accounts}, stream, indent=2)
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    print(f'Exported {len(accounts)} API-key accounts to {output} (mode 0600). Import in Providers & routing > Free APIs, then delete the export.')


if __name__ == '__main__':
    main()

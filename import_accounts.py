#!/usr/bin/env python3
"""将本地 accounts.json 导入 CF Worker 的 D1 数据库。

用法:
    python import_accounts.py --url https://atxp2.your-subdomain.workers.dev \
                               --admin-key YOUR_ADMIN_KEY \
                               --file ../data/accounts.json
"""
import argparse
import json
import sys
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True, help='Worker URL, e.g. https://atxp2.xxx.workers.dev')
    parser.add_argument('--admin-key', default='', help='ADMIN_KEY secret')
    parser.add_argument('--file', default='../data/accounts.json', help='accounts JSON file')
    args = parser.parse_args()

    with open(args.file, encoding='utf-8') as f:
        accounts = json.load(f)

    # Normalize: only keep email + refresh_token
    payload = [
        {'email': a['email'], 'refresh_token': a['refresh_token']}
        for a in accounts
        if a.get('email') and a.get('refresh_token')
    ]
    if not payload:
        print('No valid accounts found in file.')
        sys.exit(1)

    url = args.url.rstrip('/') + '/admin/import'
    data = json.dumps(payload).encode()
    headers = {'Content-Type': 'application/json'}
    if args.admin_key:
        headers['Authorization'] = f'Bearer {args.admin_key}'

    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            print(f'OK: imported {result.get("imported")} accounts')
    except urllib.error.HTTPError as e:
        print(f'Error {e.code}: {e.read().decode()[:200]}')
        sys.exit(1)


if __name__ == '__main__':
    main()

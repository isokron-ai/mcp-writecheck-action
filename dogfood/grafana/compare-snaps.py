#!/usr/bin/env python3
"""Fails when an object the tester did not create changed between two snapshots (snap.py).
Objects carrying the run prefix that are still there afterwards are reported, not failed: Grafana
itself writes alert-state annotations for the rules the tester created.
usage: compare-snaps.py <before.json> <after.json>"""
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
bad = False
for k in sorted(set(a) | set(b)):
    x, y = a.get(k, {}), b.get(k, {})
    if (x.get('not_the_testers'), x.get('sha256')) != (y.get('not_the_testers'), y.get('sha256')):
        print(f'::error::{k}: objects the tester did not create changed during the run')
        bad = True
    else:
        print(f'{k}: objects the tester did not create unchanged')
    if y.get('testers_left'):
        print(f'::notice::{k}: objects carrying the run prefix are still in Grafana afterwards (alert-state annotations are written by Grafana itself)')
sys.exit(1 if bad else 0)

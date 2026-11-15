#!/usr/bin/env python3
"""Counts and checksums what the tester did not create in the disposable Grafana, as the admin
(password from the file named by GRAFANA_ADMIN_PW_FILE, never printed). An object is the tester's
when it carries the run prefix mwsc-<run>-.
usage: snap.py <grafana url>"""
import base64, hashlib, json, os, re, sys, urllib.request

G = sys.argv[1]
pw = open(os.environ['GRAFANA_ADMIN_PW_FILE']).read().strip()
H = {'authorization': 'Basic ' + base64.b64encode(f'admin:{pw}'.encode()).decode()}

def get(p):
    try:
        with urllib.request.urlopen(urllib.request.Request(G + p, headers=H)) as r:
            return json.load(r)
    except Exception as e:  # recorded in the snapshot, so a failing read shows as a difference
        return {'error': str(e)}

mine = lambda o: re.search(r'mwsc-[0-9a-f]{10}-', json.dumps(o)) is not None
sha = lambda o: hashlib.sha256(json.dumps(o, sort_keys=True).encode()).hexdigest()
out = {}
dash = []
for s in sorted(get('/api/search?limit=5000'), key=lambda s: s['uid']):
    if s['type'] == 'dash-db':
        d = get('/api/dashboards/uid/' + s['uid'])
        dash.append({'uid': s['uid'], 'dashboard': d.get('dashboard'), 'folderUid': (d.get('meta') or {}).get('folderUid'), 'version': (d.get('meta') or {}).get('version')})
    else:
        dash.append({'uid': s['uid'], 'type': s['type'], 'title': s['title']})
ann = sorted(get('/api/annotations?limit=5000'), key=lambda a: a['id'])
rules = get('/api/v1/provisioning/alert-rules')
cps = get('/api/v1/provisioning/contact-points')
for name, items in [('folders_and_dashboards', dash), ('annotations', ann),
                    ('alert_rules', rules if isinstance(rules, list) else [rules]),
                    ('contact_points', cps if isinstance(cps, list) else [cps])]:
    others = [i for i in items if not mine(i)]
    out[name] = {'not_the_testers': len(others), 'sha256': sha(others), 'testers_left': len(items) - len(others)}
print(json.dumps(out, indent=1, sort_keys=True))

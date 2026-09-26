"""Offline subprocess smoke tests for the real-run reporting script."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RealRunTests(unittest.TestCase):
    def test_completed_round_usage_summary_includes_retries_without_summing_totals(self):
        for stats, expected in [([
            'model round=1 requests=1 http=3 retries=2 total_http=3 requeued=1',
            'model round=2 requests=1 http=2 retries=1 total_http=5 requeued=2'],
            'requests=2 http=5 retries=3 requeued=3'),
            (['model round=1 requests=2'], 'requests=2 http=unknown retries=unknown requeued=unknown')]:
            with self.subTest(stats=stats), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root/'back').mkdir()
                source_stat = 'sources round=1 ok=11 not_modified=1 failed=1 timeout=0 http_4xx=0 http_5xx=1 parse=0 other=0 slow=1 streaks=自由時報即時:3'
                (root/'back/news.py').write_text('''import json, sys
for line in sys.stdin:
    packet=json.loads(line)
    if packet['t']=='hello': print(json.dumps({'t':'ready','seq':packet['seq']}),flush=True)
    elif packet['t']=='up':
        for stat in STATS: print(stat,file=sys.stderr,flush=True)
        print(json.dumps({'t':'msg','body':{'op':'list','items':[],'sources':[],
            'model':{'state':'done'},'topics':{'list':[]}}}),flush=True)
    elif packet['t']=='bye': break
'''.replace('STATS', repr([source_stat, *stats])))
                result = subprocess.run([sys.executable, 'scripts/real_run.py', '--root', directory,
                                         '--timeout', '3'], capture_output=True, text=True, timeout=6,
                                        env={k:v for k,v in os.environ.items() if k!='TYPESAFE_API_KEY'})
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn('result=done exit=0',result.stdout)
                self.assertEqual(result.stdout.count(source_stat),1)
                self.assertIn('model_usage (completed rounds): '+expected,result.stdout)
